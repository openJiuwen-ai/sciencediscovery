// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { RefStore, snapshotWorkspace, type AgentStateRef, type VersionStore } from "./versioning.js";
import { withWorkspaceAdmission } from "./workspace-lifecycle.js";

const owned = new AsyncLocalStorage<Map<string, { active: boolean }>>();
export const workspaceHeadName = (root: string) => `workspaces/${createHash("sha256").update(root).digest("hex")}/head`;
async function coordinationPath(root: string) {
  const canonical = await realpath(root);
  const locks = join(dirname(canonical), ".workspace-coordination");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  return { canonical, path: join(locks, createHash("sha256").update(canonical).digest("hex")) };
}
const poisoned = new Set<string>();
export async function poisonWorkspace(root: string): Promise<void> {
  const { canonical, path } = await coordinationPath(root);
  poisoned.add(canonical);
  await writeFile(`${path}.failed`, "Workspace version commit failed; repair storage before resuming writes", { mode: 0o600 });
}

/** Shared by API and Runner processes. SQLite releases the OS lock on process exit;
 * no mtime expiry can steal a live writer's lease. The file is outside the sandbox. */
export async function withWorkspaceLease<T>(root: string, operation: () => Promise<T>, signal?: AbortSignal,
  onBusy?: () => Promise<T>): Promise<T> {
  const { canonical, path } = await coordinationPath(root);
  if (owned.getStore()?.get(canonical)?.active) return operation();
  const db = new DatabaseSync(`${path}.sqlite`);
  let acquired = false;
  let marked = false;
  const token = { active: true };
  try {
    db.exec("PRAGMA busy_timeout=0");
    while (!acquired) {
      signal?.throwIfAborted();
      try { db.exec("BEGIN IMMEDIATE"); acquired = true; }
      catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if (code !== 5 && code !== 6) throw error; // SQLITE_BUSY / SQLITE_LOCKED
        if (onBusy) return await onBusy();
        await delay(20, undefined, { signal });
      }
    }
    signal?.throwIfAborted();
    if (poisoned.has(canonical)) throw new Error("Workspace version commit failed; repair storage before resuming writes");
    try {
      await realpath(`${path}.failed`);
      throw new Error("Workspace version commit failed; repair storage before resuming writes");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await writeFile(`${path}.active`, "Unfinished Workspace operation; verify processes and recover before resuming", { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Workspace has an interrupted operation; recover before resuming writes");
      throw error;
    }
    marked = true;
    return await owned.run(new Map([...(owned.getStore() ?? []), [canonical, token]]), operation);
  } finally {
    token.active = false;
    try { if (marked) await rm(`${path}.active`); }
    finally { try { if (acquired) db.exec("ROLLBACK"); } finally { db.close(); } }
  }
}

/** Must be called under admission, before changing any file. Observers can then
 * use this rooted tree while the writer runs without taking its write lease. */
export async function ensureWorkspaceBaseline(versions: VersionStore, root: string): Promise<void> {
  const refs = await RefStore.open(versions);
  try {
    const name = workspaceHeadName(await realpath(root));
    if (refs.head(name)) return;
    const workspace = await snapshotWorkspace(versions, root);
    const version = await versions.putRecord("WorkspaceMutation", { kind: "baseline", workspace, status: "completed" });
    await refs.commit(versions, name, null, version);
  } catch (error) { await poisonWorkspace(root).catch(() => undefined); throw error; }
  finally { refs.close(); }
}

/** Read a committed tree without waiting behind a long-running writer. Idle
 * workspaces can ingest user edits under admission; busy ones never get hashed. */
export async function committedWorkspaceSnapshot(versions: VersionStore, root: string): Promise<AgentStateRef> {
  const canonical = await realpath(root);
  const previous = async () => {
    const refs = await RefStore.open(versions);
    try {
      const head = refs.head(workspaceHeadName(canonical));
      if (!head) throw new Error("Workspace has no committed baseline yet; retry after admission completes");
      const record = await versions.readRecord<{ workspace: AgentStateRef }>(head);
      if (!["WorkspaceMutation", "WorkspaceExecution"].includes(record.kind)) throw new Error("Invalid Workspace head kind");
      await versions.readRecord(record.value.workspace, "WorkspaceTree");
      return record.value.workspace;
    } finally { refs.close(); }
  };
  // A nested observer must not snapshot its caller's unfinished mutation.
  if (owned.getStore()?.get(canonical)?.active) return previous();
  return withWorkspaceAdmission(versions, canonical, () => withWorkspaceLease(canonical, async () => {
    const workspace = await snapshotWorkspace(versions, canonical);
    const refs = await RefStore.open(versions);
    try {
      const name = workspaceHeadName(canonical);
      const head = refs.head(name);
      if (head) {
        const record = await versions.readRecord<{ workspace: AgentStateRef }>(head);
        if (record.value.workspace?.digest === workspace.digest) return workspace;
      }
      const version = await versions.putRecord("WorkspaceMutation", { kind: "checkpoint", workspace, status: "completed" });
      await refs.commit(versions, name, head, version);
    } finally { refs.close(); }
    return workspace;
  }, undefined, previous), undefined, previous);
}

/** Acquire both sides of a local copy in canonical order; opposite-direction
 * copies must never each hold one root while waiting for the other. */
export async function withWorkspaceLeases<T>(roots: string[], operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const ordered = [...new Set(await Promise.all(roots.map((root) => realpath(root))))].sort();
  const enter = (index: number): Promise<T> => index === ordered.length ? operation()
    : withWorkspaceLease(ordered[index]!, () => enter(index + 1), signal);
  return enter(0);
}

/** Failed/cancelled operations still have real file effects. Commit those effects
 * before admitting the next writer, without masking the original operation error. */
export async function withWorkspaceMutation<T>(versions: VersionStore, root: string, operation: () => Promise<T>,
  metadata: { kind: string; id?: string; onCommitted?: (workspace: AgentStateRef) => void }, signal?: AbortSignal): Promise<T> {
  return withWorkspaceAdmission(versions, root, () => withWorkspaceLease(root, async () => {
    await ensureWorkspaceBaseline(versions, root);
    let value: T | undefined;
    let failure: unknown;
    let failed = false;
    try { value = await operation(); } catch (error) { failed = true; failure = error; }
    try {
      const workspace = await snapshotWorkspace(versions, root);
      const version = await versions.putRecord("WorkspaceMutation", {
        id: metadata.id ?? randomUUID(), kind: metadata.kind, workspace, status: failed ? "failed" : "completed",
      });
      const refs = await RefStore.open(versions);
      try {
        const name = workspaceHeadName(await realpath(root));
        await refs.commit(versions, name, refs.head(name), version);
      } finally { refs.close(); }
      metadata.onCommitted?.(workspace);
    } catch (error) { await poisonWorkspace(root).catch(() => undefined); throw error; }
    if (failed) throw failure;
    return value as T;
  }, signal), signal);
}

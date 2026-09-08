// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { VersionStore } from "./versioning.js";

const held = new AsyncLocalStorage<Map<string, { active: boolean }>>();
const within = (path: string, scope: string) => path === scope || path.startsWith(`${scope}${sep}`);

/** Resolve existing ancestors too: admission also guards first-time creation. */
export async function canonicalWorkspacePath(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(absolute) === absolute) throw error;
    return join(await canonicalWorkspacePath(dirname(absolute)), basename(absolute));
  }
}

async function registry(versions: VersionStore) {
  await mkdir(versions.dataDir, { recursive: true, mode: 0o700 });
  const directory = join(await realpath(versions.dataDir), ".workspace-lifecycle");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, "registry.sqlite"));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS roots (path TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS fences (scope TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending');`);
  return { db, directory };
}

function assertOpen(db: DatabaseSync, path: string) {
  if (db.prepare("SELECT scope FROM fences").all().some((row) => within(path, String(row.scope)))) {
    throw Object.assign(new Error("Workspace is being deleted or has been deleted; no new writes are admitted"), { code: "WORKSPACE_RETIRED" });
  }
}

async function locked<T>(directory: string, key: string, action: () => Promise<T>, signal?: AbortSignal,
  onBusy?: () => Promise<T>): Promise<T> {
  const identity = join(directory, createHash("sha256").update(key).digest("hex"));
  if (held.getStore()?.get(identity)?.active) return action();
  const db = new DatabaseSync(`${identity}.sqlite`);
  const token = { active: true };
  let acquired = false;
  try {
    db.exec("PRAGMA busy_timeout=0");
    while (!acquired) {
      signal?.throwIfAborted();
      try { db.exec("BEGIN IMMEDIATE"); acquired = true; }
      catch (error) {
        if (![5, 6].includes((error as { errcode: number }).errcode)) throw error;
        if (onBusy) return await onBusy();
        await delay(20, undefined, { signal });
      }
    }
    signal?.throwIfAborted();
    return await held.run(new Map([...(held.getStore() ?? []), [identity, token]]), action);
  } finally {
    token.active = false;
    try { if (acquired) db.exec("ROLLBACK"); } finally { db.close(); }
  }
}

/** A stable outer lease survives moving/removing the directory and its old
 * coordination files. Different roots still execute concurrently. */
export async function withWorkspaceAdmission<T>(versions: VersionStore, root: string, action: () => Promise<T>,
  signal?: AbortSignal, onBusy?: () => Promise<T>): Promise<T> {
  const path = await canonicalWorkspacePath(root);
  const { db, directory } = await registry(versions);
  const identity = join(directory, createHash("sha256").update(path).digest("hex"));
  try {
    if (held.getStore()?.get(identity)?.active) return await action();
    db.exec("BEGIN IMMEDIATE");
    try {
      assertOpen(db, path);
      db.prepare("INSERT OR IGNORE INTO roots VALUES (?)").run(path);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return await locked(directory, path, async () => {
      // Deletion may have closed admission while this writer was queued.
      assertOpen(db, path);
      return action();
    }, signal, onBusy);
  } finally { db.close(); }
}

export async function withWorkspaceAdmissions<T>(versions: VersionStore, roots: string[], action: () => Promise<T>,
  signal?: AbortSignal): Promise<T> {
  const paths = [...new Set(await Promise.all(roots.map(canonicalWorkspacePath)))].sort();
  const enter = (index: number): Promise<T> => index === paths.length ? action()
    : withWorkspaceAdmission(versions, paths[index]!, () => enter(index + 1), signal);
  return enter(0);
}

/** The caller persists its recovery journal BEFORE entering, and calls reopen
 * only after restoration succeeds. A crash or failed recovery leaves a fence,
 * not permission to recreate an empty Workspace and replay old commands. */
export async function withWorkspaceRetirement<T>(versions: VersionStore, scopes: string[], owner: string,
  action: (roots: string[], reopen: () => void) => Promise<T>, discoverRoots?: () => Promise<string[]>): Promise<T> {
  const paths = [...new Set(await Promise.all(scopes.map(canonicalWorkspacePath)))].sort();
  const { db, directory } = await registry(versions);
  try {
    return await locked(directory, `retirement:${owner}`, async () => {
      db.exec("BEGIN IMMEDIATE");
      let roots: string[];
      try {
        const fences = db.prepare("SELECT scope, owner, state FROM fences").all();
        if (fences.some((row) => row.owner !== owner && row.state !== "retired"
          && paths.some((path) => within(path, String(row.scope)) || within(String(row.scope), path)))) {
          throw new Error("An overlapping Workspace deletion is already in progress");
        }
        for (const path of paths) db.prepare("INSERT OR IGNORE INTO fences (scope, owner) VALUES (?, ?)").run(path, owner);
        roots = db.prepare("SELECT path FROM roots ORDER BY path").all().map((row) => String(row.path))
          .filter((root) => paths.some((scope) => within(root, scope)));
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      // Older idle Workspaces may predate the admission registry. Discovery is
      // safe after closing the subtree; in-flight creation is already registered.
      if (discoverRoots) {
        const discovered = await Promise.all((await discoverRoots()).map(canonicalWorkspacePath));
        if (discovered.some((root) => !paths.some((scope) => within(root, scope)))) throw new Error("Workspace discovery escaped deletion scopes");
        roots = [...new Set([...roots, ...discovered])].sort();
      }
      let reopen = false;
      const enter = (index: number): Promise<T> => index === roots.length
        ? action(roots, () => { reopen = true; }) : locked(directory, roots[index]!, () => enter(index + 1));
      try {
        const result = await enter(0);
        if (!reopen) db.prepare("UPDATE fences SET state = 'retired' WHERE owner = ?").run(owner);
        return result;
      }
      finally { if (reopen) db.prepare("DELETE FROM fences WHERE owner = ?").run(owner); }
    });
  } finally { db.close(); }
}

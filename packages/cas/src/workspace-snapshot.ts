// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertRef, type AgentStateRef, type DataRef, type VersionStore, type WorkspaceTree } from "./versioning.js";
import { withWorkspaceMutation } from "./workspace-lease.js";

export interface SnapshotFile { path: string; content: DataRef; executable: number }

/** An immutable manifest, never a scan of the live Workspace. Symlinks are not
 * traversed; paths must be representable by the public UTF-8 path contract. */
export async function workspaceSnapshotFiles(store: VersionStore, tree: AgentStateRef, paths?: string[]): Promise<SnapshotFile[]> {
  if (paths?.some((path) => !path || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".."))) {
    throw new Error("Snapshot paths must be relative Workspace paths");
  }
  const files: SnapshotFile[] = [];
  const walk = async (ref: AgentStateRef, prefix: string): Promise<void> => {
    const record = await store.readRecord<WorkspaceTree>(ref, "WorkspaceTree");
    for (const entry of record.value.entries) {
      const bytes = Buffer.from(entry.name, "base64url");
      const name = bytes.toString("utf8");
      if (!bytes.equals(Buffer.from(name)) || !name || name.includes("/") || name.includes("\0") || name === "." || name === "..") {
        throw new Error("Snapshot filename cannot be represented by the Workspace path API");
      }
      const path = prefix ? `${prefix}/${name}` : name;
      if (paths?.length && !paths.some((selected) => path === selected || path.startsWith(`${selected}/`) || selected.startsWith(`${path}/`))) continue;
      if (entry.type === "directory") await walk(entry.tree, path);
      else if (entry.type === "file") { assertRef(entry.content, "data"); files.push({ path, content: entry.content, executable: entry.executable }); }
    }
  };
  await walk(tree, "");
  return files;
}

/** Verify the streamed bytes too: a corrupt store must never publish a target file. */
export async function* streamSnapshotFile(store: VersionStore, content: DataRef): AsyncGenerator<Buffer> {
  assertRef(content, "data");
  const hash = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(store.objectPath(content))) {
    const bytes = chunk as Buffer; size += bytes.length; hash.update(bytes); yield bytes;
  }
  if (size !== content.size || `sha256:${hash.digest("hex")}` !== content.digest) throw new Error("Snapshot file integrity failure");
}

/** Materialize into a new, private directory, never into an existing Workspace.
 * The caller may hand the directory to a consumer only after this resolves.
 * Preserve raw Linux names, empty directories and link targets without following
 * links or consulting the original live tree. No hardlinks to mutable files/CAS. */
export async function materializeWorkspaceSnapshot(store: VersionStore, tree: AgentStateRef, destination: string): Promise<void> {
  const root = resolve(destination);
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root, { mode: 0o700 }); // Exclusive: failure must not remove someone else's directory.
  try {
    await withWorkspaceMutation(store, root, async () => {
      const walk = async (ref: AgentStateRef, directory: Buffer): Promise<void> => {
        const record = await store.readRecord<WorkspaceTree>(ref, "WorkspaceTree");
        const names = new Set<string>();
        for (const entry of record.value.entries) {
          const name = Buffer.from(entry.name, "base64url");
          if (!name.length || name.includes(0) || name.includes(47) || name.equals(Buffer.from("."))
            || name.equals(Buffer.from("..")) || name.toString("base64url") !== entry.name || names.has(entry.name)) {
            throw new Error("Invalid snapshot filename");
          }
          names.add(entry.name);
          const path = Buffer.concat([directory, Buffer.from("/"), name]);
          if (entry.type === "directory") {
            await mkdir(path); await walk(entry.tree, path);
          } else if (entry.type === "file") {
            const file = await open(path, "wx", 0o600);
            try {
              for await (const bytes of streamSnapshotFile(store, entry.content)) await file.writeFile(bytes);
              await file.chmod(0o600 | (entry.executable & 0o111));
              await file.sync();
            } finally { await file.close(); }
          } else if (entry.type === "symlink") {
            await symlink(Buffer.from(entry.target, "base64url"), path);
          } else throw new Error("Invalid snapshot entry type");
        }
      };
      await walk(tree, Buffer.from(root));
    }, { kind: "snapshot-export", id: tree.digest });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

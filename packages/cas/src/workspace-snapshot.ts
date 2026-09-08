// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { assertRef, type AgentStateRef, type DataRef, type VersionStore, type WorkspaceTree } from "./versioning.js";

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

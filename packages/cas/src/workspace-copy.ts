// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rm, statfs } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { withWorkspaceLease, withWorkspaceLeases, withWorkspaceMutation } from "./workspace-lease.js";
import type { VersionStore } from "./versioning.js";
import { withWorkspaceAdmissions } from "./workspace-lifecycle.js";

/** Paths are resolved only after the control plane grants source/target Workspace access. */
async function safePath(root: string, path: string, createParents: boolean): Promise<string> {
  if (!path || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Copy requires a relative Workspace file path");
  const normalized = path;
  const canonicalRoot = await realpath(root);
  let parent = canonicalRoot;
  for (const segment of normalized.split("/").slice(0, -1)) {
    parent = resolve(parent, segment);
    if (createParents) await mkdir(parent).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Workspace copy parent must be a real directory, not a symbolic link");
  }
  const target = resolve(canonicalRoot, normalized);
  if (!(await realpath(dirname(target))).startsWith(`${canonicalRoot}${sep}`) && dirname(target) !== canonicalRoot) throw new Error("Workspace copy path escapes its root");
  return target;
}

/** Shared local publication primitive: bounded memory, verified temporary file, atomic no-clobber. */
export async function publishWorkspaceFile(input: {
  root: string; path: string; chunks: AsyncIterable<Uint8Array>;
  conflict?: "reject" | "overwrite"; expectedBytes?: number; expectedHash?: string;
  verifySource?: () => Promise<void>; signal?: AbortSignal;
  versions?: VersionStore;
  maxBytes?: number; executable?: number; onProgress?: (bytes: number) => void;
}): Promise<{ transferId: string; bytes: number; sha256: string }> {
  let published = false;
  const operation = async () => { const result = await publishUnlocked(input); published = true; return result; };
  try {
    return await (input.versions ? withWorkspaceMutation(input.versions, input.root, operation, { kind: "workspace-copy" }, input.signal)
      : withWorkspaceLease(input.root, operation, input.signal));
  } catch (error) {
    if (published) throw Object.assign(new Error("File was published but its version receipt failed; inspect storage before retrying", { cause: error }), { code: "PUBLICATION_UNCONFIRMED" });
    throw error;
  }
}

async function publishUnlocked(input: Parameters<typeof publishWorkspaceFile>[0]): ReturnType<typeof publishWorkspaceFile> {
  if (input.conflict !== undefined && input.conflict !== "reject" && input.conflict !== "overwrite") throw new Error("Invalid copy conflict policy");
  const target = await safePath(input.root, input.path, true);
  const disk = await statfs(dirname(target));
  if (input.expectedBytes !== undefined && input.expectedBytes > Number(disk.bavail) * Number(disk.bsize)) throw new Error("Insufficient free space on target Workspace filesystem");
  const transferId = randomUUID();
  const temporary = `${target}.transfer-${transferId}`;
  let output;
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    output = await open(temporary, "wx", 0o600);
    for await (const chunk of input.chunks) {
      input.signal?.throwIfAborted();
      hash.update(chunk);
      bytes += chunk.byteLength;
      if (input.maxBytes && bytes > input.maxBytes) throw new Error("Workspace copy exceeds its byte limit");
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await output.write(chunk, offset, chunk.byteLength - offset);
        if (!written.bytesWritten) throw new Error("Workspace copy made no write progress");
        offset += written.bytesWritten;
      }
      input.onProgress?.(bytes);
    }
    const sha256 = hash.digest("hex");
    if (input.expectedBytes !== undefined && bytes !== input.expectedBytes) throw new Error("Workspace copy source size changed");
    if (input.expectedHash !== undefined && sha256 !== input.expectedHash) throw new Error("Workspace copy checksum mismatch");
    await input.verifySource?.();
    input.signal?.throwIfAborted();
    if (input.executable) await output.chmod(0o600 | (input.executable & 0o111));
    await output.sync();
    await output.close();
    output = undefined;
    if (await safePath(input.root, input.path, false) !== target) throw new Error("Workspace copy destination changed");
    try {
      const existing = await lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Workspace copy rejects symbolic links and special files");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (input.conflict === "overwrite") await rename(temporary, target);
    else {
      try { await link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error(`Workspace file already exists: ${input.path}`), { code: "CONFLICT" });
        throw error;
      }
    }
    return { transferId, bytes, sha256 };
  } finally {
    await output?.close();
    await rm(temporary, { force: true });
  }
}

export async function copyWorkspaceFile(input: {
  sourceRoot: string; sourcePath: string; targetRoot: string; targetPath: string;
  conflict?: "reject" | "overwrite"; signal?: AbortSignal;
  versions?: VersionStore;
}) {
  const roots = [input.sourceRoot, input.targetRoot];
  const copy = () => withWorkspaceLeases(roots, () => copyUnlocked(input), input.signal);
  return input.versions ? withWorkspaceAdmissions(input.versions, roots, copy, input.signal) : copy();
}

async function copyUnlocked(input: Parameters<typeof copyWorkspaceFile>[0]) {
  const sourcePath = await safePath(input.sourceRoot, input.sourcePath, false);
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Workspace copy requires a regular file");
    return await publishWorkspaceFile({ root: input.targetRoot, path: input.targetPath, conflict: input.conflict,
      versions: input.versions, signal: input.signal, expectedBytes: Number(before.size), chunks: source.createReadStream({ autoClose: false }),
      verifySource: async () => {
        await safePath(input.sourceRoot, input.sourcePath, false);
        const after = await source.stat({ bigint: true });
        const current = await lstat(sourcePath, { bigint: true });
        if (current.isSymbolicLink() || before.dev !== current.dev || before.ino !== current.ino
          || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
          throw new Error("Workspace copy source changed; retry from a stable version");
        }
      },
    });
  } finally { await source.close(); }
}

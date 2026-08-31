// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type {
  RemoteWorkspaceFile,
  RemoteWorkspaceSyncRecord,
  RemoteWorkspaceSyncRequest,
} from "@sciencediscovery/schema";
import type { RunnerClient } from "@sciencediscovery/executor";
import { normalizeWorkspaceRelativePath, resolveWorkspaceFile } from "@sciencediscovery/workspace";

import type { SessionStore } from "./store.js";

export function remoteWorkspaceKey(projectId: string, sessionId: string): string {
  return `${projectId}/${sessionId}`;
}

function selected(path: string, requestedPaths: string[]): boolean {
  return requestedPaths.some((requested) => path === requested || path.startsWith(`${requested}/`));
}

function syncConflict(message: string): Error {
  return Object.assign(new Error(message), { code: "CONFLICT" });
}

async function listLocalWorkspaceFiles(root: string, selectedPaths: string[]): Promise<RemoteWorkspaceFile[]> {
  const files = new Map<string, RemoteWorkspaceFile>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const details = await stat(absolute);
        const path = relative(root, absolute).split(sep).join("/");
        files.set(path, {
          modifiedAt: details.mtime.toISOString(),
          path,
          size: details.size,
        });
      }
    }
  };
  const canonicalRoot = await realpath(root);
  for (const path of selectedPaths) {
    const candidate = resolveWorkspaceFile(root, path);
    let details;
    try { details = await lstat(candidate); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (details.isSymbolicLink()) continue;
    const canonical = await realpath(candidate);
    if (!canonical.startsWith(`${canonicalRoot}${sep}`)) throw new Error("Selected local path escapes through a symbolic link");
    if (details.isDirectory()) await visit(canonical);
    else if (details.isFile()) files.set(path, { modifiedAt: details.mtime.toISOString(), path, size: details.size });
  }
  return [...files.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writableLocalWorkspaceFile(root: string, pathValue: string): Promise<string> {
  const path = normalizeWorkspaceRelativePath(root, pathValue);
  const candidate = resolveWorkspaceFile(root, path);
  let parent = root;
  for (const segment of path.split("/").slice(0, -1)) {
    const next = resolve(parent, segment);
    try {
      const details = await lstat(next);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error("Local workspace parent must be a real directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(next);
    }
    parent = next;
  }
  return candidate;
}

export async function syncRemoteWorkspace(options: {
  hostId: string;
  input: RemoteWorkspaceSyncRequest;
  runnerClient: RunnerClient;
  sessionId: string;
  store: SessionStore;
}): Promise<{ files: string[]; record: RemoteWorkspaceSyncRecord }> {
  const session = options.store.assertSessionWritable(options.sessionId);
  if (session.remoteRunnerHostId !== options.hostId) throw new Error("Remote runner is not selected by this Session");
  const conflict = options.input.conflict ?? "reject";
  if (conflict !== "reject" && conflict !== "overwrite") throw new Error("Invalid sync conflict policy");
  if (options.input.direction !== "push" && options.input.direction !== "pull") {
    throw new Error("Sync direction must be push or pull");
  }
  if (!Array.isArray(options.input.paths) || options.input.paths.length < 1 || options.input.paths.length > 50) {
    throw new Error("Sync requires 1-50 workspace-relative paths");
  }
  const workspaceRoot = options.store.workspacePath(options.sessionId);
  const requestedPaths = [...new Set(options.input.paths.map((path) =>
    normalizeWorkspaceRelativePath(workspaceRoot, path)))];
  const workspaceKey = remoteWorkspaceKey(session.projectId, session.id);
  const startedAt = new Date().toISOString();
  let files: RemoteWorkspaceFile[] = [];
  try {
    const [localFiles, remoteFiles] = await Promise.all([
      options.input.direction === "push" ? listLocalWorkspaceFiles(workspaceRoot, requestedPaths) : [],
      options.runnerClient.listRemoteWorkspaceFiles(workspaceKey, requestedPaths),
    ]);
    if (options.input.direction === "push") {
      files = localFiles.filter((file) => selected(file.path, requestedPaths));
      if (!files.length) throw new Error("Sync paths must select at least one local workspace file");
      const remotePaths = new Set(remoteFiles.map((file) => file.path));
      if (conflict === "reject") {
        const collision = files.find((file) => remotePaths.has(file.path));
        if (collision) throw syncConflict(`Remote workspace file already exists: ${collision.path}`);
      }
      for (const file of files) {
        const source = resolveWorkspaceFile(workspaceRoot, file.path);
        await options.runnerClient.writeRemoteWorkspaceFile(workspaceKey, file.path, await readFile(source), conflict);
      }
    } else {
      files = remoteFiles.filter((file) => selected(file.path, requestedPaths));
      if (!files.length) throw new Error("Sync paths must select at least one remote workspace file");
      if (conflict === "reject") {
        for (const file of files) {
          if (await exists(resolveWorkspaceFile(workspaceRoot, file.path))) {
            throw syncConflict(`Local workspace file already exists: ${file.path}`);
          }
        }
      }
      for (const file of files) {
        const destination = await writableLocalWorkspaceFile(workspaceRoot, file.path);
        const temporary = `${destination}.remote-sync-${process.pid}-${Date.now()}`;
        try {
          await writeFile(temporary, await options.runnerClient.readRemoteWorkspaceFile(workspaceKey, file.path), {
            flag: "wx",
            mode: 0o600,
          });
          await rename(temporary, destination);
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      }
    }
    const record: RemoteWorkspaceSyncRecord = {
      bytes: files.reduce((total, file) => total + file.size, 0),
      createdAt: startedAt,
      direction: options.input.direction,
      fileCount: files.length,
      hostId: options.hostId,
      id: randomUUID(),
      paths: requestedPaths,
      sessionId: options.sessionId,
      status: "completed",
    };
    await options.store.appendRemoteWorkspaceSync(record);
    return { files: files.map((file) => file.path), record };
  } catch (error) {
    const record: RemoteWorkspaceSyncRecord = {
      bytes: 0,
      createdAt: startedAt,
      direction: options.input.direction,
      error: error instanceof Error ? error.message : "Remote workspace sync failed",
      fileCount: 0,
      hostId: options.hostId,
      id: randomUUID(),
      paths: requestedPaths,
      sessionId: options.sessionId,
      status: "failed",
    };
    await options.store.appendRemoteWorkspaceSync(record);
    throw error;
  }
}

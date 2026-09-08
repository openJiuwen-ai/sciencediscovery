// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { RemoteWorkspaceSyncRecord, RemoteWorkspaceSyncRequest, WorkspaceTransfer } from "@sciencediscovery/schema";
import type { RunnerClient } from "@sciencediscovery/executor";
import { normalizeWorkspaceRelativePath } from "@sciencediscovery/workspace";
import type { SessionStore } from "./store.js";
import type { TransferEndpoint } from "./workspace-transfers.js";

export function remoteWorkspaceKey(projectId: string, sessionId: string, namespace?: string, agentId?: string): string {
  const root = `${projectId}/${sessionId}${namespace ? `/runners/${namespace}` : ""}`;
  return agentId ? `${root}/agents/${agentId}` : root;
}

/** Compatibility adapter: the old synchronous surface now waits for the same
 * durable Transfer as the management tool, never reading mutable source files. */
export async function syncRemoteWorkspace(options: {
  hostId: string;
  /** Trusted control-plane ownership, never taken from model-supplied paths. */
  agentId?: string;
  workspaceRoot?: string;
  input: RemoteWorkspaceSyncRequest;
  runnerClient: RunnerClient;
  sessionId: string;
  store: SessionStore;
  signal?: AbortSignal;
}): Promise<{ files: string[]; record: RemoteWorkspaceSyncRecord; transfer: WorkspaceTransfer }> {
  const { store, sessionId, hostId } = options;
  const session = store.assertSessionWritable(sessionId);
  store.assertSessionAllowsRemoteRunner(sessionId, hostId);
  const direction = options.input.direction;
  if (direction !== "push" && direction !== "pull") throw new Error("Sync direction must be push or pull");
  if (!Array.isArray(options.input.paths) || !options.input.paths.length || options.input.paths.length > 50) {
    throw new Error("Sync requires 1-50 workspace-relative paths");
  }
  options.signal?.throwIfAborted();
  const root = options.workspaceRoot ?? store.workspacePath(sessionId);
  const paths = [...new Set(options.input.paths.map((path) => normalizeWorkspaceRelativePath(root, path)))];
  const agentId = options.agentId ? `subagent:${options.agentId}` : "main";
  const owner = { sessionId, agentId };
  const localId = store.workspaceIdentity(sessionId, agentId).id;
  const remoteId = store.workspaceIdentity(sessionId, agentId, hostId).id;
  const workspaceKey = remoteWorkspaceKey(session.projectId, sessionId, store.getRemoteHost(hostId)?.workspaceNamespace, options.agentId);
  const transfer = store.transfers.start(owner, {
    sourceWorkspaceId: direction === "push" ? localId : remoteId,
    targetWorkspaceId: direction === "push" ? remoteId : localId,
    files: paths.map((path) => ({ sourcePath: path, targetPath: path })),
    conflict: options.input.conflict ?? "reject",
  }, {
    resolve: (id): TransferEndpoint => {
      store.assertSessionWritable(sessionId);
      store.assertSessionAllowsRemoteRunner(sessionId, hostId);
      if (id === localId) return { id, root };
      if (id === remoteId) return { id, runner: options.runnerClient, workspaceKey };
      throw new Error("Workspace is not owned by this sync operation");
    },
    committed: async (file, job) => {
      if (direction !== "pull") return;
      await store.recordWorkspaceFileRevision(sessionId, {
        path: options.agentId ? `subagents/${options.agentId}/${file.targetPath}` : file.targetPath,
        mode: "write", origin: "system", modifiedAt: new Date().toISOString(), size: file.size, contentHash: file.sha256,
        ...(options.agentId ? { subagentId: options.agentId } : {}),
        originMeta: { source: "runner_pull", runnerId: hostId, agentId,
          sourceWorkspaceId: job.sourceWorkspaceId, workspaceId: job.targetWorkspaceId,
          transferId: job.id, sourceSnapshotId: job.sourceSnapshotId!, sha256: file.sha256 },
      });
    },
  });
  const cancel = () => { void store.transfers.cancel(transfer.id, owner).catch(() => {}); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let result: WorkspaceTransfer;
  try { result = await store.transfers.wait(transfer.id, owner); }
  finally { options.signal?.removeEventListener("abort", cancel); }
  const completed = result.progress.filter((file) => file.state === "completed");
  const record: RemoteWorkspaceSyncRecord = {
    id: result.id, sessionId, hostId, direction, paths, createdAt: result.createdAt,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    bytes: completed.reduce((sum, file) => sum + file.size, 0), fileCount: completed.length,
    status: result.state === "completed" ? "completed" : "failed",
    ...(result.error ? { error: result.error } : {}),
  };
  await store.appendRemoteWorkspaceSync(record);
  if (result.state !== "completed") {
    throw Object.assign(new Error(`${result.error ?? "Workspace sync did not complete"} (Transfer ${result.id}: ${result.state})`),
      { code: result.errorCode, transferId: result.id, transfer: result });
  }
  return { files: completed.map((file) => file.targetPath), record, transfer: result };
}

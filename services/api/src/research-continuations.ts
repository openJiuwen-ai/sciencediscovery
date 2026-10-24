// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.


import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { MemoryGraphClient, MemoryGraphSnapshot } from "@sciencediscovery/memory";
import type { ResearchPackageProvider } from "@sciencediscovery/research-package";
import { sha256 } from "@sciencediscovery/research-package";
import type { ResearchContinuationOperation } from "@sciencediscovery/schema";
import { SessionStoreHttpError, type SessionStore } from "./store.js";
import { listWorkspaceFiles } from "./artifacts/index.js";
import { apiLog } from "./logging.js";
import { shortErrorMessage } from "@sciencediscovery/operational-logging";

type Restore = (projectId: string, sessionId: undefined, bytes: Buffer, options: { operationId: string; sourceSessionId: string; sourceMessageId?: string }) => Promise<{ importedSessionIds: string[]; sessionMapping: Record<string, string> }>;

/** Durable request identities survive client disconnects and API restarts. */
export function createContinuationOperations({ store, memoryGraphClient }: { store: SessionStore; memoryGraphClient: MemoryGraphClient }, provider: ResearchPackageProvider, restore: Restore, prepareBranch?: (sessionId: string, messageId: string) => Promise<Uint8Array>) {
  const root = resolve(store.dataDir, "research-continuations");
  const starting = new Map<string, Promise<ResearchContinuationOperation>>();
  const active = new Set<string>();
  const compensate = async (operationId: string) => {
    const sessions = store.researchOperationSessions(operationId);
    if (!sessions.length) return;
    if (sessions.some((session) => session.researchSnapshot?.role !== "research_copy" || session.researchSnapshot.state === "ready")) throw new Error("Cannot clean published research");
    // Leave a locked, unpublished operation if the graph cannot be cleaned yet.
    // Recovery retries only this operation's newly allocated scopes.
    await memoryGraphClient.discardSnapshot(sessions.map((session) => session.id));
    await store.discardResearchCopies(operationId);
  };
  const write = async (operation: ResearchContinuationOperation) => {
    await mkdir(root, { recursive: true });
    const path = resolve(root, `${operation.id}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(operation));
    await rename(temporary, path);
  };
  const getContinuation = async (sourceSessionId: string, id: string): Promise<ResearchContinuationOperation> => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new SessionStoreHttpError("Invalid operation id", 400);
    let operation: ResearchContinuationOperation;
    try { operation = JSON.parse(await readFile(resolve(root, `${id}.json`), "utf8")) as ResearchContinuationOperation; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new SessionStoreHttpError("Operation not found", 404), { code: "ENOENT" });
      throw error;
    }
    if (operation.sourceSessionId !== sourceSessionId) throw new SessionStoreHttpError("Operation not found", 404);
    return operation;
  };
  const run = async (operation: ResearchContinuationOperation, projectId: string, prepare: () => Promise<Buffer>) => {
    active.add(operation.id);
    try {
      const bytes = await prepare();
      const restored = await restore(projectId, undefined, bytes, { operationId: operation.id, sourceSessionId: operation.sourceSessionId, sourceMessageId: operation.sourceMessageId });
      operation.sessionIds = restored.importedSessionIds;
      operation.entrySessionId = restored.sessionMapping[operation.sourceSessionId];
      if (!operation.entrySessionId) throw new Error("Continuation entry session missing");
      operation.state = "ready";
    } catch (error) {
      apiLog.warn("research_continuation_failed", { operationId: operation.id, errorMessage: shortErrorMessage(error) });
      operation.state = "failed";
      operation.error = operation.sourceMessageId ? `创建聊天分支失败：${shortErrorMessage(error)}` : "复制未完成，原始导入快照保持不变。请检查 API 和科学记忆服务后重试。";
      await compensate(operation.id).catch((cleanupError) => apiLog.warn("research_continuation_cleanup_pending", { operationId: operation.id, errorMessage: shortErrorMessage(cleanupError) }));
    } finally {
      try { await write(operation); }
      finally { active.delete(operation.id); }
    }
  };
  const startContinuation = (sourceSessionId: string, requestId: string): Promise<ResearchContinuationOperation> => {
    if (!/^[a-zA-Z0-9-]{16,128}$/.test(requestId)) return Promise.reject(new SessionStoreHttpError("Invalid request id", 400));
    const id = createHash("sha256").update(`${sourceSessionId}:${requestId}`).digest("hex");
    const pending = starting.get(id);
    if (pending) return pending;
    const start = (async () => {
      const source = store.getSession(sourceSessionId);
      const snapshot = source?.researchSnapshot;
      if (!source || snapshot?.role !== "imported_snapshot" || snapshot.state !== "ready" || !snapshot.continuationAvailable || !snapshot.storagePath) {
        throw new SessionStoreHttpError("只有完整恢复的导入证据快照可以创建研究会话。", 409);
      }
      try { return await getContinuation(sourceSessionId, id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const bytes = await readFile(resolve(store.dataDir, snapshot.storagePath));
      if (sha256(bytes) !== snapshot.snapshotChecksum) throw new SessionStoreHttpError("Snapshot checksum mismatch", 409);
      const imported = provider.importReadOnly(bytes);
      const graph = (imported.records as { memoryGraph?: MemoryGraphSnapshot }).memoryGraph;
      if (graph?.nodes.length) await memoryGraphClient.validateSnapshot([...(imported.manifest.source.sessionIds ?? [])], graph);
      const operation: ResearchContinuationOperation = { id, sourceSessionId, state: "copying", createdAt: new Date().toISOString() };
      await write(operation);
      void run(structuredClone(operation), source.projectId, async () => bytes).catch(() => undefined);
      return operation;
    })();
    starting.set(id, start);
    void start.finally(() => starting.delete(id)).catch(() => undefined);
    return start;
  };
  const assertBranchSourceIdle = async (sourceSessionId: string) => {
    const source = store.getSession(sourceSessionId);
    if (!source) throw new SessionStoreHttpError("Session not found", 404);
    if (source.researchSnapshot && source.researchSnapshot.state !== "ready") throw new SessionStoreHttpError("请等待证据恢复完成后再分叉。", 409);
    const runs = await store.listSessionRuns(sourceSessionId);
    if (runs.some((row) => ["queued", "running", "blocked"].includes(row.status))
      || store.shellExecutions.snapshot(sourceSessionId).some((row) => ["queued", "running", "unknown"].includes(row.state))
      || store.listSubagents(sourceSessionId).some((row) => ["queued", "running"].includes(row.status))
      || store.listRemoteJobs(sourceSessionId).some((row) => !["completed", "failed", "denied"].includes(row.state))) {
      throw new SessionStoreHttpError("原会话仍有任务执行中，请完成或停止任务后再分叉。", 409);
    }
    const files = await listWorkspaceFiles(store, sourceSessionId, true);
    return JSON.stringify({ session: source, messages: await store.readMessages(sourceSessionId), runs, files,
      revisions: [...store.snapshotWorkspaceFileRevisions(sourceSessionId)] });
  };
  const startConversationBranch = (sourceSessionId: string, sourceMessageId: string, requestId: string): Promise<ResearchContinuationOperation> => {
    if (typeof sourceMessageId !== "string" || !sourceMessageId || sourceMessageId.length > 256
      || typeof requestId !== "string" || !/^[a-zA-Z0-9-]{16,128}$/.test(requestId)) {
      return Promise.reject(new SessionStoreHttpError("Invalid branch request", 400));
    }
    const id = createHash("sha256").update(JSON.stringify(["conversation-branch", sourceSessionId, sourceMessageId, requestId])).digest("hex");
    const pending = starting.get(id);
    if (pending) return pending;
    const start = (async () => {
      // A lost response must return the same operation, even if the source has since changed.
      try { return await getContinuation(sourceSessionId, id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const before = await assertBranchSourceIdle(sourceSessionId);
      const source = store.getSession(sourceSessionId)!;
      const messages = await store.readMessages(sourceSessionId);
      const message = messages.find((row) => row.id === sourceMessageId);
      const selectedRun = (await store.listSessionRuns(sourceSessionId)).find((row) => row.assistantMessageId === sourceMessageId);
      if (!message || message.role !== "assistant" || message.kind && message.kind !== "message" || !message.content.trim()
        || selectedRun && selectedRun.status !== "completed") throw new SessionStoreHttpError("只能从已完成的正式回复创建分支。", 409);
      if (!prepareBranch) throw new SessionStoreHttpError("Conversation branching unavailable", 503);
      const operation: ResearchContinuationOperation = { id, sourceSessionId, sourceMessageId, state: "copying", createdAt: new Date().toISOString() };
      await write(operation);
      void run(structuredClone(operation), source.projectId, async () => {
        const bytes = Buffer.from(await prepareBranch(sourceSessionId, sourceMessageId));
        if (before !== await assertBranchSourceIdle(sourceSessionId)) throw new Error("复制期间原会话发生变化，请重试。");
        return bytes;
      }).catch(() => undefined);
      return operation;
    })();
    starting.set(id, start);
    void start.finally(() => starting.delete(id)).catch(() => undefined);
    return start;
  };
  const recoverContinuations = async () => {
    const files = await readdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const operation = JSON.parse(await readFile(resolve(root, file), "utf8")) as ResearchContinuationOperation;
      if (active.has(operation.id) || operation.state === "ready") continue;
      if (operation.state === "failed") { await compensate(operation.id).catch(() => undefined); continue; }
      const sessions = store.researchOperationSessions(operation.id);
      if (sessions.length && sessions.every((session) => session.researchSnapshot?.state === "ready")) {
        operation.state = "ready"; operation.sessionIds = sessions.map((session) => session.id);
        operation.entrySessionId = sessions.find((session) => session.researchSnapshot?.sourceSnapshotSessionId === operation.sourceSessionId)?.id;
        if (!operation.entrySessionId) {
          operation.state = "failed";
          operation.error = "找不到复制后的入口会话，请检查会话列表。";
        }
      } else {
        operation.state = "failed"; operation.error = "服务重启中断了复制，请重试。未完成的会话保持锁定。";
        if (sessions.length) await store.setResearchSnapshots(sessions.map((session) => ({ sessionId: session.id, snapshot: { ...session.researchSnapshot!, state: "failed" } })));
        await compensate(operation.id).catch(() => undefined);
      }
      await write(operation);
    }
    for (const project of store.listProjects()) {
      const interrupted = store.researchSessions(project.id).filter((session) => session.researchSnapshot?.state === "importing");
      if (interrupted.length) await store.setResearchSnapshots(interrupted.map((session) => ({ sessionId: session.id, snapshot: { ...session.researchSnapshot!, state: "failed", continuationAvailable: false } })));
    }
  };
  return { startContinuation, startConversationBranch, getContinuation, recoverContinuations };
}

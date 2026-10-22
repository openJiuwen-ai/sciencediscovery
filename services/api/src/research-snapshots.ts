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


import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, stat, utimes } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { VersionStore, withWorkspaceMutation } from "@sciencediscovery/cas";
import { researchPackagePlugin } from "@sciencediscovery/research-package/plugin";
import { sha256, type ExportInput, type ResearchPackageCounts, type ResearchPackageExportProfile } from "@sciencediscovery/research-package";
import { contextBlocks, type TrajectoryDetail, type TrajectoryEntry } from "@sciencediscovery/trajectory";
import type { MemoryGraphSnapshot } from "@sciencediscovery/memory";
import type { ArtifactAnnotation, ArtifactReviewRun, ChatMessage, EnvironmentRevision, ResearchSnapshot, ReviewRun, ReviewerAuditTask, ReviewFeedback, ScientificArtifact, ScientificArtifactVersion, Session, SessionRun, SessionRunEvent, WorkspaceFileProvenance } from "@sciencediscovery/schema";
import { createLocalSessionTitle } from "@sciencediscovery/schema";
import { resolveWorkspaceFile } from "@sciencediscovery/workspace";
import { listWorkspaceFiles } from "./artifacts/index.js";
import { SessionStoreHttpError } from "./store.js";
import type { createPlatformServices } from "./bootstrap/platform.js";
import { createContinuationOperations } from "./research-continuations.js";
import { buildConversationBranch } from "./conversation-branches.js";
import { verifyResearchCopy } from "./research-snapshot-integrity.js";
import { sessionTrajectory } from "./trajectory.js";
import { emptyPackageTrajectory, importedTrajectoryAccess, remapPackageTrajectory, validatePackageTrajectory, writePackageTrajectory, type PackageTrajectory } from "./research-package-trajectory.js";
import { casHashes, versionRefs, remapRunEvent, remapRunStreamId, remapReferences, remapMessages, exportHistory, ResearchPackageIds, restoreHistory, restoreEvidenceItems, remapMemorySnapshot, remapWorkspaceProvenance, type PackageHistory } from "./research-package-history.js";

type Ports = Pick<ReturnType<typeof createPlatformServices>, "store" | "memoryGraphClient" | "memoryGraphEnabled" | "provenanceRecorder">;

export type ExportSessionRecord = PackageHistory & {
  session: Omit<Session, "settingsOverrides"> & { settingsOverrides?: undefined };
  messages: ChatMessage[];
  runs: SessionRun[];
  artifactAnnotations: ArtifactAnnotation[];
  runEvents?: Array<{ runId: string; streams: Array<{ streamId: string; events: SessionRunEvent[] }> }>;
  trajectory: PackageTrajectory;
  workspace: Array<{ path: string; objectPath: string; size?: number; modifiedAt?: string }>;
  workspaceProvenance: WorkspaceFileProvenance[];
  validations: { artifactReviews: ArtifactReviewRun[]; reviews: ReviewRun[]; reviewerAuditTasks: ReviewerAuditTask[]; reviewFeedback: ReviewFeedback[] };
};

export type ExportArtifact = ScientificArtifact & { currentVersion: number; versions: Array<ScientificArtifactVersion & { objectPath?: string }> };

function idSet(values: Iterable<string>): Set<string> { return new Set(values); }

function latestArtifactClosure(artifacts: ExportArtifact[], roots = artifacts, additional: Iterable<string> = []): Set<string> {
  const byVersion = new Map(artifacts.flatMap((artifact) => artifact.versions.map((version) => [version.id, version] as const)));
  const keep = new Set<string>();
  const pending = [...additional, ...roots.map((artifact) => artifact.versions.toSorted((left, right) => right.version - left.version)[0]?.id).filter((id): id is string => Boolean(id))];
  while (pending.length) {
    const id = pending.shift()!;
    if (keep.has(id)) continue;
    const version = byVersion.get(id);
    if (!version) continue;
    keep.add(id);
    pending.push(...version.inputArtifactVersionIds);
  }
  return keep;
}

function necessaryTrajectoryEntries(trajectory: Pick<PackageTrajectory, "index">, runs: Set<string>): TrajectoryEntry[] {
  const entries = [...trajectory.index.entries, ...(trajectory.index.untimedEntries ?? trajectory.index.historicalEntries ?? [])].filter((entry) => !entry.runId || runs.has(entry.runId));
  // Index order already represents recorded chronology; untimed entries keep their source order.
  const latestInput = entries.filter((entry) => entry.kind === "input").at(-1);
  const latestOutput = entries.filter((entry) => entry.kind === "output").at(-1);
  return entries.filter((entry) => entry === latestInput || entry === latestOutput || entry.kind === "tool" || entry.kind === "mcp");
}

function trimTrajectory(trajectory: PackageTrajectory, runs: Set<string>): PackageTrajectory {
  const selected = necessaryTrajectoryEntries(trajectory, runs);
  const detailsById = new Map(trajectory.details.map((detail) => [detail.entry.id, detail]));
  const details = selected.flatMap<TrajectoryDetail>((entry) => {
    const detail = detailsById.get(entry.id);
    if (!detail) return [];
    if (entry.kind === "input" && detail.context) {
      const input = detail.context.input;
      return [{ entry, value: { exportSummary: true, summary: "必要导出：最近一次模型输入。" }, context: { input, blocks: contextBlocks(input, {}), assembly: {}, state: {} } }];
    }
    const serialized = typeof detail.value === "string" ? detail.value : JSON.stringify(detail.value, null, 2) ?? "";
    const limit = entry.kind === "output" ? serialized.length : 2000;
    return [{ entry, value: { exportSummary: true, summary: serialized.slice(0, limit), truncated: serialized.length > limit,
      note: "必要导出轨迹摘要；完整事件、思考分片及工具原始输出请使用完整导出。" } }];
  });
  const selectedIds = new Set(selected.map((entry) => entry.id));
  const untimed = (trajectory.index.untimedEntries ?? trajectory.index.historicalEntries ?? []).filter((entry) => selectedIds.has(entry.id));
  return { index: { ...trajectory.index, entries: trajectory.index.entries.filter((entry) => selectedIds.has(entry.id)), untimedEntries: untimed, historicalEntries: untimed,
    warnings: [...trajectory.index.warnings, "必要导出仅包含最近模型输入、最终输出和相关工具摘要；不包含完整思考及事件流。"] }, details, runIds: [...runs] };
}

function necessaryHistory(history: PackageHistory, turnIds: Set<string>, executionIds: Set<string>, reviewIds: Set<string>): PackageHistory {
  const claims = (history.claims ?? []).filter((row) => reviewIds.has(row.reviewRunId));
  const claimIds = new Set(claims.map((row) => row.id));
  const evidenceLinks = (history.evidenceLinks ?? []).filter((row) => claimIds.has(row.claimId));
  const itemIds = new Set(evidenceLinks.flatMap((row) => row.evidenceItemId ? [row.evidenceItemId] : []));
  return {
    executionRuns: history.executionRuns?.filter((row) => executionIds.has(row.id)),
    promptManifests: history.promptManifests?.filter((row) => turnIds.has(row.turnId)),
    artifactDerivations: history.artifactDerivations?.filter((row) => row.executionRunIds.some((id) => executionIds.has(id))),
    subagents: history.subagents?.filter((row) => turnIds.has(row.parentTurnId)),
    shellExecutions: history.shellExecutions?.filter((row) => executionIds.has(row.result?.executionId ?? "") || row.state === "completed" && turnIds.has(row.turnId)),
    claims, evidenceLinks, evidenceItems: history.evidenceItems?.filter((row) => itemIds.has(row.id)),
  };
}

export function countExport(sessions: ExportSessionRecord[], artifacts: ExportArtifact[], graph?: MemoryGraphSnapshot): ResearchPackageCounts {
  const sum = (get: (record: ExportSessionRecord) => number) => sessions.reduce((total, record) => total + get(record), 0);
  return { sessions: sessions.length, messages: sum((row) => row.messages.length), artifacts: artifacts.length,
    artifactVersions: artifacts.reduce((total, row) => total + row.versions.length, 0), workspaceFiles: sum((row) => row.workspace.length),
    executionRuns: sum((row) => new Set([...(row.executionRuns ?? []).map((run) => run.id), ...(row.shellExecutions ?? []).map((run) => run.result?.executionId ?? run.id)]).size), runs: sum((row) => row.runs.length),
    runEvents: sum((row) => (row.runEvents ?? []).reduce((total, run) => total + run.streams.reduce((count, stream) => count + stream.events.length, 0), 0)),
    trajectoryEvents: sum((row) => row.trajectory.index.entries.length + (row.trajectory.index.untimedEntries?.length ?? 0)),
    fileRevisions: sum((row) => row.workspaceProvenance.reduce((total, file) => total + file.revisions.length, 0)), memoryNodes: graph?.nodes.length ?? 0, memoryEdges: graph?.edges.length ?? 0 };
}

function filterMemoryGraph(graph: MemoryGraphSnapshot | undefined, artifacts: ExportArtifact[], executionIds: Set<string>): MemoryGraphSnapshot | undefined {
  if (!graph) return undefined;
  const versions = new Map(artifacts.map((artifact) => [artifact.id, new Set(artifact.versions.map((version) => version.version))]));
  const nodes = graph.nodes.filter((node) => {
    const properties = node.properties as Record<string, unknown>;
    if (typeof properties.artifact_id === "string") return versions.get(properties.artifact_id)?.has(Number(properties.version)) ?? false;
    if (node.labels.includes("Code") && typeof properties.code_id === "string") return executionIds.has(properties.code_id);
    return true;
  });
  const candidates = new Map(nodes.map((node) => [node.id, node]));
  const keep = new Set(nodes.filter((node) => node.labels.includes("ResearchGoal") || typeof node.properties.artifact_id === "string" || executionIds.has(String(node.properties.code_id ?? ""))).map((node) => node.id));
  // Include the provenance ancestors, without walking forward into unrelated historical branches.
  const parents = new Map<string, string[]>();
  for (const edge of graph.edges) if (candidates.has(edge.source) && candidates.has(edge.target)) parents.set(edge.target, [...(parents.get(edge.target) ?? []), edge.source]);
  const pending = [...keep];
  while (pending.length) for (const parent of parents.get(pending.shift()!) ?? []) if (!keep.has(parent)) { keep.add(parent); pending.push(parent); }
  return { nodes: nodes.filter((node) => keep.has(node.id)), edges: graph.edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target)) };
}

export function createResearchSnapshots({ store, memoryGraphClient, memoryGraphEnabled, provenanceRecorder }: Ports, sessionHasResearchHistory: (sessionId: string) => Promise<boolean>) {
  const researchPackageProvider = researchPackagePlugin.create().contribution.provider;
  const buildResearchPackageInput = async (projectId: string, sessionId?: string, level: "necessary" | "complete" = "necessary", selectedFiles?: Set<string>, cohort?: Set<string>): Promise<ExportInput> => {
    const project = store.getProject(projectId);
    if (!project) throw new SessionStoreHttpError("Project not found", 404);
    const availableSessions = store.researchSessions(projectId);
    const sessions = availableSessions.filter((item) => cohort ? cohort.has(item.id) : (!item.researchSnapshot || item.researchSnapshot.state === "ready") && (!sessionId || item.id === sessionId));
    if (sessionId && !sessions.length) throw new SessionStoreHttpError("Session not found", 404);
    const objects = new Map<string, { path: string; bytes: Uint8Array; kind: "artifact" | "evidence" | "log" | "other" }>();
    const omissions: string[] = [];
    const addObject = async (bytes: Uint8Array, kind: "artifact" | "evidence" | "log" | "other") => {
      const path = sha256(bytes);
      if (!objects.has(path)) objects.set(path, { path, bytes, kind });
      return path;
    };
    const scopedSessionIds = new Set(sessions.map((session) => session.id));
    const availableArtifacts = store.listProjectArtifacts(projectId).map((artifact) => ({ ...artifact, versions: store.listProjectArtifactVersions(projectId, artifact.id) }));
    const scopedArtifacts = availableArtifacts.flatMap((artifact) => {
      const versions = artifact.versions.filter((version) => scopedSessionIds.has(version.sessionId));
      return versions.length ? [{ ...artifact, currentVersion: Math.max(...versions.map((version) => version.version)), versions }] : [];
    });
    let necessaryVersionIds = latestArtifactClosure(availableArtifacts, scopedArtifacts);
    if (level === "necessary") {
      // A validation may cite an older artifact that is not declared as an input version.
      // Follow those evidence links as well, so retained conclusions never lose their sources.
      const histories = new Map<string, Promise<PackageHistory>>();
      const reviews = new Map<string, ReturnType<typeof store.listArtifactReviews>>();
      const pending = [...necessaryVersionIds], visited = new Set<string>();
      const versions = new Map(availableArtifacts.flatMap((artifact) => artifact.versions.map((version) => [version.id, version] as const)));
      while (pending.length) {
        const versionId = pending.shift()!;
        if (visited.has(versionId)) continue;
        visited.add(versionId);
        const version = versions.get(versionId);
        if (!version) continue;
        if (!histories.has(version.sessionId)) histories.set(version.sessionId, exportHistory(store, version.sessionId));
        if (!reviews.has(version.sessionId)) reviews.set(version.sessionId, store.listArtifactReviews(version.sessionId));
        const [history, assessments] = await Promise.all([histories.get(version.sessionId)!, reviews.get(version.sessionId)!]);
        const review = assessments.filter((item) => item.artifactVersionId === version.id && item.status === "completed").toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
        if (!review) continue;
        const claims = new Set((history.claims ?? []).filter((claim) => claim.reviewRunId === review.id).map((claim) => claim.id));
        const evidence = new Set((history.evidenceLinks ?? []).filter((link) => claims.has(link.claimId)).map((link) => link.evidenceItemId));
        const sources = (history.evidenceItems ?? []).flatMap((item) => {
          if (!evidence.has(item.id) || item.origin.kind !== "artifact") return [];
          const origin = item.origin;
          const dependency = availableArtifacts.find((artifact) => artifact.id === origin.artifactId)?.versions.find((candidate) => candidate.version === origin.artifactVersion);
          if (!dependency) { omissions.push(`artifact:${origin.artifactId}:validation evidence version ${origin.artifactVersion} is unavailable`); return []; }
          return [dependency.id];
        });
        const expanded = latestArtifactClosure(availableArtifacts, scopedArtifacts, [...necessaryVersionIds, ...sources]);
        for (const id of expanded) if (!necessaryVersionIds.has(id)) pending.push(id);
        necessaryVersionIds = expanded;
      }
    }
    const artifacts = level === "complete" ? scopedArtifacts : availableArtifacts.flatMap((artifact) => {
      const versions = artifact.versions.filter((version) => necessaryVersionIds.has(version.id));
      if (!versions.length) return [];
      for (const version of versions) {
        if (!sessions.some((session) => session.id === version.sessionId)) {
          const owner = availableSessions.find((session) => session.id === version.sessionId && (!session.researchSnapshot || session.researchSnapshot.state === "ready"));
          if (owner) sessions.push(owner);
          else omissions.push(`artifact:${version.id}:source session is unavailable`);
        }
        for (const input of version.inputArtifactVersionIds) if (!necessaryVersionIds.has(input)) omissions.push(`artifact:${version.id}:input version ${input} is unavailable`);
      }
      return [{ ...artifact, currentVersion: Math.max(...versions.map((version) => version.version)), versions }];
    });
    const sessionRecords: ExportSessionRecord[] = [];
    for (const session of sessions) {
      const messages = await store.readMessages(session.id);
      const runs = await store.listSessionRuns(session.id);
      const workspaceFiles = await listWorkspaceFiles(store, session.id, true);
      const workspace = [];
      const workspaceProvenance = [];
      for (const file of workspaceFiles) {
        const provenance = store.getWorkspaceFileProvenance(session.id, file.path);
        if (provenance) workspaceProvenance.push(provenance);
        try {
          const bytes = await readFile(resolveWorkspaceFile(store.workspacePath(session.id), file.path));
          const objectPath = await addObject(bytes, "evidence");
          workspace.push({ ...file, objectPath });
        } catch (error) {
          omissions.push(`workspace:${session.id}:${file.path}:${error instanceof Error ? error.message : "unreadable"}`);
        }
      }
      const validations = {
        artifactReviews: await store.listArtifactReviews(session.id),
        reviews: await store.listReviews(session.id),
        reviewerAuditTasks: await store.listReviewerAuditTasks(session.id),
        reviewFeedback: await store.listReviewFeedback(session.id),
      };
      const history = await exportHistory(store, session.id);
      const runEvents = await Promise.all(runs.map(async (run) => ({ runId: run.id, streams: await store.exportRunStreams(session.id, run.id) })));
      const view = await sessionTrajectory(store, session.id, new AbortController().signal);
      const details = [];
      for (const entry of [...view.index.entries, ...(view.index.untimedEntries ?? [])]) {
        const detail = await view.detail(entry.id);
        if (!detail) throw new Error(`Missing trajectory detail: ${entry.id}`);
        details.push(detail);
      }
      const trajectory: PackageTrajectory = { index: view.index, details, runIds: runs.map((run) => run.id) };
      sessionRecords.push({
        ...history, session: { ...session, settingsOverrides: undefined }, messages, runs,
        artifactAnnotations: store.listArtifactAnnotations(session.id),
        ...(runEvents ? { runEvents } : {}), trajectory, workspace, workspaceProvenance, validations,
      });
    }
    const artifactObjectPaths = new Map<string, string>();
    for (const artifact of artifacts) {
      for (const version of artifact.versions) {
        try {
          artifactObjectPaths.set(version.id, await addObject(await provenanceRecorder.cas.read(version.content.hash), "artifact"));
        } catch (error) {
          omissions.push(`artifact:${version.id}:${error instanceof Error ? error.message : "unreadable"}`);
        }
      }
    }
    const packagedArtifacts = artifacts.map((artifact) => ({
      ...artifact,
      versions: artifact.versions.map((version) => ({ ...version, objectPath: artifactObjectPaths.get(version.id) })),
    }));
    let memoryGraph: MemoryGraphSnapshot | undefined;
    if (memoryGraphEnabled()) {
      try { memoryGraph = await memoryGraphClient.exportSnapshot(sessions.map((session) => session.id)); }
      catch { omissions.push("Scientific memory could not be exported because the memory graph service is unavailable."); }
    }

    const artifactVersionIds = idSet(packagedArtifacts.flatMap((artifact) => artifact.versions.map((version) => version.id)));
    const selectedArtifacts = packagedArtifacts.map((artifact) => ({ ...artifact, versions: artifact.versions.map((version) => ({ ...version,
      ...(level === "necessary" && version.baseVersionId && !artifactVersionIds.has(version.baseVersionId) ? { baseVersionId: undefined } : {}),
    })) }));
    const selectedSessionRecords = sessionRecords.map((record) => {
      const filterFiles = (paths: Set<string>) => ({ workspace: record.workspace.filter((file) => paths.has(file.path)), workspaceProvenance: record.workspaceProvenance.filter((file) => paths.has(file.file.path)) });
      if (level === "complete") return { ...record, ...filterFiles(selectedFiles ?? new Set(record.workspace.map((file) => file.path))) };
      const localVersions = selectedArtifacts.flatMap((artifact) => artifact.versions.filter((version) => version.sessionId === record.session.id));
      const executionIds = new Set(localVersions.flatMap((version) => version.executionRunIds));
      const turnIds = new Set(localVersions.flatMap((version) => version.turnId ? [version.turnId] : []));
      const latestRun = record.runs.filter((run) => run.status === "completed").toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.queueOrder - b.queueOrder).at(-1);
      if (latestRun) turnIds.add(latestRun.id);
      const latestExecution = (record.executionRuns ?? []).filter((run) => run.status === "succeeded").toSorted((a, b) => a.finishedAt.localeCompare(b.finishedAt)).at(-1);
      if (latestExecution) { executionIds.add(latestExecution.id); turnIds.add(latestExecution.turnId); }
      const relevantPaths = new Set(localVersions.flatMap((version) => version.sourcePath ? [version.sourcePath] : []));
      for (const file of record.workspaceProvenance) {
        const revision = file.currentRevision;
        if (revision.origin === "upload" || revision.artifactVersionIds.some((id) => artifactVersionIds.has(id)) || revision.runId && turnIds.has(revision.runId) || revision.executionRunId && executionIds.has(revision.executionRunId)) relevantPaths.add(file.file.path);
      }
      for (const run of record.executionRuns ?? []) if (executionIds.has(run.id)) for (const path of [...run.createdFiles, ...run.modifiedFiles]) relevantPaths.add(path);
      // Ordinary scripts/JSON are selected by provenance, never excluded simply by extension.
      const workspacePaths = selectedFiles ?? relevantPaths;
      const selectedWorkspace = filterFiles(workspacePaths);
      const workspaceProvenance = selectedWorkspace.workspaceProvenance.map((file) => {
        const currentRevision = { ...file.currentRevision, parentRevisionId: undefined, artifactVersionIds: file.currentRevision.artifactVersionIds.filter((id) => artifactVersionIds.has(id)) };
        if (currentRevision.executionRunId) executionIds.add(currentRevision.executionRunId);
        if (currentRevision.runId) turnIds.add(currentRevision.runId);
        return { ...file, currentRevision, revisions: [currentRevision], artifacts: file.artifacts.filter((link) => artifactVersionIds.has(link.versionId)), lineage: [] };
      });
      const lastReviews = new Map<string, ArtifactReviewRun>();
      for (const review of record.validations.artifactReviews.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (review.artifactVersionId && artifactVersionIds.has(review.artifactVersionId) && review.status === "completed") lastReviews.set(review.artifactVersionId, review);
      }
      const reviews = record.validations.reviews.filter((review) => turnIds.has(review.turnId));
      const validations = { artifactReviews: [...lastReviews.values()], reviews, reviewerAuditTasks: [], reviewFeedback: [] };
      const reviewIds = new Set([...reviews, ...validations.artifactReviews].map((review) => review.id));
      for (const claim of record.claims ?? []) if (reviewIds.has(claim.reviewRunId)) turnIds.add(claim.turnId);
      const evidenceIds = new Set((record.evidenceLinks ?? []).filter((link) => (record.claims ?? []).some((claim) => claim.id === link.claimId && reviewIds.has(claim.reviewRunId))).map((link) => link.evidenceItemId));
      for (const item of record.evidenceItems ?? []) if (evidenceIds.has(item.id)) {
        turnIds.add(item.turnId);
        if (item.origin.kind === "execution") executionIds.add(item.origin.executionRunId);
      }
      for (const run of record.executionRuns ?? []) if (executionIds.has(run.id)) turnIds.add(run.turnId);
      const runs = record.runs.filter((run) => turnIds.has(run.id));
      const runIds = new Set(runs.map((run) => run.id));
      const history = necessaryHistory(record, turnIds, executionIds, reviewIds);
      const agentIds = new Set([`main:${record.session.id}`, ...(history.subagents ?? []).map((child) => `subagent:${child.id}`)]);
      const trajectory = trimTrajectory(record.trajectory, runIds);
      trajectory.index.agents = trajectory.index.agents.filter((agent) => agentIds.has(agent.id));
      trajectory.index.entries = trajectory.index.entries.filter((entry) => agentIds.has(entry.agentId));
      trajectory.index.untimedEntries = trajectory.index.untimedEntries?.filter((entry) => agentIds.has(entry.agentId));
      trajectory.index.historicalEntries = trajectory.index.untimedEntries;
      trajectory.details = trajectory.details.filter((detail) => agentIds.has(detail.entry.agentId));
      return { ...record, ...history, runs, workspace: selectedWorkspace.workspace, workspaceProvenance, validations, runEvents: [], trajectory };
    });
    const filteredMemoryGraph = level === "complete" ? memoryGraph : filterMemoryGraph(memoryGraph, selectedArtifacts, new Set(selectedSessionRecords.flatMap((record) => (record.executionRuns ?? []).map((run) => run.id))));
    const included = countExport(selectedSessionRecords, selectedArtifacts, filteredMemoryGraph);
    const totalArtifacts = level === "complete" ? packagedArtifacts : scopedArtifacts;
    const total = countExport(sessionRecords, totalArtifacts, memoryGraph);
    const omitted = Object.fromEntries(Object.entries(total).map(([key, value]) => [key, Math.max(0, value - included[key as keyof ResearchPackageCounts])])) as unknown as ResearchPackageCounts;
    const inheritedLimitations = sessions.some((session) => session.researchSnapshot?.exportLevel === "necessary" || session.researchSnapshot?.historyLimited);
    const fullHistory = level === "complete" && !inheritedLimitations;
    const exportProfile: ResearchPackageExportProfile = { level, included, omitted, capabilities: {
      historicalVersions: fullHistory, fullTrajectory: fullHistory, fullExecutionHistory: fullHistory, fullMemoryGraph: fullHistory && Boolean(memoryGraph), continuation: true,
    } };
    const countLabels: Record<keyof ResearchPackageCounts, string> = { sessions: "会话", messages: "消息", artifacts: "产物", artifactVersions: "产物版本", workspaceFiles: "工作区文件", executionRuns: "执行记录", runs: "任务", runEvents: "原始运行事件", trajectoryEvents: "轨迹事件", fileRevisions: "文件修订", memoryNodes: "科学记忆节点", memoryEdges: "科学记忆关系" };
    for (const [kind, count] of Object.entries(omitted)) if (count) omissions.push(`导出范围省略${countLabels[kind as keyof ResearchPackageCounts]}：${count}。`);
    if (inheritedLimitations) omissions.push("来源包含必要导入的研究记录；完整导出仅包含当前已有内容，无法补回原包省略的历史。");
    if (level === "necessary") omissions.push("必要导出保留当前结果及依赖证据；不包含完整历史版本、思考分片和原始事件流。直接溯源引用的执行代码和日志保留原文，其余历史执行默认不带。继续研究仅复制本包已有内容。");
    const usedEnvironments = new Set(selectedSessionRecords.flatMap((record) => [...(record.executionRuns ?? []), ...(record.shellExecutions ?? []).flatMap((row) => row.result ? [row.result] : [])].flatMap((run) => run.environmentRevisionId ? [run.environmentRevisionId] : [])));
    const environmentRevisions = store.listEnvironmentRevisions().filter((revision) => usedEnvironments.has(revision.id));
    const needed = new Set([...selectedSessionRecords.flatMap((record) => record.workspace.map((file) => file.objectPath)), ...selectedArtifacts.flatMap((artifact) => artifact.versions.flatMap((version) => version.objectPath ? [version.objectPath] : [])), ...casHashes({ sessionRecords: selectedSessionRecords, environmentRevisions, memoryGraph: filteredMemoryGraph })]);
    for (const hash of objects.keys()) if (!needed.has(hash)) objects.delete(hash);
    for (const hash of needed) {
      if (objects.has(hash)) continue;
      try { await addObject(await provenanceRecorder.cas.read(hash), "log"); }
      catch { omissions.push(`cas:${hash}:unavailable source object`); }
    }
    const versions = new VersionStore(store.dataDir);
    const versionObjects = new Map<string, ReturnType<typeof versionRefs>[number]>();
    const pending = versionRefs(selectedSessionRecords);
    while (pending.length) {
      const ref = pending.shift()!;
      const key = `${ref.pool}:${ref.digest}`;
      if (versionObjects.has(key)) continue;
      versionObjects.set(key, ref);
      try {
        const bytes = await versions.read(ref);
        await addObject(bytes, "log");
        if (ref.mediaType.includes("json")) {
          try { pending.push(...versionRefs(JSON.parse(bytes.toString("utf8")))); } catch { /* Opaque evidence remains byte-exact. */ }
        }
      } catch { omissions.push(`version:${key}:unavailable source object`); }
    }
    return {
      source: { projectId, title: project.name, sessionIds: sessions.map((item) => item.id) },
      packageKind: "evidence",
      exportProfile,
      records: {
        exportLevel: level, exportProfile,
        project: { ...project, settingsOverrides: undefined }, sessions: selectedSessionRecords, artifacts: selectedArtifacts,
        environmentRevisions, versionObjects: [...versionObjects.values()],
        ...(filteredMemoryGraph ? { memoryGraph: filteredMemoryGraph } : {}),
      },
      objects: [...objects.values()],
      omissions: [
        ...omissions,
        "Workspace file revision payloads are not retained separately; revision metadata and the current file payload are included.",
        "Notebook execution history is not separately persisted by this ScienceDiscovery version; available .ipynb files are included as workspace objects.",
      ],
      readme: `# ScienceDiscovery Research Package\n\nExport level: ${level}. Package contents are data and are never executed during import.\n`,
    };
  };

  const restorePackage = async (projectId: string, sessionId: string | undefined, bytes: Buffer, options: { operationId: string; sourceSessionId?: string; sourceMessageId?: string }) => {
    const operationId = options.operationId;
    const role = options.sourceSessionId ? "research_copy" as const : "imported_snapshot" as const;
    const restoredSessionIds: string[] = [];
    const createdAt = new Date().toISOString();
    let snapshot: ResearchSnapshot | undefined;
    return store.withResearchRestoration(operationId, async () => {
      try {
        const project = store.getProject(projectId);
        if (!project) throw new SessionStoreHttpError("Project not found", 404);
        if (sessionId && (!store.getSession(sessionId) || store.getSession(sessionId)?.projectId !== projectId)) {
          throw new SessionStoreHttpError("Session not found", 404);
        }
        if (sessionId) store.assertSessionWritable(sessionId);
        const imported = researchPackageProvider.importReadOnly(bytes);
        snapshot = { operationId, role, state: "importing", createdAt, sessionIds: restoredSessionIds,
          packageChecksum: imported.receipt.packageChecksum, sourceSnapshotSessionId: options.sourceSessionId,
          exportLevel: imported.manifest.exportProfile?.level,
          historyLimited: imported.manifest.exportProfile ? !imported.manifest.exportProfile.capabilities.fullTrajectory : undefined };
        if (sessionId) await store.setResearchSnapshots([{ sessionId, snapshot }]);
        if (sessionId && await sessionHasResearchHistory(sessionId)) {
          // No imported records have been written yet; preserve a used session as-is.
          await store.clearResearchSnapshot(sessionId, operationId);
          throw new SessionStoreHttpError("Research package import is only available for a new empty session", 409);
        }
        const packageRecords = imported.records as {
          sessions?: Array<{ session?: { id?: string }; runs?: SessionRun[]; subagents?: PackageHistory["subagents"]; trajectory?: PackageTrajectory; workspace?: Array<{ path: string; objectPath?: string }> }>;
          memoryGraph?: MemoryGraphSnapshot;
        };
        if (packageRecords.memoryGraph?.nodes.length) {
          try { await memoryGraphClient.validateSnapshot([...(imported.manifest.source.sessionIds ?? [])], packageRecords.memoryGraph); }
          catch (error) { throw new SessionStoreHttpError(`Cannot restore scientific memory; no session data was imported. ${error instanceof Error ? error.message : "Memory graph is unavailable"}`, 503); }
        }
        for (const source of packageRecords.sessions ?? []) {
          if (source.trajectory) {
            try { validatePackageTrajectory(source.trajectory, source.session?.id ?? "", new Set((source.runs ?? []).map((run) => run.id)),
              new Set([`main:${source.session?.id}`, ...(source.subagents ?? []).map((child) => `subagent:${child.id}`)])); }
            catch { throw new SessionStoreHttpError("Invalid research package trajectory", 400); }
          }
          for (const file of source.workspace ?? []) {
            try {
              resolveWorkspaceFile(resolve(store.dataDir, "package-preflight"), file.path);
            } catch {
              throw new SessionStoreHttpError(`Invalid workspace path: ${file.path}`, 400);
            }
            if (file.objectPath && !imported.objects.has(file.objectPath.replace(/^objects\//, ""))) {
              throw new SessionStoreHttpError(`Missing workspace object: ${file.path}`, 400);
            }
          }
        }
        const root = resolve(store.dataDir, "projects", project.id, "research-packages", imported.receipt.packageChecksum, operationId);
        await mkdir(resolve(root, "objects"), { recursive: true });
        await writeFile(resolve(root, "manifest.json"), `${JSON.stringify(imported.manifest, null, 2)}\n`, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        await writeFile(resolve(root, "records.json"), `${JSON.stringify(imported.records, null, 2)}\n`, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        await writeFile(resolve(root, "README.md"), imported.readme, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        for (const [hash, object] of imported.objects) {
          await writeFile(resolve(root, "objects", hash), object, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
        }
        const receipt = {
          ...imported.receipt,
          projectId: project.id,
          ...(sessionId ? { sessionId } : {}),
          storagePath: `projects/${project.id}/research-packages/${imported.receipt.packageChecksum}/${operationId}`,
        };
        await writeFile(resolve(root, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });

        type PackageSessionRecord = PackageHistory & {
          session?: Partial<Session> & { id?: string; title?: string };
          messages?: ChatMessage[];
          artifactAnnotations?: ArtifactAnnotation[];
          runs?: SessionRun[];
          trajectory?: PackageTrajectory;
          runEvents?: Array<{ runId: string; events?: SessionRunEvent[]; streams?: Array<{ streamId: string; events: SessionRunEvent[] }> }>;
          workspace?: Array<{ path: string; objectPath?: string; size?: number; modifiedAt?: string }>;
          workspaceProvenance?: WorkspaceFileProvenance[];
          validations?: { artifactReviews?: ArtifactReviewRun[]; reviews?: ReviewRun[]; reviewerAuditTasks?: ReviewerAuditTask[]; reviewFeedback?: ReviewFeedback[] };
        };
        type PackageArtifactVersion = ScientificArtifactVersion & { objectPath?: string };
        type PackageArtifact = ScientificArtifact & { versions?: PackageArtifactVersion[] };
        const records = imported.records as {
          sessions?: PackageSessionRecord[];
          artifacts?: PackageArtifact[];
          environmentRevisions?: EnvironmentRevision[];
          memoryGraph?: MemoryGraphSnapshot;
          versionObjects?: ReturnType<typeof versionRefs>;
        };
        const sourceSessions = Array.isArray(records.sessions) ? records.sessions : [];
        const targetBySource = new Map<string, string>();
        const omissions = [...imported.receipt.omissions];
        if (!records.memoryGraph) omissions.push("This package contains no scientific memory snapshot; export it again from the source with the updated version to restore scientific memory.");
        const ids = new ResearchPackageIds();
        ids.values.set(imported.manifest.source.projectId, projectId);
        for (let index = 0; index < Math.max(sourceSessions.length, 1); index++) {
          const sourceId = sourceSessions[index]?.session?.id ?? `package-session-${index}`;
          if (ids.values.has(sourceId)) throw new SessionStoreHttpError("Duplicate package session id", 400);
          ids.values.set(sourceId, index === 0 && sessionId ? sessionId : randomUUID());
        }
        for (const artifact of records.artifacts ?? []) {
          ids.id(artifact.id);
          for (const version of artifact.versions ?? []) ids.id(version.id);
        }
        // CAS addresses are content identities and remain stable across imports.
        for (const object of imported.objects.values()) await provenanceRecorder.cas.put(Buffer.from(object));
        const versions = new VersionStore(store.dataDir);
        for (const ref of records.versionObjects ?? []) {
          const object = imported.objects.get(ref.digest.slice(7));
          if (object) await versions.put(ref.pool, Buffer.from(object), ref.mediaType);
        }
        const environmentRevisions = (records.environmentRevisions ?? []).map((revision) => ({
          ...revision, id: ids.id(revision.id), environmentId: ids.id(revision.environmentId),
        }));
        if (environmentRevisions.length) await store.replaceScientificEnvironmentCatalog([], environmentRevisions, "research-package");

        for (let index = 0; index < Math.max(sourceSessions.length, 1); index += 1) {
          const source = sourceSessions[index];
          const sourceId = source?.session?.id ?? `package-session-${index}`;
          let target = index === 0 && sessionId ? store.getSession(sessionId) : undefined;
          if (target && target.projectId !== projectId) throw new SessionStoreHttpError("Session not found", 404);
          if (!target) {
            const sourceTitle = source?.session?.title?.trim() || imported.manifest.source.title || "导入研究";
            const title = options.sourceSessionId ? createLocalSessionTitle(`${Array.from(sourceTitle).slice(0, 15).join("")} · ${options.sourceMessageId ? "分支" : "继续研究"}`) : sourceTitle;
            target = await store.createSession(projectId, title, {}, {}, { allowUnconfiguredModel: true,
              researchSnapshot: snapshot, restorationSessionId: ids.id(sourceId) });
          }
          // An import into a newly-created empty session reuses that session as
          // the first package session. Keep its title in sync with the package so
          // the imported conversation is identifiable in the session list.
          const importedTitle = source?.session?.title?.trim() || imported.manifest.source.title?.trim();
          if (index === 0 && sessionId && importedTitle) {
            target = await store.updateSession(target.id, { title: importedTitle });
          }
          targetBySource.set(sourceId, target.id);
          ids.values.set(sourceId, target.id);
          restoredSessionIds.push(target.id);
          if (source?.messages?.length) await store.restoreMessages(target.id, remapMessages(source.messages, ids, projectId));
          for (const run of source?.runs ?? []) {
            if (!run.settingsSnapshot || !run.prompt) {
              omissions.push(`run:${run.id}:missing settings snapshot`);
              continue;
            }
            try {
              const terminalStatus = ["queued", "running", "blocked"].includes(run.status) ? "cancelled" : run.status;
              await store.restoreSessionRun(target.id, {
                ...remapRunEvent(run, ids),
                references: remapReferences(run.references, ids, projectId) ?? [],
                id: ids.id(run.id),
                ...(terminalStatus === "cancelled" ? { error: run.error ?? "Run was not resumed when importing a research package.", finishedAt: run.finishedAt ?? new Date().toISOString() } : {}),
                sessionId: target.id,
                status: terminalStatus,
                notificationDelivery: undefined,
              });
            } catch (error) {
              omissions.push(`run:${run.id}:${error instanceof Error ? error.message : "restore failed"}`);
            }
          }
          for (const file of source?.workspace ?? []) {
            const objectPath = file.objectPath?.replace(/^objects\//, "");
            const object = objectPath ? imported.objects.get(objectPath) : undefined;
            if (!object) {
              omissions.push(`workspace:${target.id}:${file.path}:missing object`);
              continue;
            }
            const workspaceRoot = store.workspacePath(target.id);
            const targetPath = resolveWorkspaceFile(workspaceRoot, file.path);
            await withWorkspaceMutation(new VersionStore(store.dataDir), workspaceRoot, async () => {
              await mkdir(dirname(targetPath), { recursive: true });
              await writeFile(targetPath, object);
              if (file.modifiedAt && Number.isFinite(Date.parse(file.modifiedAt))) {
                const time = new Date(file.modifiedAt);
                await utimes(targetPath, time, time);
              }
              const provenance = source?.workspaceProvenance?.find((item) => item.file?.path === file.path);
              await store.recordWorkspaceFileRevision(target.id, {
                contentHash: sha256(object),
                mode: "write",
                modifiedAt: (await stat(targetPath)).mtime.toISOString(),
                origin: provenance?.currentRevision?.origin ?? "system",
                originMeta: { kind: "research-package-import", sourcePackageChecksum: imported.receipt.packageChecksum },
                path: file.path,
                size: object.byteLength,
              });
            }, { kind: "research-package-import" });
          }
          if (source) await restoreHistory(store, target.id, source, ids);
        }

        const artifactIdMap = new Map<string, string>();
        const versionIdMap = new Map<string, string>();
        for (const artifact of Array.isArray(records.artifacts) ? records.artifacts : []) {
          const targetSessionId = targetBySource.get(artifact.createdInSessionId) ?? restoredSessionIds[0];
          if (!targetSessionId) {
            omissions.push(`artifact:${artifact.id}:no target session`);
            continue;
          }
          let targetArtifactId = artifactIdMap.get(artifact.id);
          let baseVersionId: string | undefined;
          for (const version of [...(artifact.versions ?? [])].sort((left, right) => left.version - right.version)) {
            // v1 exports used the CAS hash without an explicit objectPath.
            const objectPath = (version.objectPath ?? version.content.hash).replace(/^objects\//, "");
            const object = objectPath ? imported.objects.get(objectPath) : undefined;
            if (!object) {
              omissions.push(`artifact:${version.id}:missing object`);
              continue;
            }
            const content = await provenanceRecorder.cas.put(Buffer.from(object));
            const dependencies = version.inputArtifactVersionIds.map((id) => versionIdMap.get(id)).filter((id): id is string => Boolean(id));
            const restored = await store.createArtifactVersion({
              ...(targetArtifactId && baseVersionId ? { artifactId: targetArtifactId, baseVersionId } : {}),
              content,
              description: artifact.description,
              executionRunIds: version.executionRunIds.map((id) => ids.id(id)),
              inputArtifactVersionIds: dependencies,
              kind: artifact.kind,
              logicalName: artifact.logicalName || artifact.name,
              mediaType: version.mediaType,
              origin: artifact.origin,
              originMeta: artifact.originMeta,
              references: remapReferences(version.references, ids, projectId) ?? [],
              restorationIds: { artifactId: ids.id(artifact.id), versionId: ids.id(version.id) },
              sessionId: targetBySource.get(version.sessionId) ?? targetSessionId,
              sourcePath: version.sourcePath,
              title: artifact.title,
              turnId: ids.optional(version.turnId),
              forceNewArtifact: true,
            });
            targetArtifactId = restored.artifact.id;
            baseVersionId = restored.version.id;
            artifactIdMap.set(artifact.id, targetArtifactId);
            versionIdMap.set(version.id, restored.version.id);
            ids.values.set(artifact.id, targetArtifactId);
            ids.values.set(version.id, restored.version.id);
          }
        }

        for (const artifact of records.artifacts ?? []) {
          for (const version of artifact.versions ?? []) {
            const restoredId = versionIdMap.get(version.id);
            const targetId = targetBySource.get(version.sessionId) ?? restoredSessionIds[0];
            if (!restoredId || !targetId) continue;
            const dependencies = (version.inputArtifactVersionIds ?? []).flatMap((id) => versionIdMap.has(id) ? [versionIdMap.get(id)!] : []);
            await store.restoreArtifactVersionLineage(targetId, restoredId, dependencies, version.createdAt, version.version, version.baseVersionId ? versionIdMap.get(version.baseVersionId) : undefined);
          }
          const restoredArtifactId = artifactIdMap.get(artifact.id);
          const owner = targetBySource.get(artifact.createdInSessionId) ?? restoredSessionIds[0];
          if (restoredArtifactId && owner) await store.restoreArtifactMetadata(owner, restoredArtifactId, artifact);
        }

        for (const [index, source] of sourceSessions.entries()) {
          const sourceId = source?.session?.id ?? `package-session-${index}`;
          const targetId = targetBySource.get(sourceId);
          if (targetId) {
            await store.restoreArtifactAnnotations(targetId, (source.artifactAnnotations ?? []).map((annotation) => ({
              ...remapRunEvent(annotation, ids), id: ids.id(annotation.id), sessionId: targetId,
            })));
            await restoreEvidenceItems(store, targetId, source, ids);
            const trajectory = source.trajectory ? remapPackageTrajectory(source.trajectory, targetId, ids) : emptyPackageTrajectory(targetId);
            trajectory.access = importedTrajectoryAccess(source, (streamId) => streamId === "main" ? `main:${targetId}`
              : streamId.startsWith("subagent-") ? `subagent:${ids.id(streamId.slice("subagent-".length))}` : undefined, imported.objects);
            await writePackageTrajectory(store.dataDir, targetId, trajectory);
            for (const entry of source.runEvents ?? []) {
              const runId = ids.id(entry.runId);
              if (!await store.getSessionRun(targetId, runId)) continue;
              for (const stream of entry.streams ?? [{ streamId: "main", events: entry.events ?? [] }]) {
                const streamId = remapRunStreamId(stream.streamId, ids);
                await store.restoreRunStream(targetId, runId, streamId, stream.events.map((event) => ({ ...event, event: remapRunEvent(event.event, ids) })));
              }
            }
            const snapshots = [];
            for (const provenance of source.workspaceProvenance ?? []) {
              if (!source.workspace?.some((file) => file.path === provenance.file.path)) continue;
              const restored = remapWorkspaceProvenance(provenance, targetId, projectId, ids, versionIdMap);
              restored.currentRevision.modifiedAt = (await stat(resolveWorkspaceFile(store.workspacePath(targetId), restored.file.path))).mtime.toISOString();
              snapshots.push(restored);
            }
            if (snapshots.length) await store.restoreWorkspaceFileProvenance(targetId, snapshots);
          }
          const validations = source.validations;
          if (!targetId || !validations) continue;
          const importedIds = new Set<string>();
          for (const review of validations.artifactReviews ?? []) {
            const artifactId = review.artifactId ? artifactIdMap.get(review.artifactId) : undefined;
            const artifactVersionId = review.artifactVersionId ? versionIdMap.get(review.artifactVersionId) : undefined;
            if ((review.artifactId && !artifactId) || (review.artifactVersionId && !artifactVersionId)) continue;
            try {
              await store.appendArtifactReview({ ...remapRunEvent(review, ids), id: ids.id(review.id), sessionId: targetId, ...(artifactId ? { artifactId } : {}), ...(artifactVersionId ? { artifactVersionId } : {}) });
              importedIds.add(review.id);
            } catch (error) { omissions.push(`artifact-review:${review.id}:${error instanceof Error ? error.message : "restore failed"}`); }
          }
          for (const review of validations.reviews ?? []) {
            try { await store.appendReview({ ...remapRunEvent(review, ids), id: ids.id(review.id), promptManifestId: ids.optional(review.promptManifestId), turnId: ids.id(review.turnId), sessionId: targetId }); }
            catch (error) { omissions.push(`review:${review.id ?? "unknown"}:${error instanceof Error ? error.message : "restore failed"}`); }
          }
          for (const task of validations.reviewerAuditTasks ?? []) {
            try {
              await store.createReviewerAuditTask({ ...remapRunEvent(task, ids), id: ids.id(task.id), sessionId: targetId, status: ["queued", "running"].includes(task.status) ? "cancelled" : task.status, artifactVersionIds: task.artifactVersionIds.map((id) => versionIdMap.get(id)).filter((id): id is string => Boolean(id)), ...(task.reviewIds ? { reviewIds: task.reviewIds.filter((id) => importedIds.has(id)).map((id) => ids.id(id)) } : {}) });
            } catch (error) { omissions.push(`review-task:${task.id}:${error instanceof Error ? error.message : "restore failed"}`); }
          }
          for (const feedback of validations.reviewFeedback ?? []) {
            try {
              await store.appendReviewFeedback({ ...remapRunEvent(feedback, ids), id: ids.id(feedback.id), sessionId: targetId, status: feedback.status === "ready" ? "dismissed" : feedback.status, artifactVersionIds: feedback.artifactVersionIds.map((id) => versionIdMap.get(id)).filter((id): id is string => Boolean(id)), reviewIds: feedback.reviewIds.filter((id) => importedIds.has(id)).map((id) => ids.id(id)) });
            } catch (error) { omissions.push(`review-feedback:${feedback.id}:${error instanceof Error ? error.message : "restore failed"}`); }
          }
        }

        if (records.memoryGraph?.nodes.length) {
          try {
            await memoryGraphClient.importSnapshot(restoredSessionIds, remapMemorySnapshot(records.memoryGraph, targetBySource, projectId, ids, artifactIdMap));
          } catch (error) {
            omissions.push(`Scientific memory restore failed: ${error instanceof Error ? error.message : "unavailable"}. The original snapshot is retained in the imported package.`);
          }
        }

        const restoreFailures = omissions.filter((item) => !imported.receipt.omissions.includes(item) && !item.startsWith("This package contains no scientific memory snapshot"));
        if (options.sourceSessionId && restoreFailures.length) throw new Error(`研究记录复制未完整恢复：${restoreFailures.join("; ")}`);
        const captured = await buildResearchPackageInput(projectId, undefined, "complete", undefined, new Set(restoredSessionIds));
        const captureFailures = (captured.omissions ?? []).filter((item) => !imported.receipt.omissions.includes(item)
          && (/^(workspace:|artifact:|cas:|version:)/.test(item)
            || records.memoryGraph && /^Scientific memory could not/.test(item)));
        if (captureFailures.length) throw new Error(`无法保存完整研究快照：${captureFailures.join("; ")}`);
        if (records.memoryGraph && !(captured.records as { memoryGraph?: MemoryGraphSnapshot }).memoryGraph) {
          throw new Error("无法核对已恢复的科学记忆，请检查图谱服务后重新导入。");
        }
        if (options.sourceSessionId) verifyResearchCopy(imported.records, captured.records, ids, targetBySource, projectId);
        // Internal capture preserves every restored record; it must not relabel a necessary package as complete.
        const sourceProfile = imported.manifest.exportProfile;
        const frozen = researchPackageProvider.export({ ...captured, omissions, exportProfile: sourceProfile,
          records: { ...captured.records as Record<string, unknown>, exportLevel: sourceProfile?.level, exportProfile: sourceProfile } });
        await writeFile(resolve(root, "snapshot.sdresearch"), frozen.bytes, { flag: "wx" });
        const continuationAvailable = restoreFailures.length === 0;
        const result = {
          ...imported.receipt,
          artifactCount: artifactIdMap.size,
          continuationAvailable,
          sessionMapping: Object.fromEntries(targetBySource),
          importedSessionIds: restoredSessionIds,
          omissions,
          projectId: project.id,
          ...(sessionId ? { sessionId } : {}),
          storagePath: receipt.storagePath,
        };
        await writeFile(resolve(root, "receipt.json"), `${JSON.stringify(result, null, 2)}\n`);
        // Publish only after all fallible snapshot/receipt writes complete.
        await store.setResearchSnapshots(restoredSessionIds.map((id) => ({ sessionId: id,
          ...(options.sourceMessageId && options.sourceSessionId ? { conversationBranch: {
            sourceSessionId: options.sourceSessionId, sourceMessageId: options.sourceMessageId,
            inheritedMessageId: ids.id(options.sourceMessageId), createdAt, omissions,
          } } : {}), snapshot: { ...snapshot!,
          state: "ready", sessionIds: [...restoredSessionIds], storagePath: `${receipt.storagePath}/snapshot.sdresearch`,
          sourceSnapshotSessionId: options.sourceSessionId ? [...targetBySource].find(([, target]) => target === id)?.[0] : undefined,
          snapshotChecksum: frozen.receipt.packageChecksum, continuationAvailable, omissions } })));
        return result;
      } catch (error) {
        const affected = store.researchOperationSessions(operationId);
        if (affected.length) await store.setResearchSnapshots(affected.map((session) => ({ sessionId: session.id,
          snapshot: { ...session.researchSnapshot!, state: "failed", continuationAvailable: false } })));
        throw error;
      }
    });
  };

  const activeImports = new Set<string>();
  const persistImportedResearchPackage = async (projectId: string, sessionId: string | undefined, bytes: Buffer) => {
    const key = sessionId ?? projectId;
    if (activeImports.has(key)) throw new SessionStoreHttpError("Research package import is already in progress", 409);
    activeImports.add(key);
    try { return await restorePackage(projectId, sessionId, bytes, { operationId: randomUUID() }); }
    finally { activeImports.delete(key); }
  };
  const continuations = createContinuationOperations({ store, memoryGraphClient }, researchPackageProvider, restorePackage,
    async (sourceSessionId, messageId) => {
      const source = store.getSession(sourceSessionId);
      if (!source) throw new SessionStoreHttpError("Session not found", 404);
      const input = await buildResearchPackageInput(source.projectId, sourceSessionId, "complete");
      return researchPackageProvider.export(await buildConversationBranch(input, sourceSessionId, messageId,
        (hash) => provenanceRecorder.cas.read(hash), countExport)).bytes;
    });
  return { buildResearchPackageInput, persistImportedResearchPackage, ...continuations };
}

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
import { mkdir, readFile, writeFile, stat, lstat, readdir, utimes } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RefStore, VersionStore, withWorkspaceMutation } from "@sciencediscovery/cas";
import { researchPackagePlugin } from "@sciencediscovery/research-package/plugin";
import { createResearchPackageAsync, estimateResearchPackageBytes, jsonBytes, jsonDigest, sha256, type ExportInput, type ImportedResearchPackage, type ResearchPackageCounts, type ResearchPackageExportProfile } from "@sciencediscovery/research-package";
import { contextBlocks, type TrajectoryDetail, type TrajectoryEntry } from "@sciencediscovery/trajectory";
import type { MemoryGraphSnapshot } from "@sciencediscovery/memory";
import type { ArtifactAnnotation, ArtifactReviewRun, ChatMessage, EnvironmentRevision, ResearchSnapshot, ReviewRun, ReviewerAuditTask, ReviewFeedback, ScientificArtifact, ScientificArtifactVersion, ScientificMemorySummary, Session, SessionRun, SessionRunEvent, WorkspaceFileProvenance } from "@sciencediscovery/schema";
import { createLocalSessionTitle } from "@sciencediscovery/schema";
import { resolveWorkspaceFile } from "@sciencediscovery/workspace";
import { listWorkspaceFiles } from "./artifacts/index.js";
import { SessionStoreHttpError } from "./store.js";
import type { createPlatformServices } from "./bootstrap/platform.js";
import { createContinuationOperations } from "./research-continuations.js";
import { buildConversationBranch } from "./conversation-branches.js";
import { verifyResearchCopy } from "./research-snapshot-integrity.js";
import { ResearchExportPreviews } from "./research-export-previews.js";
import { ResearchPackageExports, type ResearchPackageExportOptions } from "./research-package-exports.js";
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

function summarizeScientificMemory(graph: MemoryGraphSnapshot | undefined): ScientificMemorySummary | undefined {
  if (!graph) return undefined;
  const nodeGroups = new Map<string, { count: number; examples: string[] }>();
  for (const node of graph.nodes) {
    const labels = node.labels.length ? node.labels : ["Unknown"];
    const candidate = [node.properties.name, node.properties.title, node.properties.goal, node.properties.summary, node.properties.description]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
    for (const label of labels) {
      const group = nodeGroups.get(label) ?? { count: 0, examples: [] };
      group.count += 1;
      if (candidate) {
        const example = candidate.replace(/\s+/g, " ").trim().slice(0, 180);
        if (example && !group.examples.includes(example) && group.examples.length < 3) group.examples.push(example);
      }
      nodeGroups.set(label, group);
    }
  }
  const edgeGroups = new Map<string, number>();
  for (const edge of graph.edges) edgeGroups.set(edge.type, (edgeGroups.get(edge.type) ?? 0) + 1);
  return {
    kind: "summary", nodeCount: graph.nodes.length, relationshipCount: graph.edges.length,
    nodeTypes: [...nodeGroups].sort(([left], [right]) => left.localeCompare(right)).map(([label, group]) => ({ label, ...group })),
    relationshipTypes: [...edgeGroups].sort(([left], [right]) => left.localeCompare(right)).map(([type, count]) => ({ type, count })),
  };
}

export function createResearchSnapshots({ store, memoryGraphClient, memoryGraphEnabled, provenanceRecorder }: Ports, sessionHasResearchHistory: (sessionId: string) => Promise<boolean>) {
  const researchPackageProvider = researchPackagePlugin.create().contribution.provider;
  const previewDependencies = new Map<string, Set<string>>();
  const previewRevision = async (projectId: string, sessionId?: string): Promise<string> => {
    if (!store.getProject(projectId)) throw new SessionStoreHttpError("Project not found", 404);
    if (sessionId && store.getSession(sessionId)?.projectId !== projectId) throw new SessionStoreHttpError("Session not found", 404);
    // Track the dependency closure discovered by the necessary preview. Changes
    // to project artifact metadata also invalidate it, so new dependencies are
    // discovered without recursively scanning every unrelated workspace.
    const dependencies = sessionId ? previewDependencies.get(sessionId) : undefined;
    const sessions = store.researchSessions(projectId).filter((session) =>
      (!session.researchSnapshot || session.researchSnapshot.state === "ready") &&
      (!sessionId || session.id === sessionId || dependencies?.has(session.id)));
    const files: Array<[string, number, number, number]> = [];
    const inspect = async (path: string): Promise<void> => {
      let info;
      try { info = await lstat(path); }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return; throw error; }
      if (info.isSymbolicLink()) return;
      if (info.isDirectory()) { for (const child of await readdir(path)) await inspect(resolve(path, child)); }
      else if (info.isFile()) files.push([path, info.size, info.mtimeMs, info.ctimeMs]);
    };
    for (const session of sessions) {
      for (const path of store.sessionDataPaths(session.id)) await inspect(path);
      for (const agent of [`main:${session.id}`, ...store.listSubagents(session.id).map((child) => `subagent:${child.id}`)])
        await inspect(resolve(store.dataDir, "trajectories", Buffer.from(agent).toString("base64url")));
    }
    files.sort((a, b) => a[0].localeCompare(b[0]));
    const refs = await RefStore.open(new VersionStore(store.dataDir));
    let heads;
    try { heads = sessions.flatMap((session) => [`main:${session.id}`, ...store.listSubagents(session.id).map((child) => `subagent:${child.id}`)])
      .flatMap((agent) => refs.list(`agents/${encodeURIComponent(agent)}/`)); }
    finally { refs.close(); }
    return jsonDigest({ project: store.getProject(projectId), sessions, files, heads,
      artifacts: store.listProjectArtifacts(projectId), revisions: sessions.map((session) => [...store.snapshotWorkspaceFileRevisions(session.id)]),
      subagents: sessions.map((session) => store.listSubagents(session.id)),
      shells: sessions.map((session) => store.shellExecutions.snapshot(session.id)), environments: store.listEnvironmentRevisions(),
      memory: [memoryGraphEnabled(), memoryGraphClient.snapshotRevision(sessions.map((session) => session.id))] });
  };
  const buildResearchPackageInput = async (projectId: string, sessionId?: string, level: "necessary" | "complete" = "necessary", selectedFiles?: Set<string>, cohort?: Set<string>, previewObjectSizes?: Map<string, number>, includeFullTrajectory = true, includeFullMemoryGraph = true): Promise<ExportInput> => {
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
    const addPreviewObject = (path: string, size: number, kind: "artifact" | "evidence") => {
      previewObjectSizes!.set(path, size);
      objects.set(path, { path, bytes: new Uint8Array(), kind });
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
    const trajectoryViews = new Map<string, Awaited<ReturnType<typeof sessionTrajectory>>>();
    const hydrateTrajectory = async (record: ExportSessionRecord, entries: TrajectoryEntry[]) => {
      const view = trajectoryViews.get(record.session.id)!;
      const details: TrajectoryDetail[] = [];
      for (const entry of entries) {
        const detail = await view.detail(entry.id);
        if (!detail) throw new Error(`Missing trajectory detail: ${entry.id}`);
        details.push(detail);
      }
      return { ...record.trajectory, details };
    };
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
          // A size preview needs metadata, not every workspace payload or its checksum.
          // Unknown hashes get a preview-only identity; the real export still hashes the bytes.
          const objectPath = previewObjectSizes
            ? addPreviewObject(provenance?.currentRevision.contentHash ?? sha256(Buffer.from(JSON.stringify([session.id, file.path, file.modifiedAt, file.size]))), file.size, "evidence")
            : await addObject(await readFile(resolveWorkspaceFile(store.workspacePath(session.id), file.path)), "evidence");
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
      trajectoryViews.set(session.id, view);
      const trajectory: PackageTrajectory = { index: view.index, details: [], runIds: runs.map((run) => run.id) };
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
          artifactObjectPaths.set(version.id, previewObjectSizes
            ? addPreviewObject(version.content.hash, version.content.size, "artifact")
            : await addObject(await provenanceRecorder.cas.read(version.content.hash), "artifact"));
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
    const inheritedMemorySummary = sessions.map((session) => session.researchSnapshot?.scientificMemorySummary).find((summary): summary is ScientificMemorySummary => Boolean(summary));
    const availableMemoryGraph = memoryGraph?.nodes.length === 0 && inheritedMemorySummary ? undefined : memoryGraph;

    const artifactVersionIds = idSet(packagedArtifacts.flatMap((artifact) => artifact.versions.map((version) => version.id)));
    const selectedArtifacts = packagedArtifacts.map((artifact) => ({ ...artifact, versions: artifact.versions.map((version) => ({ ...version,
      ...(level === "necessary" && version.baseVersionId && !artifactVersionIds.has(version.baseVersionId) ? { baseVersionId: undefined } : {}),
    })) }));
    const selectedSessionRecords: ExportSessionRecord[] = [];
    for (const record of sessionRecords) {
      const filterFiles = (paths: Set<string>) => ({ workspace: record.workspace.filter((file) => paths.has(file.path)), workspaceProvenance: record.workspaceProvenance.filter((file) => paths.has(file.file.path)) });
      if (level === "complete") {
        const completeTrajectory = includeFullTrajectory
          ? await hydrateTrajectory(record, [...record.trajectory.index.entries, ...(record.trajectory.index.untimedEntries ?? [])])
          : { ...record.trajectory, index: { ...record.trajectory.index, entries: [], untimedEntries: [], historicalEntries: [] }, details: [], runIds: record.trajectory.runIds };
        selectedSessionRecords.push({ ...record, ...filterFiles(selectedFiles ?? new Set(record.workspace.map((file) => file.path))),
          trajectory: completeTrajectory });
        continue;
      }
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
      const trajectory = trimTrajectory(await hydrateTrajectory(record, necessaryTrajectoryEntries(record.trajectory, runIds)), runIds);
      trajectory.index.agents = trajectory.index.agents.filter((agent) => agentIds.has(agent.id));
      trajectory.index.entries = trajectory.index.entries.filter((entry) => agentIds.has(entry.agentId));
      trajectory.index.untimedEntries = trajectory.index.untimedEntries?.filter((entry) => agentIds.has(entry.agentId));
      trajectory.index.historicalEntries = trajectory.index.untimedEntries;
      trajectory.details = trajectory.details.filter((detail) => agentIds.has(detail.entry.agentId));
      selectedSessionRecords.push({ ...record, ...history, runs, workspace: selectedWorkspace.workspace, workspaceProvenance, validations, runEvents: [], trajectory });
    }
    const filteredMemoryGraph = level === "complete" ? availableMemoryGraph : filterMemoryGraph(availableMemoryGraph, selectedArtifacts, new Set(selectedSessionRecords.flatMap((record) => (record.executionRuns ?? []).map((run) => run.id))));
    const packageMemoryGraph = level === "complete" && !includeFullMemoryGraph ? undefined : filteredMemoryGraph;
    const memoryGraphSummary = packageMemoryGraph ? undefined : summarizeScientificMemory(filteredMemoryGraph) ?? inheritedMemorySummary;
    if (level === "complete" && !includeFullMemoryGraph && memoryGraphSummary) omissions.push("科学记忆以摘要形式保留；完整科学记忆节点和关系未包含在本包中。");
    if (level === "complete" && includeFullMemoryGraph && !filteredMemoryGraph && inheritedMemorySummary) omissions.push("来源只有科学记忆摘要，无法从摘要恢复完整节点和关系。");
    const included = countExport(selectedSessionRecords, selectedArtifacts, packageMemoryGraph);
    const totalArtifacts = level === "complete" ? packagedArtifacts : scopedArtifacts;
    const total = countExport(sessionRecords, totalArtifacts, availableMemoryGraph);
    if (memoryGraphSummary) { total.memoryNodes = memoryGraphSummary.nodeCount; total.memoryEdges = memoryGraphSummary.relationshipCount; }
    const omitted = Object.fromEntries(Object.entries(total).map(([key, value]) => [key, Math.max(0, value - included[key as keyof ResearchPackageCounts])])) as unknown as ResearchPackageCounts;
    const inheritedLimitations = sessions.some((session) => session.researchSnapshot?.exportLevel === "necessary" || session.researchSnapshot?.historyLimited);
    const fullHistory = level === "complete" && !inheritedLimitations;
    const exportProfile: ResearchPackageExportProfile = { level, included, omitted, capabilities: {
      historicalVersions: fullHistory, fullTrajectory: fullHistory && includeFullTrajectory, fullExecutionHistory: fullHistory, fullMemoryGraph: fullHistory && Boolean(packageMemoryGraph), continuation: true,
    } };
    const countLabels: Record<keyof ResearchPackageCounts, string> = { sessions: "会话", messages: "消息", artifacts: "产物", artifactVersions: "产物版本", workspaceFiles: "工作区文件", executionRuns: "执行记录", runs: "任务", runEvents: "原始运行事件", trajectoryEvents: "轨迹事件", fileRevisions: "文件修订", memoryNodes: "科学记忆节点", memoryEdges: "科学记忆关系" };
    for (const [kind, count] of Object.entries(omitted)) if (count) omissions.push(`导出范围省略${countLabels[kind as keyof ResearchPackageCounts]}：${count}。`);
    if (inheritedLimitations) omissions.push("来源包含必要导入的研究记录；完整导出仅包含当前已有内容，无法补回原包省略的历史。");
    if (level === "necessary") omissions.push("必要导出保留当前结果及依赖证据；不包含完整历史版本、思考分片和原始事件流。直接溯源引用的执行代码和日志保留原文，其余历史执行默认不带。继续研究仅复制本包已有内容。");
    const usedEnvironments = new Set(selectedSessionRecords.flatMap((record) => [...(record.executionRuns ?? []), ...(record.shellExecutions ?? []).flatMap((row) => row.result ? [row.result] : [])].flatMap((run) => run.environmentRevisionId ? [run.environmentRevisionId] : [])));
    const environmentRevisions = store.listEnvironmentRevisions().filter((revision) => usedEnvironments.has(revision.id));
    const needed = new Set([...selectedSessionRecords.flatMap((record) => record.workspace.map((file) => file.objectPath)), ...selectedArtifacts.flatMap((artifact) => artifact.versions.flatMap((version) => version.objectPath ? [version.objectPath] : [])), ...casHashes({ sessionRecords: selectedSessionRecords, environmentRevisions, memoryGraph: packageMemoryGraph })]);
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
        ...(packageMemoryGraph ? { memoryGraph: packageMemoryGraph } : {}),
        ...(memoryGraphSummary ? { memoryGraphSummary } : {}),
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

  const exportPreviews = new ResearchExportPreviews(previewRevision, async ({ projectId, sessionId, level, selectedFiles, includeFullTrajectory, includeFullMemoryGraph }, revision) => {
      const objectSizes = new Map<string, number>();
      const input = await buildResearchPackageInput(projectId, sessionId, level, selectedFiles, undefined, objectSizes, includeFullTrajectory, includeFullMemoryGraph);
      const records = input.records as { sessions?: Array<{ session: { id: string }; workspace?: Array<{ path: string }> }> };
      if (sessionId && level === "necessary" && !selectedFiles) {
        previewDependencies.set(sessionId, new Set(records.sessions?.map((record) => record.session.id)));
        if (previewDependencies.size > 192) previewDependencies.delete(previewDependencies.keys().next().value!);
      }
      const selectedPaths = new Set(records.sessions?.find((record) => record.session.id === sessionId)?.workspace?.map((file) => file.path));
      return {
        revision, estimatedBytes: estimateResearchPackageBytes(input, objectSizes), estimateKind: "uncompressed" as const,
        files: sessionId ? (await listWorkspaceFiles(store, sessionId, true)).map((file) => ({ ...file, selected: selectedPaths.has(file.path) })) : [],
        exportProfile: input.exportProfile, omissions: [...(input.omissions ?? [])],
      };
  });
  const previewResearchPackage = (projectId: string, sessionId: string | undefined, level: "necessary" | "complete", selectedFiles?: Set<string>, includeFullTrajectory = true, includeFullMemoryGraph = true) =>
    exportPreviews.get({ projectId, sessionId, level, selectedFiles, includeFullTrajectory, includeFullMemoryGraph });
  const packageExports = new ResearchPackageExports(resolve(store.dataDir, "research-package-exports"), previewRevision, async (options: ResearchPackageExportOptions) => {
    const input = await buildResearchPackageInput(options.projectId, options.sessionId, options.level,
      options.selectedFiles ? new Set(options.selectedFiles) : undefined, undefined, undefined,
      options.includeFullTrajectory, options.includeFullMemoryGraph);
    return (await createResearchPackageAsync(input)).bytes;
  });

  const restorePackage = async (projectId: string, sessionId: string | undefined, bytes: Buffer, options: { operationId: string; sourceSessionId?: string; sourceMessageId?: string; imported?: ImportedResearchPackage }) => {
    const operationId = options.operationId;
    const role = options.sourceSessionId ? "research_copy" as const : "imported_snapshot" as const;
    const restoredSessionIds: string[] = [];
    const createdAt = new Date().toISOString();
    let snapshot: ResearchSnapshot | undefined;
    const isFatalRestoreOmission = (item: string) => /^(workspace:.*:missing object|artifact:.*:(missing object|no target session)|cas:.*:unavailable|version:.*:unavailable|Scientific memory restore failed|无法保存完整研究快照|无法核对已恢复的科学记忆)/.test(item);
    return store.withResearchRestoration(operationId, async () => {
      try {
        const project = store.getProject(projectId);
        if (!project) throw new SessionStoreHttpError("Project not found", 404);
        if (sessionId && (!store.getSession(sessionId) || store.getSession(sessionId)?.projectId !== projectId)) {
          throw new SessionStoreHttpError("Session not found", 404);
        }
        if (sessionId) store.assertSessionWritable(sessionId);
        const imported = options.imported ?? researchPackageProvider.importReadOnly(bytes);
        snapshot = { operationId, role, state: "importing", createdAt, sessionIds: restoredSessionIds,
          packageChecksum: imported.receipt.packageChecksum, sourceSnapshotSessionId: options.sourceSessionId,
          exportLevel: imported.manifest.exportProfile?.level,
          historyLimited: imported.manifest.exportProfile ? !imported.manifest.exportProfile.capabilities.fullTrajectory : undefined,
          scientificMemorySummary: (imported.records as { memoryGraphSummary?: ScientificMemorySummary }).memoryGraphSummary };
        if (sessionId) await store.setResearchSnapshots([{ sessionId, snapshot }]);
        if (sessionId && await sessionHasResearchHistory(sessionId)) {
          // No imported records have been written yet; preserve a used session as-is.
          await store.clearResearchSnapshot(sessionId, operationId);
          throw new SessionStoreHttpError("Research package import is only available for a new empty session", 409);
        }
        const packageRecords = imported.records as {
          sessions?: Array<{ session?: { id?: string }; runs?: SessionRun[]; subagents?: PackageHistory["subagents"]; trajectory?: PackageTrajectory; workspace?: Array<{ path: string; objectPath?: string }> }>;
          memoryGraph?: MemoryGraphSnapshot;
          memoryGraphSummary?: ScientificMemorySummary;
        };
        // Validate the graph after it has been remapped to the newly restored
        // session ids. Validating against the package's original ids here is
        // incorrect for a normal import: those ids do not exist in the target
        // project and used to make an otherwise valid import fail before any
        // session data was written.
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
        await writeFile(resolve(root, "records.json"), jsonBytes(imported.records), { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        await writeFile(resolve(root, "README.md"), imported.readme, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        const importedObjects = [...imported.objects];
        for (let offset = 0; offset < importedObjects.length; offset += 16) {
          await Promise.all(importedObjects.slice(offset, offset + 16).map(async ([hash, object]) => {
            await writeFile(resolve(root, "objects", hash), object, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "EEXIST") throw error;
            });
          }));
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
          memoryGraphSummary?: ScientificMemorySummary;
          versionObjects?: ReturnType<typeof versionRefs>;
        };
        const sourceSessions = Array.isArray(records.sessions) ? records.sessions : [];
        const targetBySource = new Map<string, string>();
        const omissions = [...imported.receipt.omissions];
        if (!records.memoryGraph && !records.memoryGraphSummary) omissions.push("This package contains no scientific memory snapshot; export it again from the source with the updated version to restore scientific memory.");
        else if (!records.memoryGraph && records.memoryGraphSummary) omissions.push("This package contains a scientific memory summary, not the full graph; its nodes and relationships cannot be restored.");
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
        const casObjects = [...imported.objects.values()];
        for (let offset = 0; offset < casObjects.length; offset += 16) {
          await Promise.all(casObjects.slice(offset, offset + 16).map((object) => provenanceRecorder.cas.put(Buffer.from(object))));
        }
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
          const workspaceFiles = (source?.workspace ?? []).flatMap((file) => {
            const objectPath = file.objectPath?.replace(/^objects\//, "");
            const object = objectPath ? imported.objects.get(objectPath) : undefined;
            if (!object) {
              omissions.push(`workspace:${target.id}:${file.path}:missing object`);
              return [];
            }
            return [{ file, object }];
          });
          if (workspaceFiles.length) {
            const workspaceRoot = store.workspacePath(target.id);
            // Acquire the workspace mutation lease once per restored session.
            // Large evidence packages often contain many files; taking the
            // lease and publishing the workspace head for every file made
            // import time grow linearly with avoidable transaction overhead.
            await withWorkspaceMutation(new VersionStore(store.dataDir), workspaceRoot, async () => {
              const revisions: Array<Parameters<typeof store.recordWorkspaceFileRevisions>[1][number]> = [];
              for (const { file, object } of workspaceFiles) {
                const targetPath = resolveWorkspaceFile(workspaceRoot, file.path);
                await mkdir(dirname(targetPath), { recursive: true });
                await writeFile(targetPath, object);
                if (file.modifiedAt && Number.isFinite(Date.parse(file.modifiedAt))) {
                  const time = new Date(file.modifiedAt);
                  await utimes(targetPath, time, time);
                }
                const provenance = source?.workspaceProvenance?.find((item) => item.file?.path === file.path);
                revisions.push({
                  contentHash: sha256(object),
                  mode: "write",
                  modifiedAt: (await stat(targetPath)).mtime.toISOString(),
                  origin: provenance?.currentRevision?.origin ?? "system",
                  originMeta: { kind: "research-package-import", sourcePackageChecksum: imported.receipt.packageChecksum },
                  path: file.path,
                  size: object.byteLength,
                });
              }
              await store.recordWorkspaceFileRevisions(target.id, revisions);
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
            const remappedMemory = remapMemorySnapshot(records.memoryGraph, targetBySource, projectId, ids, artifactIdMap);
            await memoryGraphClient.importSnapshot(restoredSessionIds, remappedMemory);
            if (!options.sourceSessionId) await memoryGraphClient.validateSnapshot(restoredSessionIds, remappedMemory);
          } catch (error) {
            omissions.push(`Scientific memory restore failed: ${error instanceof Error ? error.message : "unavailable"}. The original snapshot is retained in the imported package.`);
          }
        }

        // Necessary packages intentionally omit historical runs, versions and
        // event streams. Those omissions are part of the package contract and
        // must not make an otherwise usable writable copy fail. Only missing
        // immutable payloads or a failed memory restore are fatal.
        const restoreFailures = omissions.filter((item) => !imported.receipt.omissions.includes(item)
          && !item.startsWith("This package contains no scientific memory snapshot")
          && isFatalRestoreOmission(item));
        if (options.sourceSessionId && restoreFailures.length) throw new Error(`研究记录复制未完整恢复：${restoreFailures.join("; ")}`);
        let frozenBytes: Uint8Array = bytes;
        let frozenChecksum = imported.receipt.packageChecksum;
        if (options.sourceSessionId) {
          const captured = await buildResearchPackageInput(projectId, undefined, "complete", undefined, new Set(restoredSessionIds));
          const captureFailures = (captured.omissions ?? []).filter((item) => !imported.receipt.omissions.includes(item) && isFatalRestoreOmission(item));
          if (captureFailures.length) throw new Error(`无法保存完整研究快照：${captureFailures.join("; ")}`);
          if (records.memoryGraph && !(captured.records as { memoryGraph?: MemoryGraphSnapshot }).memoryGraph) {
            throw new Error("无法核对已恢复的科学记忆，请检查图谱服务后重新导入。");
          }
          verifyResearchCopy(imported.records, captured.records, ids, targetBySource, projectId);
          // Internal capture preserves every restored record; it must not relabel a necessary package as complete.
          const sourceProfile = imported.manifest.exportProfile;
          const frozen = researchPackageProvider.export({ ...captured, omissions, exportProfile: sourceProfile,
            records: { ...captured.records as Record<string, unknown>, exportLevel: sourceProfile?.level, exportProfile: sourceProfile } });
          frozenBytes = frozen.bytes;
          frozenChecksum = frozen.receipt.packageChecksum;
        }
        // A read-only import already has an immutable, checksummed package.
        // Reusing its bytes avoids rebuilding and recompressing a large archive.
        await writeFile(resolve(root, "snapshot.sdresearch"), frozenBytes, { flag: "wx" });
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
          snapshotChecksum: frozenChecksum, continuationAvailable, omissions } })));
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
  const persistImportedResearchPackage = async (projectId: string, sessionId: string | undefined, bytes: Buffer, imported?: ImportedResearchPackage) => {
    const key = sessionId ?? projectId;
    if (activeImports.has(key)) throw new SessionStoreHttpError("Research package import is already in progress", 409);
    activeImports.add(key);
    try { return await restorePackage(projectId, sessionId, bytes, { operationId: randomUUID(), imported }); }
    finally { activeImports.delete(key); }
  };
  const continuations = createContinuationOperations({ store, memoryGraphClient }, restorePackage,
    async (sourceSessionId, messageId) => {
      const source = store.getSession(sourceSessionId);
      if (!source) throw new SessionStoreHttpError("Session not found", 404);
      const input = await buildResearchPackageInput(source.projectId, sourceSessionId, "complete");
      return researchPackageProvider.export(await buildConversationBranch(input, sourceSessionId, messageId,
        (hash) => provenanceRecorder.cas.read(hash), countExport)).bytes;
    });
  return { buildResearchPackageInput, exportPreviews, packageExports, previewResearchPackage, persistImportedResearchPackage, ...continuations };
}

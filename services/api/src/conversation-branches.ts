// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { sha256, type ExportInput, type ResearchPackageCounts } from "@sciencediscovery/research-package";
import type { MemoryGraphSnapshot } from "@sciencediscovery/memory";
import type { EnvironmentRevision, WorkspaceFileProvenance } from "@sciencediscovery/schema";
import type { TrajectoryEntry } from "@sciencediscovery/trajectory";
import { casHashes, versionRefs } from "./research-package-history.js";
import type { ExportArtifact, ExportSessionRecord } from "./research-snapshots.js";
import { SessionStoreHttpError } from "./store.js";

/** Select evidence by recorded ownership AND time. Current bytes are never an old revision. */
export async function buildConversationBranch(
  input: ExportInput, sourceId: string, messageId: string,
  readCas: (hash: string) => Promise<Uint8Array>,
  count: (sessions: ExportSessionRecord[], artifacts: ExportArtifact[], graph?: MemoryGraphSnapshot) => ResearchPackageCounts,
): Promise<ExportInput> {
  const records = structuredClone(input.records) as {
    sessions: ExportSessionRecord[]; artifacts: ExportArtifact[]; memoryGraph?: MemoryGraphSnapshot;
    environmentRevisions?: EnvironmentRevision[]; versionObjects?: ReturnType<typeof versionRefs>;
    [key: string]: unknown;
  };
  const source = records.sessions.find((row) => row.session.id === sourceId);
  if (!source) throw new SessionStoreHttpError("Source session not found", 404);
  const index = source.messages.findIndex((row) => row.id === messageId);
  const message = source.messages[index];
  const selectedRun = source.runs.find((run) => run.assistantMessageId === messageId);
  if (!message || message.role !== "assistant" || message.kind && message.kind !== "message"
    || !message.content.trim() || selectedRun && selectedRun.status !== "completed") {
    throw new SessionStoreHttpError("只能从已完成的正式回复创建分支。", 409);
  }
  const cutoff = Date.parse(selectedRun?.finishedAt ?? message.createdAt);
  if (!Number.isFinite(cutoff)) throw new SessionStoreHttpError("回复缺少有效的历史时间，无法安全分叉。", 409);
  const before = (time: unknown) => typeof time === "string" && Number.isFinite(Date.parse(time)) && Date.parse(time) <= cutoff;
  const omissions = [...(input.omissions ?? [])];
  const omit = (text: string) => { if (!omissions.includes(text)) omissions.push(text); };
  source.messages = source.messages.slice(0, index + 1);
  const messageIds = new Set(source.messages.map((row) => row.id));
  const allTurnIds = new Set(source.runs.map((run) => run.id));
  source.runs = source.runs.filter((run) => Boolean(run.assistantMessageId && messageIds.has(run.assistantMessageId)
    || run.userMessageId && messageIds.has(run.userMessageId) && before(run.finishedAt))
    && !["queued", "running", "blocked"].includes(run.status));
  const turnIds = new Set(source.runs.map((run) => run.id));
  source.executionRuns = source.executionRuns?.filter((run) => turnIds.has(run.turnId) && before(run.finishedAt));
  const executionIds = new Set(source.executionRuns?.map((run) => run.id));
  source.promptManifests = source.promptManifests?.filter((row) => turnIds.has(row.turnId) && before(row.finishedAt));
  source.shellExecutions = source.shellExecutions?.filter((row) => turnIds.has(row.turnId)
    && ["completed", "failed", "cancelled"].includes(row.state) && before(row.finishedAt));
  source.subagents = source.subagents?.filter((row) => turnIds.has(row.parentTurnId) && before(row.finishedAt));
  source.artifactDerivations = source.artifactDerivations?.filter((row) => turnIds.has(row.turnId)
    && row.executionRunIds.every((id) => executionIds.has(id)));
  records.artifacts = records.artifacts.flatMap((artifact) => {
    const versions = artifact.versions.filter((version) => version.sessionId === sourceId && (!version.turnId || turnIds.has(version.turnId)) && before(version.createdAt));
    if (!versions.length) return [];
    // Metadata can be edited after publication. The immutable version is authoritative here.
    const latest = versions.toSorted((a, b) => b.version - a.version)[0]!;
    return [{ ...artifact, title: undefined, description: undefined,
      updatedAt: latest.createdAt, currentVersion: latest.version, versions }];
  });
  const versionIds = new Set(records.artifacts.flatMap((artifact) => artifact.versions.map((version) => version.id)));
  // Cross-session dependencies cannot be represented by copying a later owner session.
  for (const artifact of records.artifacts) for (const version of artifact.versions) {
    if (version.inputArtifactVersionIds.some((id) => !versionIds.has(id))) {
      omit("部分跨会话依赖未随分支复制；原始会话仍保留完整来源。");
      version.inputArtifactVersionIds = version.inputArtifactVersionIds.filter((id) => versionIds.has(id));
    }
    if (version.baseVersionId && !versionIds.has(version.baseVersionId)) version.baseVersionId = undefined;
  }
  source.artifactAnnotations = source.artifactAnnotations.filter((row) => versionIds.has(row.artifactVersionId) && before(row.createdAt));
  const annotationIds = new Set(source.artifactAnnotations.map((row) => row.id));
  for (const row of source.messages) row.annotations = row.annotations?.filter((annotation) => annotationIds.has(annotation.id));
  for (const row of source.runs) row.annotationIds = row.annotationIds.filter((id) => annotationIds.has(id));
  source.validations.artifactReviews = source.validations.artifactReviews.filter((row) => versionIds.has(row.artifactVersionId) && before(row.finishedAt));
  source.validations.reviews = source.validations.reviews.filter((row) => turnIds.has(row.turnId) && before(row.finishedAt));
  // Review queues are mutable. Copy terminal assessments, never live queue/control state.
  if (source.validations.reviewerAuditTasks.length || source.validations.reviewFeedback.length) omit("可变的审阅队列和反馈状态未复制；已完成且可确认时间的审阅结果已保留。");
  source.validations.reviewerAuditTasks = [];
  source.validations.reviewFeedback = [];
  const reviewIds = new Set([...source.validations.artifactReviews, ...source.validations.reviews].map((row) => row.id));
  source.claims = source.claims?.filter((row) => turnIds.has(row.turnId) && reviewIds.has(row.reviewRunId));
  const claimIds = new Set(source.claims?.map((row) => row.id));
  source.evidenceItems = source.evidenceItems?.filter((row) => turnIds.has(row.turnId) && before(row.createdAt)
    && (row.origin.kind !== "execution" || executionIds.has(row.origin.executionRunId)));
  const evidenceIds = new Set(source.evidenceItems?.map((row) => row.id));
  source.evidenceLinks = source.evidenceLinks?.filter((row) => claimIds.has(row.claimId) && (!row.createdAt || before(row.createdAt))
    && (!row.evidenceItemId || evidenceIds.has(row.evidenceItemId)));
  source.runEvents = source.runEvents?.filter((row) => turnIds.has(row.runId)).map((row) => ({ ...row,
    streams: row.streams.map((stream) => ({ ...stream, events: stream.events.filter((event) => before(event.createdAt)) })),
  }));
  const agents = new Set([`main:${sourceId}`, ...(source.subagents ?? []).map((row) => `subagent:${row.id}`)]);
  // JiuwenSwarm runId is an agent trajectory ID, not a SessionRun ID. Join
  // contexts and agent runs through explicit request ownership, including later
  // requests so a reused run ID cannot accidentally import their untimed data.
  const parents = new Map(source.trajectory.index.agents.map((agent) => [agent.id, agent.parentRunId]));
  const allEntries = [...source.trajectory.index.entries,
    ...(source.trajectory.index.untimedEntries ?? source.trajectory.index.historicalEntries ?? [])];
  const runOwners = new Map<string, Set<string>>(), contextOwners = new Map<string, Set<string>>();
  const key = (agent: string, id: string) => JSON.stringify([agent, id]);
  const directOwner = (entry: TrajectoryEntry) => entry.requestExecutionId
    ?? (entry.runId && allTurnIds.has(entry.runId) ? entry.runId : parents.get(entry.agentId));
  const remember = (map: Map<string, Set<string>>, scope: string, owner: string) => {
    const owners = map.get(scope) ?? new Set<string>();
    owners.add(owner); map.set(scope, owners);
  };
  for (const entry of allEntries) {
    const owner = directOwner(entry);
    if (!owner) continue;
    if (entry.runId) remember(runOwners, key(entry.agentId, entry.runId), owner);
    if (entry.contextId) remember(contextOwners, key(entry.agentId, entry.contextId), owner);
  }
  for (const entry of allEntries) {
    const owners = entry.runId ? runOwners.get(key(entry.agentId, entry.runId)) : undefined;
    if (entry.contextId && owners?.size === 1 && !contextOwners.has(key(entry.agentId, entry.contextId))) {
      remember(contextOwners, key(entry.agentId, entry.contextId), [...owners][0]!);
    }
  }
  const belongs = (entry: TrajectoryEntry) => {
    if (!agents.has(entry.agentId) || entry.timestamp && !before(entry.timestamp) || entry.endTime && !before(entry.endTime)) return false;
    const direct = directOwner(entry);
    const owners = direct ? new Set([direct]) : (entry.contextId ? contextOwners.get(key(entry.agentId, entry.contextId)) : undefined)
      ?? (entry.runId ? runOwners.get(key(entry.agentId, entry.runId)) : undefined);
    if (!owners || owners.size !== 1) {
      omit("部分轨迹缺少可唯一核实的请求归属，未复制到分支；原会话中仍可查看。");
      return false;
    }
    return turnIds.has([...owners][0]!);
  };
  source.trajectory.index.entries = source.trajectory.index.entries.filter(belongs);
  source.trajectory.index.untimedEntries = (source.trajectory.index.untimedEntries ?? source.trajectory.index.historicalEntries ?? []).filter(belongs);
  source.trajectory.index.historicalEntries = source.trajectory.index.untimedEntries;
  source.trajectory.index.agents = source.trajectory.index.agents.filter((agent) => agents.has(agent.id));
  const entryIds = new Set([...source.trajectory.index.entries, ...source.trajectory.index.untimedEntries].map((entry) => entry.id));
  source.trajectory.details = source.trajectory.details.filter((detail) => entryIds.has(detail.entry.id));
  source.trajectory.runIds = [...turnIds];
  // Do not inherit an imported package's broader trajectory read authority.
  source.trajectory.access = undefined;

  const objects = new Map((input.objects ?? []).map((object) => [object.path.replace(/^objects\//, ""), object]));
  const available = async (hash: string) => {
    if (objects.has(hash)) return true;
    try {
      const bytes = await readCas(hash);
      if (sha256(bytes) !== hash) return false;
      objects.set(hash, { path: hash, bytes, kind: "evidence" });
      return true;
    } catch { return false; }
  };
  const workspace: ExportSessionRecord["workspace"] = [];
  const provenance: WorkspaceFileProvenance[] = [];
  for (const file of source.workspaceProvenance) {
    const revisions = file.revisions.filter((revision) => before(revision.createdAt)
      && (!revision.runId || turnIds.has(revision.runId))
      && (!revision.executionRunId || executionIds.has(revision.executionRunId)));
    const revision = [...revisions].reverse().toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
      || (b.publicationSequence ?? 0) - (a.publicationSequence ?? 0))[0];
    if (!revision) continue;
    if (!revision.contentHash || !await available(revision.contentHash)) {
      omit(`历史文件 ${file.file.path} 的原始内容已不可用，未复制当前版本代替。`);
      continue;
    }
    const kept = revisions.map((row) => ({ ...row, artifactVersionIds: row.artifactVersionIds.filter((id) => versionIds.has(id)) }));
    const ids = new Set(kept.map((row) => row.id));
    for (const row of kept) if (row.parentRevisionId && !ids.has(row.parentRevisionId)) row.parentRevisionId = undefined;
    const currentRevision = kept.find((row) => row.id === revision.id)!;
    workspace.push({ path: revision.path, objectPath: revision.contentHash, size: revision.size, modifiedAt: revision.modifiedAt });
    provenance.push({ ...file, currentRevision, revisions: kept,
      file: { ...file.file, currentRevisionId: revision.id, updatedAt: revision.createdAt },
      artifacts: file.artifacts.filter((row) => versionIds.has(row.versionId)),
      lineage: file.lineage.filter((row) => ids.has(row.revisionId)) });
  }
  if (source.workspace.some((file) => !source.workspaceProvenance.some((row) => row.file.path === file.path))) {
    omit("缺少历史修订凭据的工作区文件未复制；无法恢复已删除且没有保留内容的文件。");
  }
  source.workspace = workspace;
  source.workspaceProvenance = provenance;
  if (records.memoryGraph) {
    const versions = new Map<string, ExportArtifact["versions"][number]>(records.artifacts.flatMap((artifact) => artifact.versions.map((version) => [`${artifact.id}:${version.version}`, version] as const)));
    const executions = new Map(source.executionRuns?.map((run) => [run.id, run]));
    const files = new Map(provenance.map((file) => [file.file.id, file.currentRevision.contentHash]));
    const nodes = records.memoryGraph.nodes.filter((node) => {
      const p = node.properties;
      if (typeof p.artifact_id === "string") {
        const version = versions.get(`${p.artifact_id}:${p.version}`);
        return Boolean(version && version.content.hash === p.content_hash);
      }
      // Code nodes have started_at/finished_at, not created_at. Identity + byte hashes
      // tie the node to an immutable, retained execution even after package imports.
      if (node.labels.includes("Code")) {
        const run = executions.get(String(p.code_id ?? ""));
        return Boolean(run && p.code_hash === run.code.hash && p.stdout_hash === run.stdout.hash && p.stderr_hash === run.stderr.hash);
      }
      if (node.labels.includes("SourceFile")) return files.has(String(p.file_id)) && files.get(String(p.file_id)) === p.content_hash;
      // Other nodes (goals, papers, claims, tasks) are upserted in place, with no historical payload.
      return false;
    });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges = records.memoryGraph.edges.filter((edge) => {
      const from = byId.get(edge.source)?.properties, to = byId.get(edge.target)?.properties;
      if (!from || !to) return false;
      if (edge.type === "produces") return versions.get(`${to.artifact_id}:${to.version}`)?.executionRunIds.includes(String(from.code_id)) ?? false;
      if (edge.type === "input") {
        if (typeof from.file_id === "string" && executions.has(String(to.code_id))) return true;
        const input = versions.get(`${from.artifact_id}:${from.version}`);
        return Boolean(input && [...versions.values()].some((version) => version.executionRunIds.includes(String(to.code_id)) && version.inputArtifactVersionIds.includes(input.id)));
      }
      if (edge.type === "supersedes") {
        const version = versions.get(`${from.artifact_id}:${from.version}`), base = versions.get(`${to.artifact_id}:${to.version}`);
        return Boolean(version && base && version.baseVersionId === base.id);
      }
      return false;
    });
    if (nodes.length !== records.memoryGraph.nodes.length || edges.length !== records.memoryGraph.edges.length) {
      omit("科学记忆仅复制能按产物版本、执行记录和文件内容核实的节点及溯源关系；无历史版本的可变节点和关系未复制，避免混入后续研究。");
    }
    records.memoryGraph = { nodes, edges };
  }
  source.session.updatedAt = new Date(cutoff).toISOString();
  source.session.conversationBranch = undefined;
  records.sessions = [source];
  const environments = new Set([...(source.executionRuns ?? []), ...(source.shellExecutions ?? []).flatMap((row) => row.result ? [row.result] : [])]
    .flatMap((run) => run.environmentRevisionId ? [run.environmentRevisionId] : []));
  records.environmentRevisions = records.environmentRevisions?.filter((row) => environments.has(row.id));
  const neededRefs = new Map(versionRefs(source).map((ref) => [`${ref.pool}:${ref.digest}`, ref]));
  const queue = [...neededRefs.values()];
  while (queue.length) {
    const ref = queue.shift()!;
    const object = objects.get(ref.digest.slice(7));
    if (!object || !ref.mediaType.includes("json")) continue;
    try {
      for (const child of versionRefs(JSON.parse(Buffer.from(object.bytes).toString("utf8")))) {
        const key = `${child.pool}:${child.digest}`;
        if (!neededRefs.has(key)) { neededRefs.set(key, child); queue.push(child); }
      }
    } catch { /* Opaque payloads remain byte exact. */ }
  }
  records.versionObjects = [...neededRefs.values()];
  const needed = new Set([...workspace.map((file) => file.objectPath),
    ...records.artifacts.flatMap((artifact) => artifact.versions.flatMap((version) => version.objectPath ? [version.objectPath] : [])),
    ...casHashes(records), ...records.versionObjects.map((ref) => ref.digest.slice(7))]);
  const included = count([source], records.artifacts, records.memoryGraph);
  const original = input.exportProfile?.included ?? included;
  const omitted = Object.fromEntries(Object.entries(original).map(([key, value]) => [key, Math.max(0, value - included[key as keyof ResearchPackageCounts])])) as unknown as ResearchPackageCounts;
  const profile = { level: "complete" as const, included, omitted, capabilities: {
    ...input.exportProfile?.capabilities, historicalVersions: false, fullTrajectory: false,
    fullExecutionHistory: false, fullMemoryGraph: false, continuation: true,
  } };
  omit("分支仅包含所选回复及此前可核实的研究记录；原会话的后续消息和证据不在此分支中。");
  if (source.session.researchSnapshot?.historyLimited || input.exportProfile?.capabilities.fullTrajectory === false) {
    omit("来源证据包中已省略的历史内容无法通过会话分叉补回。");
  }
  records.exportProfile = profile;
  return { ...input, source: { ...input.source, sessionIds: [sourceId] }, records, exportProfile: profile,
    objects: [...objects].filter(([hash]) => needed.has(hash)).map(([, object]) => object), omissions };
}

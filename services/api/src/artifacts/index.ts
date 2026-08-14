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

import { createHash } from "node:crypto";

import { scanWorkspace } from "@science-agent/agent-runtime";
import { classifyScientificArtifact } from "@science-agent/schema";
import type {
  ArtifactVersionDiff,
  ArtifactVersionProvenance,
  CasObjectRef,
  ConnectorManifest,
  ExecutionRun,
  ScientificArtifactVersion,
  WorkspaceFile,
} from "@science-agent/schema";

import { MemoryGraphClient } from "../memory-graph.js";
import type { ArtifactProvenanceGraphResult } from "../memory-graph.js";
import { ProvenanceRecorder } from "../provenance.js";
import { SessionStore } from "../store.js";

export function classifyWorkspaceFilePreview(path: string): WorkspaceFile["previewKind"] {
  return classifyScientificArtifact(path);
}

export async function listWorkspaceFiles(store: SessionStore, sessionId: string): Promise<WorkspaceFile[]> {
  return (await scanWorkspace(store.workspacePath(sessionId))).map((file) => {
    const previewKind = classifyWorkspaceFilePreview(file.path);
    return { ...file, ...(previewKind ? { previewKind } : {}) };
  });
}

async function readProcessEnvironment(
  recorder: ProvenanceRecorder,
  envSnapshot: CasObjectRef | null | undefined,
): Promise<Record<string, string> | null> {
  if (!envSnapshot) return null;
  const parsed: unknown = JSON.parse((await recorder.cas.read(envSnapshot.hash)).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.values(parsed).some((value) => typeof value !== "string")) {
    throw new Error("Execution environment snapshot must be a JSON object with string values");
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, string>)
      .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  );
}

export async function artifactVersionProvenance(
  store: SessionStore,
  recorder: ProvenanceRecorder,
  memoryGraphClient: MemoryGraphClient | null,
  sessionId: string,
  versionId: string,
): Promise<ArtifactVersionProvenance> {
  const version = store.getArtifactVersion(sessionId, versionId);
  if (!version) throw new Error("Artifact version not found");
  const sourceSessionId = store.getSession(version.sessionId) ? version.sessionId : undefined;
  // Try the memory graph first: it holds the addressing info (hashes / routing
  // keys) for the five fields. The graph is a directory — it returns no
  // content blobs, only what the handler needs to fetch bodies from CAS/store.
  // Any miss (graph disabled, unreachable, version not mirrored) falls back to
  // the existing store/CAS path so Provenance keeps working.
  const graph = memoryGraphClient
    ? await memoryGraphClient.getArtifactProvenance(version.artifactId, version.version, version.sessionId).catch(() => null)
    : null;
  if (graph && !graph.reason) {
    return artifactVersionProvenanceFromGraph(store, recorder, graph, sessionId, sourceSessionId, version);
  }
  return artifactVersionProvenanceFromStore(store, recorder, sessionId, sourceSessionId, version);
}

/** Provenance assembled from the graph's addressing info (graph = directory).
 * Each field's hash/routing key comes from the graph; the bodies are fetched
 * from CAS/store the same way as the store path, so the bytes match. */
async function artifactVersionProvenanceFromGraph(
  store: SessionStore,
  recorder: ProvenanceRecorder,
  graph: ArtifactProvenanceGraphResult,
  scopeSessionId: string,
  sourceSessionId: string | undefined,
  version: ScientificArtifactVersion,
): Promise<ArtifactVersionProvenance> {
  // code + executionLog: one Code node per execution. The graph gives the
  // hashes; language/tool/runId come from the ExecutionRun (fetched once) so
  // the response shape matches the store path exactly.
  const runs = sourceSessionId
    ? (await store.listExecutionRuns(sourceSessionId)).filter((run) => version.executionRunIds.includes(run.id))
    : [];
  const codeHash = graph.codeHash ?? null;
  const stdoutHash = graph.stdoutHash ?? null;
  const stderrHash = graph.stderrHash ?? null;
  // Prefer the run whose id matches the graph's code_id (= executionId); fall
  // back to the single run when the graph did not pin one.
  const run = graph.codeId ? runs.find((candidate) => candidate.id === graph.codeId) ?? runs[0] : runs[0];
  const codeEntry = run ? {
    code: codeHash ? (await recorder.cas.read(codeHash)).toString("utf8") : "",
    language: run.language,
    runId: run.id,
    tool: run.tool,
  } : undefined;
  const logEntry = run ? {
    envSnapshot: run.envSnapshot ?? null,
    exitCode: graph.exitCode ?? run.exitCode,
    finishedAt: graph.finishedAt ?? run.finishedAt,
    processEnvironment: await readProcessEnvironment(recorder, run.envSnapshot),
    runId: run.id,
    status: (graph.status ?? run.status) as ExecutionRun["status"],
    stderr: stderrHash ? (await recorder.cas.read(stderrHash)).toString("utf8") : "",
    stdout: stdoutHash ? (await recorder.cas.read(stdoutHash)).toString("utf8") : "",
    workingDirectory: run.workingDirectory ?? "unavailable",
  } : undefined;
  // environments: graph gives the env snapshot hash; resolve to the matching
  // EnvironmentRevision(s) by hash so the response carries the full revision
  // (packages/channels/etc.) the UI renders. Fall back to run's revision id.
  const environmentIds = new Set(runs.flatMap((run) => run.environmentRevisionId ? [run.environmentRevisionId] : []));
  const environments = graph.envHash
    ? store.listEnvironmentRevisions().filter((revision) => revision.snapshot.hash === graph.envHash)
    : store.listEnvironmentRevisions().filter((revision) => environmentIds.has(revision.id));
  // messages: turnId routing key → manifests → messageIds → messages. The
  // SubTask node stores turn_id (not manifest_ids) because manifest_ids would
  // race manifest persistence at mirror time (the manifest lands after the
  // execution mirror fires). Prefer the SubTask's turn_id, then the version
  // node's turn_id, then the store's version.turnId — all the same turn.
  const reviewTurnId = graph.messagesTurnId ?? graph.turnId ?? version.turnId ?? null;
  const manifests = reviewTurnId
    ? sourceSessionId ? (await store.listPromptManifests(sourceSessionId)).filter((manifest) => manifest.turnId === reviewTurnId) : []
    : [];
  const messageIds = new Set(manifests.flatMap((manifest) => manifest.inputs.flatMap((input) => input.messageId ? [input.messageId] : [])));
  const messages = sourceSessionId
    ? (await store.readMessages(sourceSessionId)).filter((message) => messageIds.has(message.id))
    : [];
  // dependencies: input-edge endpoints from the graph; fall back to the
  // store's inputArtifactVersionIds when derived-from has not landed input
  // edges yet (dependencies empty).
  const dependencies = (graph.dependencies && graph.dependencies.length)
    ? graph.dependencies.flatMap((dep) => {
      const dependencyVersion = store.listArtifactVersions(scopeSessionId, dep.artifactId).find((candidate) => candidate.version === dep.version);
      if (!dependencyVersion) return [];
      const artifact = store.getArtifact(scopeSessionId, dependencyVersion.artifactId);
      return artifact ? [{ artifact, version: dependencyVersion }] : [];
    })
    : version.inputArtifactVersionIds.flatMap((dependencyId) => {
      const dependencyVersion = store.getArtifactVersion(scopeSessionId, dependencyId);
      if (!dependencyVersion) return [];
      const artifact = store.getArtifact(scopeSessionId, dependencyVersion.artifactId);
      return artifact ? [{ artifact, version: dependencyVersion }] : [];
    });
  // review: turnId routing key → listReviews filtered by turnId.
  const review = reviewTurnId && sourceSessionId
    ? (await store.listReviews(sourceSessionId)).filter((review) => review.turnId === reviewTurnId)
    : [];
  return {
    code: codeEntry ? [codeEntry] : [],
    dependencies,
    environments,
    executionLog: logEntry ? [logEntry] : [],
    messages,
    review,
    ...(!sourceSessionId ? { sourceSessionDeleted: true } : {}),
    version,
  };
}

/** Legacy store/CAS assembly path — the fallback when the graph is disabled,
 * unreachable, or has not mirrored the version yet. Kept verbatim so the
 * response is byte-identical to the pre-graph path. */
async function artifactVersionProvenanceFromStore(
  store: SessionStore,
  recorder: ProvenanceRecorder,
  scopeSessionId: string,
  sourceSessionId: string | undefined,
  version: ScientificArtifactVersion,
): Promise<ArtifactVersionProvenance> {
  const runs = sourceSessionId
    ? (await store.listExecutionRuns(sourceSessionId)).filter((run) => version.executionRunIds.includes(run.id))
    : [];
  const manifests = version.turnId && sourceSessionId
    ? (await store.listPromptManifests(sourceSessionId)).filter((manifest) => manifest.turnId === version.turnId)
    : [];
  const messageIds = new Set(manifests.flatMap((manifest) => manifest.inputs.flatMap((input) => input.messageId ? [input.messageId] : [])));
  const messages = sourceSessionId
    ? (await store.readMessages(sourceSessionId)).filter((message) => messageIds.has(message.id))
    : [];
  const environmentIds = new Set(runs.flatMap((run) => run.environmentRevisionId ? [run.environmentRevisionId] : []));
  const dependencies = version.inputArtifactVersionIds.flatMap((dependencyId) => {
    const dependencyVersion = store.getArtifactVersion(scopeSessionId, dependencyId);
    if (!dependencyVersion) return [];
    const artifact = store.getArtifact(scopeSessionId, dependencyVersion.artifactId);
    return artifact ? [{ artifact, version: dependencyVersion }] : [];
  });
  return {
    code: await Promise.all(runs.map(async (run) => ({
      code: (await recorder.cas.read(run.code.hash)).toString("utf8"),
      language: run.language,
      runId: run.id,
      tool: run.tool,
    }))),
    dependencies,
    environments: store.listEnvironmentRevisions().filter((revision) => environmentIds.has(revision.id)),
    executionLog: await Promise.all(runs.map(async (run) => ({
      envSnapshot: run.envSnapshot ?? null,
      exitCode: run.exitCode,
      finishedAt: run.finishedAt,
      processEnvironment: await readProcessEnvironment(recorder, run.envSnapshot),
      runId: run.id,
      status: run.status,
      stderr: (await recorder.cas.read(run.stderr.hash)).toString("utf8"),
      stdout: (await recorder.cas.read(run.stdout.hash)).toString("utf8"),
      workingDirectory: run.workingDirectory ?? "unavailable",
    }))),
    messages,
    review: version.turnId && sourceSessionId
      ? (await store.listReviews(sourceSessionId)).filter((review) => review.turnId === version.turnId)
      : [],
    ...(!sourceSessionId ? { sourceSessionDeleted: true } : {}),
    version,
  };
}

export async function artifactVersionDiff(
  store: SessionStore,
  recorder: ProvenanceRecorder,
  sessionId: string,
  toVersionId: string,
  fromVersionId?: string,
): Promise<ArtifactVersionDiff> {
  const to = store.getArtifactVersion(sessionId, toVersionId);
  if (!to) throw new Error("Artifact version not found");
  const versions = store.listArtifactVersions(sessionId, to.artifactId);
  const from = fromVersionId
    ? versions.find((version) => version.id === fromVersionId)
    : versions.find((version) => version.version === to.version - 1);
  if (!from) throw new Error("A previous artifact version is unavailable for comparison");
  const isText = (mediaType: string) => mediaType.startsWith("text/")
    || /\b(?:json|javascript|xml|yaml)\b/i.test(mediaType);
  if (!isText(from.mediaType) || !isText(to.mediaType)) throw new Error("Diff is available only for textual or comparable artifact versions");
  const [before, after] = await Promise.all([
    recorder.cas.read(from.content.hash),
    recorder.cas.read(to.content.hash),
  ]);
  const beforeLines = before.toString("utf8").split(/\r?\n/).slice(0, 5_000);
  const afterLines = after.toString("utf8").split(/\r?\n/).slice(0, 5_000);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) suffix += 1;
  return {
    fromVersionId: from.id,
    lines: [
      ...beforeLines.slice(0, prefix).map((text) => ({ kind: "context" as const, text })),
      ...beforeLines.slice(prefix, beforeLines.length - suffix).map((text) => ({ kind: "removed" as const, text })),
      ...afterLines.slice(prefix, afterLines.length - suffix).map((text) => ({ kind: "added" as const, text })),
      ...afterLines.slice(afterLines.length - suffix).map((text) => ({ kind: "context" as const, text })),
    ],
    mediaType: to.mediaType,
    toVersionId: to.id,
  };
}

export function aggregateToolText(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("content" in result)) return undefined;
  const content = (result as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

export function mcpConnectorManifest(manifest: import("@science-agent/schema").McpSourceManifest): ConnectorManifest {
  return {
    attributionTemplate: manifest.governance.attribution,
    cacheTtlSeconds: manifest.cache.ttlSeconds,
    citationTemplate: manifest.prompt.citationPolicy,
    codeHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    commercialUseConstraints: manifest.governance.commercialUseConstraints ?? "",
    dataClassification: manifest.governance.dataClassification,
    enabledByDefault: manifest.enabledByDefault,
    id: manifest.id,
    inputSchemaVersion: manifest.schemaVersion,
    license: manifest.governance.license,
    maxResponseBytes: manifest.governance.maxResponseBytes,
    networkHosts: manifest.governance.networkHosts,
    publisher: manifest.publisher,
    rateLimitPerSecond: manifest.governance.rateLimitPerSecond,
    redirectPolicy: "deny",
    requestedCapabilities: ["mcp"],
    requestedSecrets: [],
    schemaVersion: manifest.schemaVersion,
    signature: null,
    termsUrl: manifest.governance.termsUrl,
    trustLevel: "bundled",
    version: manifest.version,
  };
}

export function toolSummary(result: unknown): string | undefined {
  return aggregateToolText(result)?.slice(0, 400);
}

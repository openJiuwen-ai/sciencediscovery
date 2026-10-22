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


import { canonical } from "@sciencediscovery/research-package";
import type { MemoryGraphSnapshot } from "@sciencediscovery/memory";
import type { ChatMessage, ScientificArtifactVersion } from "@sciencediscovery/schema";
import { type ResearchPackageIds, remapMemorySnapshot, remapMessages, remapReferences, remapRunEvent, remapRunStreamId } from "./research-package-history.js";
import { remapPackageTrajectory, type PackageTrajectory } from "./research-package-trajectory.js";

type Row = Record<string, unknown>;
type Records = { sessions?: Row[]; artifacts?: Array<Row & { versions?: ScientificArtifactVersion[] }>; memoryGraph?: MemoryGraphSnapshot };
const rows = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
const comparable = (value: unknown): string => value === undefined ? "undefined" : canonical(JSON.parse(JSON.stringify(value)));
function equal(label: string, expected: unknown, actual: unknown): void {
  if (comparable(expected) !== comparable(actual)) throw new Error(`Research copy integrity mismatch: ${label}`);
}
function graphRows(snapshot: MemoryGraphSnapshot) {
  const key = (node: MemoryGraphSnapshot["nodes"][number]) => comparable({ labels: [...node.labels].sort(), properties: node.properties });
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, key(node)]));
  return { nodes: [...nodes.values()].sort(), edges: snapshot.edges.map((edge) => comparable({ source: nodes.get(edge.source), target: nodes.get(edge.target), type: edge.type, properties: edge.properties })).sort() };
}

/** Fail closed before publishing a writable copy. CAS hashes cover file/log bytes. */
export function verifyResearchCopy(sourceValue: unknown, targetValue: unknown, ids: ResearchPackageIds, sessions: Map<string, string>, projectId: string): void {
  const source = sourceValue as Records, target = targetValue as Records;
  equal("session count", source.sessions?.length ?? 0, target.sessions?.length ?? 0);
  for (const original of source.sessions ?? []) {
    const sourceId = (original.session as { id: string }).id;
    const copy = target.sessions?.find((item) => (item.session as { id: string }).id === sessions.get(sourceId));
    if (!copy) throw new Error("Research copy session missing");
    if (original.trajectory) {
      const expected = remapPackageTrajectory(original.trajectory as PackageTrajectory, sessions.get(sourceId)!, ids);
      const actual = copy.trajectory as PackageTrajectory | undefined;
      if (!actual) throw new Error("Research copy trajectory missing");
      equal("trajectory details", expected.details, actual.details);
      for (const field of ["agents", "entries", "untimedEntries", "warnings"] as const) equal(`trajectory.${field}`, expected.index[field], actual.index[field]);
      equal("trajectory runs", expected.runIds, actual.runIds);
    }
    equal("transcript", remapMessages(original.messages as ChatMessage[] ?? [], ids, projectId), copy.messages ?? []);
    equal("artifact annotations", rows(original.artifactAnnotations).map((annotation) => ({ ...remapRunEvent(annotation, ids), id: ids.id(String(annotation.id)) })), copy.artifactAnnotations ?? []);
    const files = (value: unknown) => rows(value).map(({ path, objectPath, size }) => ({ path, objectPath, size })).sort((a, b) => String(a.path).localeCompare(String(b.path)));
    equal("workspace bytes", files(original.workspace), files(copy.workspace));
    for (const kind of ["executionRuns", "promptManifests", "artifactDerivations", "subagents", "shellExecutions", "claims", "evidenceLinks", "evidenceItems"]) {
      const expected = rows(original[kind]), actual = rows(copy[kind]);
      equal(`${kind} count`, expected.length, actual.length);
      for (const row of expected) {
        const mapped = remapRunEvent(row, ids);
        const restored = actual.find((item) => item.id === ids.id(String(row.id)));
        if (!restored) throw new Error(`Research copy missing ${kind}`);
        // Content and immutable object identities; runtime receipts are deliberately not replayed.
        for (const field of ["content", "text", "code", "stdout", "stderr", "envSnapshot", "inputs", "systemPrompt", "steps", "result", "origin", "sessionId", "turnId", "parentTurnId", "toolCallId", "environmentRevisionId", "executionRunIds", "claimId", "evidenceItemId", "reviewRunId", "createdAt", "startedAt", "finishedAt", "status", "state", "queuedAt", "accepted", "provenance", "path"]) {
          if (field in row) equal(`${kind}.${field}`, mapped[field], restored[field]);
        }
      }
    }
    const runs = rows(original.runs), restoredRuns = rows(copy.runs);
    equal("run count", runs.length, restoredRuns.length);
    for (const run of runs) {
      const restored = restoredRuns.find((item) => item.id === ids.id(String(run.id)));
      if (!restored) throw new Error("Research copy run missing");
      const mapped = remapRunEvent(run, ids);
      for (const field of ["prompt", "status", "queueOrder", "createdAt", "startedAt", "finishedAt", "userMessageId", "assistantMessageId", "settingsSnapshot"]) equal(`run.${field}`, mapped[field] ?? null, restored[field] ?? null);
      equal("run.references", remapReferences(run.references as never, ids, projectId) ?? [], restored.references ?? []);
    }
    const streams = (value: unknown, remap: boolean) => rows(value).flatMap((entry) => rows(entry.streams).map((stream) => ({ runId: remap ? ids.id(String(entry.runId)) : entry.runId, streamId: remap ? remapRunStreamId(String(stream.streamId), ids) : stream.streamId, events: rows(stream.events).map(({ sequence, createdAt, event }) => ({ sequence, createdAt, event: remap ? remapRunEvent(event, ids) : event })) }))).sort((a, b) => comparable([a.runId, a.streamId]).localeCompare(comparable([b.runId, b.streamId])));
    equal("run event streams", streams(original.runEvents, true), streams(copy.runEvents, false));
    // Explicit revision counts/hashes and all attribution links, independent of filesystem timestamp precision.
    for (const provenance of rows(original.workspaceProvenance)) {
      const restored = rows(copy.workspaceProvenance).find((item) => (item.file as Row).path === (provenance.file as Row).path);
      if (!restored) throw new Error("Research copy provenance missing");
      const expected = rows(provenance.revisions), actual = rows(restored.revisions);
      equal("revision count", expected.length, actual.length);
      for (const revision of expected) {
        const mapped = remapRunEvent(revision, ids);
        const found = actual.find((item) => item.id === ids.id(String(revision.id)));
        if (!found) throw new Error("Research copy revision missing");
        for (const field of ["fileId", "sessionId", "projectId", "parentRevisionId", "path", "contentHash", "origin", "size", "createdAt", "runId", "executionRunId", "toolCallId", "subagentId"]) equal(`revision.${field}`, mapped[field] ?? null, found[field] ?? null);
        equal("revision artifacts", (revision.artifactVersionIds as string[]).map((id) => ids.id(id)).sort(), [...found.artifactVersionIds as string[]].sort());
      }
    }
    for (const kind of ["artifactReviews", "reviews", "reviewerAuditTasks", "reviewFeedback"]) {
      const expected = rows((original.validations as Row | undefined)?.[kind]), actual = rows((copy.validations as Row | undefined)?.[kind]);
      equal(`validation.${kind} count`, expected.length, actual.length);
      for (const record of expected) {
        const restored = actual.find((item) => item.id === ids.id(String(record.id)));
        if (!restored) throw new Error(`Research copy missing ${kind}`);
        equal(`validation.${kind}`, { ...remapRunEvent(record, ids), id: ids.id(String(record.id)) }, restored);
      }
    }
  }
  equal("artifact count", source.artifacts?.length ?? 0, target.artifacts?.length ?? 0);
  for (const artifact of source.artifacts ?? []) {
    const restored = target.artifacts?.find((item) => item.id === ids.id(String(artifact.id)));
    if (!restored) throw new Error("Research copy artifact missing");
    for (const field of ["name", "logicalName", "title", "description", "kind", "origin", "originMeta", "createdAt", "updatedAt", "currentVersion"]) equal(`artifact.${field}`, artifact[field] ?? null, restored[field] ?? null);
    equal("artifact version count", artifact.versions?.length ?? 0, restored.versions?.length ?? 0);
    for (const version of artifact.versions ?? []) {
      const found = restored.versions?.find((item) => item.id === ids.id(version.id));
      if (!found) throw new Error("Research copy artifact version missing");
      for (const field of ["content", "mediaType", "sourcePath", "createdAt", "version"] as const) equal(`artifact.${field}`, version[field] ?? null, found[field] ?? null);
      equal("artifact session", ids.id(version.sessionId), found.sessionId);
      equal("artifact turn", version.turnId ? ids.id(version.turnId) : null, found.turnId ?? null);
      equal("artifact executions", version.executionRunIds.map((id) => ids.id(id)), found.executionRunIds);
      equal("artifact inputs", version.inputArtifactVersionIds.map((id) => ids.id(id)).sort(), [...found.inputArtifactVersionIds].sort());
      equal("artifact references", remapReferences(version.references, ids, projectId) ?? [], found.references ?? []);
      equal("artifact ancestry", version.baseVersionId ? ids.id(version.baseVersionId) : null, found.baseVersionId ?? null);
    }
  }
  if (source.memoryGraph) {
    if (!target.memoryGraph) throw new Error("Research copy scientific memory missing");
    equal("scientific memory", graphRows(remapMemorySnapshot(source.memoryGraph, sessions, projectId, ids, new Map())), graphRows(target.memoryGraph));
  }
}

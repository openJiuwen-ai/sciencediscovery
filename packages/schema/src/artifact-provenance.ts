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

import type { EnvironmentRevision, ExecutionLanguage } from "./environment.js";
import type { CasObjectRef, ExecutionRun, ReviewRun } from "./provenance.js";
import type { ChatMessage, ComposerReference, SessionRun } from "./session.js";
import type { Subagent } from "./subagent.js";

export type ScientificArtifactKind = "dataset" | "figure" | "html" | "json" | "latex" | "markdown" | "notebook" | "other" | "report" | "structure";
export type ArtifactOrigin = "legacy_auto" | "llm_declared" | "mcp_download" | "server_generated" | "user_upload";
export type ArtifactOriginMeta = Record<string, boolean | number | string | null>;

export interface ScientificArtifact {
  createdAt: string;
  createdInSessionId: string;
  createdInSessionTitle: string;
  currentVersion: number;
  /** User-visible logical deletion. Historical versions remain addressable. */
  deletedAt?: string;
  description?: string;
  id: string;
  kind: ScientificArtifactKind;
  /** @deprecated Use name. Retained for persisted/API compatibility. */
  logicalName: string;
  name: string;
  origin: ArtifactOrigin;
  originMeta?: ArtifactOriginMeta;
  projectId: string;
  /** @deprecated Use createdInSessionId. Retained for compatibility. */
  sessionId: string;
  title?: string;
  updatedAt: string;
}

export interface ScientificArtifactVersion {
  /** Explicit edit ancestry and durable tool-call deduplication. */
  baseVersionId?: string;
  publicationId?: string;
  artifactId: string;
  content: CasObjectRef;
  createdAt: string;
  executionRunIds: string[];
  id: string;
  inputArtifactVersionIds: string[];
  mediaType: string;
  projectId: string;
  /**
   * Chip references for a report Artifact version (declare-driven). Each
   * entry maps a prose alias (`[evidence1]` / `[artifact1]`) written into the
   * report body to a memory-graph node (Paper link / Evidence evidence_id /
   * Artifact artifact_id / Claim claim_id). The Markdown renderer turns the
   * aliases into clickable chips; persisted on the version so chips survive
   * reloads. Absent on non-report versions and on older reports.
   */
  references?: ComposerReference[];
  sessionId: string;
  sourcePath?: string;
  turnId?: string;
  version: number;
}

/** One declared Artifact version produced in a Session. The client assigns it
 * to the visible top-level Run from `version.turnId`; keeping that derived
 * relationship out of the Catalog preserves the original execution lineage. */
export interface SessionArtifactOutput {
  artifact: ScientificArtifact;
  version: ScientificArtifactVersion;
}

/**
 * Attribute declared versions to their top-level conversation run, following
 * subagent ancestry when necessary. Unknown or cyclic lineages stay unassigned.
 * A run keeps the highest version it wrote of each artifact.
 */
export function groupArtifactOutputsByRun(
  outputs: readonly SessionArtifactOutput[],
  runs: readonly Pick<SessionRun, "id">[],
  subagents: readonly Pick<Subagent, "id" | "parentTurnId">[],
): ReadonlyMap<string, readonly SessionArtifactOutput[]> {
  const runIds = new Set(runs.map((run) => run.id));
  const parentTurnBySubagentId = new Map(subagents.map((subagent) => [subagent.id, subagent.parentTurnId]));
  const byRunAndArtifact = new Map<string, Map<string, SessionArtifactOutput>>();

  function rootRunId(turnId: string | undefined): string | undefined {
    const visited = new Set<string>();
    let current = turnId;
    while (current && !visited.has(current)) {
      if (runIds.has(current)) return current;
      visited.add(current);
      current = parentTurnBySubagentId.get(current);
    }
    return undefined;
  }

  for (const output of outputs) {
    const runId = rootRunId(output.version.turnId);
    if (!runId) continue;
    const byArtifact = byRunAndArtifact.get(runId) ?? new Map<string, SessionArtifactOutput>();
    const existing = byArtifact.get(output.artifact.id);
    if (!existing
      || output.version.version > existing.version.version
      || (output.version.version === existing.version.version
        && output.version.createdAt > existing.version.createdAt)) {
      byArtifact.set(output.artifact.id, output);
    }
    byRunAndArtifact.set(runId, byArtifact);
  }

  return new Map([...byRunAndArtifact].map(([runId, byArtifact]) => [
    runId,
    [...byArtifact.values()].toSorted((left, right) =>
      left.version.createdAt.localeCompare(right.version.createdAt)
      || left.version.version - right.version.version
      || left.artifact.name.localeCompare(right.artifact.name),
    ),
  ]));
}

/** Line range returned for one `read_artifact` page. */
export interface ArtifactTextPage {
  bytes: number;
  /** Last 1-based line included; `startLine - 1` when the page is empty. */
  endLine: number;
  /**
   * True only when line paging can still advance inside the decodable text
   * window. It never covers bytes past that window or the cut-off remainder of
   * an over-wide line — those are reported by `truncated`, `partialLine`, and
   * `note`, because no offset can reach them.
   */
  hasMore: boolean;
  /** Always greater than the offset just used; absent when `hasMore` is false. */
  nextOffset?: number;
  /**
   * True when one line was wider than the page budget and had to be cut. Line
   * offsets cannot address the remainder, so read the version another way.
   */
  partialLine: boolean;
  startLine: number;
  /** Lines available inside the decodable text window, not the whole version. */
  totalLines: number;
}

export interface ArtifactReadResult {
  artifact: ScientificArtifact;
  /**
   * True when the version holds binary content. The body is then never
   * inlined — not raw and not base64 — because it cannot enter model text
   * input usefully and would consume the whole input budget.
   */
  binary: boolean;
  /** One UTF-8 page of a text version; absent for binary versions. */
  content?: string;
  encoding: "binary" | "utf8";
  mediaType: string;
  /**
   * Actionable explanation of content the line protocol cannot address —
   * bytes past the decodable text window, or the rest of an over-wide line.
   */
  note?: string;
  page?: ArtifactTextPage;
  /** Stored byte size of the whole version content. */
  size: number;
  /** True when the version exceeds the decodable text window. */
  truncated: boolean;
  version: ScientificArtifactVersion;
}

export interface ArtifactAnnotation {
  artifactLogicalName: string;
  artifactVersionId: string;
  attachedMessageId?: string;
  createdAt: string;
  height?: number;
  id: string;
  note: string;
  sessionId: string;
  status: "attached" | "pending";
  width?: number;
  x: number;
  y: number;
}

export interface ArtifactCodeProvenance {
  code: string;
  language: ExecutionLanguage | null;
  runId: string;
  tool: ExecutionRun["tool"];
}

export interface ArtifactExecutionLogProvenance {
  envSnapshot: CasObjectRef | null;
  exitCode: number | null;
  finishedAt: string;
  processEnvironment: Record<string, string> | null;
  runId: string;
  status: ExecutionRun["status"];
  stderr: string;
  stdout: string;
  workingDirectory: string;
}

export interface ArtifactVersionProvenance {
  code: ArtifactCodeProvenance[];
  dependencies: Array<{ artifact: ScientificArtifact; version: ScientificArtifactVersion; kind?: "artifact" | "source_file" }>;
  environments: EnvironmentRevision[];
  executionLog: ArtifactExecutionLogProvenance[];
  messages: ChatMessage[];
  review: ReviewRun[];
  sourceSessionDeleted?: boolean;
  version: ScientificArtifactVersion;
}

/** Memory-graph node labels mirrored from the Python sidecar. */

export interface ArtifactDerivation {
  content: CasObjectRef;
  createdAt: string;
  executionRunIds: string[];
  id: string;
  path: string;
  sessionId: string;
  sourceType: "generated";
  turnId: string;
}

export interface ArtifactDiffLine {
  kind: "added" | "context" | "removed";
  text: string;
}

export interface ArtifactVersionDiff {
  fromVersionId: string;
  lines: ArtifactDiffLine[];
  mediaType: string;
  toVersionId: string;
}

export interface CreateArtifactAnnotationRequest {
  height?: number;
  note: string;
  width?: number;
  x: number;
  y: number;
}

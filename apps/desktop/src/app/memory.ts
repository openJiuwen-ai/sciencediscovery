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

/**
 * The pure part of 科学记忆: which node a citation resolves to, what a node is
 * called, and which nodes an Evidence's source chain actually shows.
 *
 * The graph itself is never drawn here. The provenance tab answers one
 * question — where did this come from — and for an Artifact that answer is the
 * version's own provenance record, not a graph walk. Keeping these decisions
 * out of the component is what lets them be tested without a browser or a
 * memory service.
 */

import type {
  ComposerReference,
  MemoryGraphHit,
  MemoryGraphMatchResponse,
  MemoryGraphNode,
  MemoryGraphNodeLabel,
} from "../api/types.js";
import { referenceNodeLabel } from "./memory-chips.js";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * What a node is called in a provenance card.
 *
 * The graph stores no single `title` field; each label carries its own. The
 * fallbacks are the ids the node actually has, never an empty line — a trace
 * whose step has no name reads as a broken step rather than a complete one.
 */
export function memoryNodeTitle(node: MemoryGraphNode): string {
  const extra = node.extra ?? {};
  switch (node.label) {
    case "Paper":
      return text(extra.title) ?? node.id;
    case "SourceFile":
      return text(extra.name) ?? text(extra.path) ?? node.id;
    case "WebPage":
      return text(extra.title) ?? text(extra.url) ?? node.id;
    case "DbRecord":
      return text(extra.title) ?? text(extra.identifier) ?? node.id;
    case "Code":
      return text(extra.tool) ?? text(extra.code_id) ?? node.id;
    case "ToolCall":
      return text(extra.tool_name) ?? text(extra.tool_type) ?? text(extra.task_id) ?? node.id;
    case "Task":
      return text(extra.objective) ?? text(extra.subagent_type) ?? text(extra.task_type) ?? node.id;
    case "ResearchGoal":
      return text(extra.core_objective) ?? text(extra.domain) ?? node.id;
    case "Artifact":
      return text(extra.logical_name) ?? baseName(text(extra.path)) ?? node.id;
    case "Claim":
    case "Evidence":
      return text(extra.content) ?? node.id;
    default:
      return node.id;
  }
}

/** The second line of a provenance card — the fact that tells two nodes of
 *  the same label apart. */
export function memoryNodeDetail(node: MemoryGraphNode): string | undefined {
  const extra = node.extra ?? {};
  switch (node.label) {
    case "Paper":
      return text(extra.abstract) ?? text(extra.identifier);
    case "SourceFile":
      return text(extra.path);
    case "WebPage":
      return text(extra.snippet) ?? text(extra.url);
    case "DbRecord":
      return text(extra.snippet) ?? text(extra.identifier) ?? text(extra.url);
    case "Code":
      return text(extra.code_id);
    case "ToolCall":
      return text(extra.tool_type) ?? text(extra.task_id);
    case "Task":
      return text(extra.summary) ?? text(extra.status);
    case "Artifact":
      return text(extra.path);
    case "Claim":
    case "Evidence":
      return text(extra.locator);
    case "ResearchGoal":
      return text(extra.domain);
    default:
      return undefined;
  }
}

/** The one field a provenance card may link out to. Only web-shaped labels
 *  have one; an uploaded file is opened from the workspace, not from here. */
export function memoryNodeLink(node: MemoryGraphNode): string | undefined {
  const extra = node.extra ?? {};
  const link = text(extra.link) ?? text(extra.url);
  return link !== undefined && /^https?:\/\//i.test(link) ? link : undefined;
}

function baseName(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  return name === "" ? undefined : name;
}

export interface ArtifactNodeIdentity {
  artifactId: string;
  version?: number;
}

/** Artifact nodes are keyed on `(artifact_id, version)`, and their subgraph id
 *  encodes it as `<artifact_id>#v<version>`. A provenance card has only the
 *  node, so this recovers the two keys the artifact panel is addressed by. */
export function artifactIdentity(
  node: Pick<MemoryGraphNode, "extra" | "id" | "label">,
): ArtifactNodeIdentity | undefined {
  if (node.label !== "Artifact") return undefined;
  const extra = node.extra ?? {};
  const hash = node.id.indexOf("#v");
  const artifactId = text(extra.artifact_id) ?? (hash === -1 ? node.id : node.id.slice(0, hash));
  const version = number(extra.version)
    ?? (hash === -1 ? undefined : Number(node.id.slice(hash + 2)));
  return {
    artifactId,
    version: version !== undefined && Number.isFinite(version) ? version : undefined,
  };
}

/** The version a card should ask the graph about. Same encoding as above, so
 *  a chain opened from a card is pinned to the version the card names. */
export function artifactVersionOf(hit: MemoryGraphHit): number | undefined {
  return number(hit.extra?.version) ?? artifactIdentity({ extra: hit.extra, id: hit.id, label: hit.label })?.version;
}

/**
 * The node a report's citation names, out of the page a detail read returned.
 *
 * A chip carries the node id and, for an Artifact, the version the report
 * cited — not the graph's `<id>#v<version>` key. Matching on the identity the
 * graph stores is what lets a report pin an older version even after the
 * artifact has moved on.
 */
export function matchReferenceHit(
  hits: MemoryGraphHit[],
  reference: Pick<ComposerReference, "id" | "kind" | "version">,
): MemoryGraphHit | undefined {
  const label = referenceNodeLabel(reference.kind);
  if (label === undefined) return undefined;
  const candidates = hits.filter((hit) => hit.label === label);
  if (reference.kind === "artifact") {
    return candidates.find((hit) => {
      const identity = artifactIdentity(hit);
      if (identity?.artifactId !== reference.id) return false;
      return reference.version === undefined || identity.version === reference.version;
    });
  }
  return candidates.find((hit) => hit.id === reference.id);
}

/** One node-type read for a citation. Injected so the order of the reads can
 *  be tested without a client or a graph service. */
export type CitationRead = (
  label: MemoryGraphNodeLabel,
  sessionId?: string,
) => Promise<MemoryGraphMatchResponse>;

/** What the graph answered about a citation: the node, nothing recorded, a read
 *  that could not answer at all (off, budget refusal, unreachable), or an
 *  answer that does not settle the question. The last one is not a failure: the
 *  reads came back, but the page they returned was cut short, or the citation
 *  names no Session and its id is one the graph does not keep unique, so no hit
 *  can be attributed to this citation. */
export type CitationResolution =
  | { reason: string; status: "unanswered" }
  | { hit: MemoryGraphHit; status: "ready" }
  | { status: "unlocated" }
  | { status: "missing" };

/**
 * The labels whose node id names one node across every Session and project: the
 * id is the record's own key — an Evidence's `evidence_id`, an Artifact's
 * `<artifact_id>#v<version>`, a SourceFile's `file_id`.
 *
 * DbRecord is deliberately absent: its id is the bare `identifier`, and the
 * graph keys those nodes by `(session_id, source, identifier)`, so the same id
 * names several nodes of different Sessions. A hit found without a scope
 * therefore cannot be attributed to a citation that carries no Session, and an
 * unscoped read is only worth the query for the labels above.
 */
const GLOBALLY_UNIQUE_ID_LABELS: ReadonlySet<MemoryGraphNodeLabel> = new Set([
  "Artifact",
  "Evidence",
  "SourceFile",
]);

/**
 * The node a report's citation names.
 *
 * The scoped read is the fast path: a citation normally points at a node of the
 * report's own Session. A persisted alias map carries no Session, however, so a
 * citation of a node created in another Session of the same project is absent
 * from that scope — the normal case for project memory, where a later report
 * cites literature gathered earlier. When the citation names no Session, the
 * scoped read found nothing, and the label's id is unique across the whole
 * graph (`GLOBALLY_UNIQUE_ID_LABELS`), one unscoped read is the honest next
 * question — that id can only name the node the citation already names.
 *
 * A reason is returned untouched and never widened: a disabled service, an
 * exhausted query budget and an unreachable sidecar all mean "cannot answer",
 * not "no such record". A page the sidecar truncated means the same thing on a
 * smaller scale: it is a partial list of at most 500 nodes, so neither "no such
 * record" nor a same-id node from another Session may be concluded from it.
 */
export async function resolveCitation(
  reference: Pick<ComposerReference, "id" | "kind" | "label" | "sessionId" | "version">,
  sessionId: string | undefined,
  read: CitationRead,
): Promise<CitationResolution> {
  const label = referenceNodeLabel(reference.kind);
  if (label === undefined) return { status: "missing" };

  const scoped = reference.sessionId ?? sessionId;
  const scopedAnswer = await read(label, scoped);
  if (scopedAnswer.reason !== undefined) return { reason: scopedAnswer.reason, status: "unanswered" };
  const scopedHit = matchReferenceHit(scopedAnswer.hits ?? [], reference);
  if (scopedHit !== undefined) return { hit: scopedHit, status: "ready" };

  // The read answered, but a page the sidecar capped at 500 nodes can only say
  // that this citation was not among those 500 — not that it does not exist.
  const scopedPartial = scopedAnswer.truncated === true;

  // A citation that names its own Session was answered already; a read that was
  // already unscoped cannot be widened further.
  if (reference.sessionId !== undefined || scoped === undefined) {
    return scopedPartial ? { status: "unlocated" } : { status: "missing" };
  }

  // Widening an id that several Sessions can share would accept a foreign node
  // as the cited one, so a DbRecord citation without a Session stops here.
  if (!GLOBALLY_UNIQUE_ID_LABELS.has(label)) return { status: "unlocated" };

  const unscopedAnswer = await read(label, undefined);
  if (unscopedAnswer.reason !== undefined) return { reason: unscopedAnswer.reason, status: "unanswered" };
  const unscopedHit = matchReferenceHit(unscopedAnswer.hits ?? [], reference);
  if (unscopedHit !== undefined) return { hit: unscopedHit, status: "ready" };
  return unscopedAnswer.truncated === true ? { status: "unlocated" } : { status: "missing" };
}

/** Deduplicate by node id while keeping first-seen order: a chain result
 *  carries the source node in every call, and two calls often share it. */
function uniqueNodes(nodes: MemoryGraphNode[]): MemoryGraphNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

/**
 * Evidence's sources: what the evidence was extracted from, and nothing more.
 *
 * This is the old web UI's provenance tab. Which claims cite the evidence, and
 * which reports state those claims, describe the report rather than the
 * evidence — the citation already tells the reader where the report stands.
 */
export function evidenceSources(evidenceId: string, sourceChain: MemoryGraphNode[]): MemoryGraphNode[] {
  return uniqueNodes(sourceChain).filter((node) => node.id !== evidenceId);
}

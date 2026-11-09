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
  MemoryGraphNode,
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

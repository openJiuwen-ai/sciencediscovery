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
 * Knowledge-engine → memory-graph mirror.
 *
 * The workspace layer reports every successful KE tool invoke through
 * `knowledgeEngineObserver`; this module is the services-side observer
 * factory. It applies the same discipline as the MCP/Web brokers:
 *
 * - TOOL_GRAPH_REGISTRY is the single gate — unregistered tools never reach
 *   the sink (the observer still fires for them; skipping is a product
 *   decision, not an error).
 * - KB documents ride the DbRecord product shape: source="kb",
 *   identifier=docId, and the deep-link anchor `kb://<kbId>/<docId>` in `url`
 *   (the frontend renders kb:// links as in-app jumps, never as external
 *   links). The sidecar's MERGE key (session_id, source, identifier) dedups
 *   repeated retrievals of the same document.
 * - Mirroring is fire-and-forget (the sink never throws) and capped: a
 *   pathological result cannot flood the graph with product nodes.
 */

import { randomUUID } from "node:crypto";

import type { MemoryGraphSink, MemoryGraphToolCallProduct } from "@sciencediscovery/memory";
import { toolGraphSpec } from "@sciencediscovery/schema";
import type { KnowledgeEngineToolActivity } from "@sciencediscovery/workspace";

/** Hard cap on mirrored products per tool call (kb_search tops out at 20
 *  hits by contract; doc_grep matches can name up to 50 documents — the cap
 *  keeps a runaway result from flooding the graph). */
const MAX_MIRROR_PRODUCTS = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function kbDocumentProduct(kbId: string, docId: string, title: unknown): MemoryGraphToolCallProduct {
  // kbId/docId are randomUUIDs (lowercase) — the sidecar lowercases DbRecord
  // urls via _normalize_link, so a cased id would silently diverge from
  // `identifier`. Pin the assumption: if id generation ever changes case,
  // the deep link breaks before the dedup key does.
  return {
    productType: "db_record",
    source: "kb",
    identifier: docId,
    ...(typeof title === "string" && title ? { title } : {}),
    url: `kb://${kbId}/${docId}`,
  };
}

/** Map a KE tool result to DbRecord products (one per unique document).
 *  Unregistered/unknown tools and empty results yield []. */
export function keActivityToProducts(activity: KnowledgeEngineToolActivity): MemoryGraphToolCallProduct[] {
  if (toolGraphSpec(activity.toolName)?.product !== "db_record") return [];
  const result = activity.result;
  if (!isRecord(result)) return [];
  const kbId = typeof result.kbId === "string" && result.kbId ? result.kbId : activity.kbId;
  if (!kbId) return [];

  const products: MemoryGraphToolCallProduct[] = [];
  const seen = new Set<string>();
  const push = (docId: unknown, title: unknown): void => {
    if (typeof docId !== "string" || !docId || seen.has(docId) || products.length >= MAX_MIRROR_PRODUCTS) return;
    seen.add(docId);
    products.push(kbDocumentProduct(kbId, docId, title));
  };

  if (activity.toolName === "kb_search" && Array.isArray(result.hits)) {
    for (const hit of result.hits) {
      if (isRecord(hit)) push(hit.docId, hit.docTitle);
    }
  } else if (activity.toolName === "kb_expand" && result.found === true) {
    push(result.docId, result.docTitle);
  } else if (activity.toolName === "doc_grep" && Array.isArray(result.matches)) {
    for (const match of result.matches) {
      if (isRecord(match)) push(match.docId, match.docTitle);
    }
  }
  return products;
}

/** Build the workspace-layer observer that mirrors KE tool calls into the
 *  memory graph. The sink applies the live enabled toggle on every call, so
 *  this observer can be wired unconditionally when KE tools are present. */
export function createKnowledgeEngineGraphMirror(deps: {
  sink: MemoryGraphSink;
  sessionId: string;
  turnId: string;
}): (activity: KnowledgeEngineToolActivity) => void {
  return (activity) => {
    const spec = toolGraphSpec(activity.toolName);
    if (!spec) return;
    const products = keActivityToProducts(activity);
    // Structured tool-level failures (e.g. doc_grep's invalid-regex result)
    // return instead of throwing — mirror them as error, not ok.
    const status = isRecord(activity.result) && typeof activity.result.error === "string" ? "error" : "ok";
    deps.sink.observeToolCall({
      taskId: `subtask:ke:${randomUUID()}`,
      sessionId: deps.sessionId,
      turnId: deps.turnId,
      toolName: activity.toolName,
      toolType: spec.type,
      source: "knowledge-engine",
      status,
      resultCount: products.length,
      products,
    });
  };
}

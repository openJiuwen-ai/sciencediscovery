// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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
 * Graph-roots caching service, ported from the DeepAnalyze scholarly
 * graph-roots module. The partition is CACHED: a graph fingerprint (entity
 * count + support sum + edge count + edge support sum + latest edge
 * creation) invalidates it, so a changed graph recomputes while a stable
 * graph serves from ke_settings. Assignments are also written to
 * ke_entities.community_id for downstream filtering.
 *
 * Recompute is STALE-WHILE-REVALIDATE: a fingerprint mismatch no longer
 * blocks the request — the stale cached partition is served immediately and
 * the recompute (Louvain + community-id persistence + LLM naming, which can
 * take minutes with a reasoning model) runs in the background, deduped per
 * KB and rate-limited. Only a first-ever load (no cache at all) computes
 * synchronously.
 *
 * Community names come from ONE batched LLM call per recompute, cached with
 * the partition; no configured model (or any namer failure) falls back to
 * the representative entity's name.
 */

import { buildGraphRoots, type Community, type GraphRoots } from "@sciencediscovery/knowledge-engine";
import type { ModelEndpoint } from "@sciencediscovery/model";

import { callPipelineLlm, type PipelineInvoke } from "./llm.js";
import type { KnowledgeEngineStore } from "./store.js";

export type { GraphRoots };

/** Bump when the partition algorithm or fingerprint changes — stale caches
 *  are ignored. (v4 keeps parity with the DeepAnalyze cache lineage.) */
const CACHE_VERSION = "v4";
const REVALIDATE_MIN_INTERVAL_MS = 60_000;

function cacheKey(kbId: string): string {
  return `graph_roots:${CACHE_VERSION}:${kbId}`;
}

const NAMING_SYSTEM_PROMPT =
  "你是学科图谱社区命名器。只输出用户要求的 JSON，不要输出解释、前言或后记。";

function buildNamingPrompt(communities: readonly Community[]): string {
  const listing = communities
    .map((c) => `社区${c.id}: ${c.topEntities.map((e) => e.name).join(", ")}`)
    .join("\n");
  return `为以下每个实体社区起一个简短的名称（2-8个字/词，概括社区主题）。名称语言跟随实体的主要语言（实体多为英文则用英文命名，多为中文则用中文）。只返回 JSON 对象，键为社区编号（纯数字），值为名称，不要输出其他内容。

${listing}`;
}

/** Parse the batched naming response: clean numeric keys only, 30-char cap. */
export function parseNamingResponse(text: string): Map<number, string> {
  const names = new Map<number, string>();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return names;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (!/^\d+$/.test(key.trim())) continue;
      const id = Number(key.trim());
      if (typeof value === "string" && value.trim()) {
        names.set(id, value.trim().slice(0, 30));
      }
    }
  } catch {
    // Unparseable naming → empty map → representative-name fallback.
  }
  return names;
}

export interface GraphRootsServiceDeps {
  readonly store: KnowledgeEngineStore;
  /** Pipeline model endpoint for community naming (absent → rep-name fallback). */
  readonly resolveEndpoint?: () => ModelEndpoint | undefined;
  readonly llmInvoke?: PipelineInvoke;
  readonly onWarn?: (message: string, detail?: unknown) => void;
}

export interface GraphRootsService {
  /** Stale-while-revalidate by default; `force` recomputes synchronously
   *  against the live store — for callers that must bind artifacts to the
   *  CURRENT partition (community report generation). */
  getGraphRoots(kbId: string, opts?: { force?: boolean }): Promise<GraphRoots>;
  /** Test hook: await any in-flight background revalidation for a KB. */
  waitForRevalidate(kbId: string): Promise<void>;
}

/**
 * Current graph fingerprint straight from store stats — three cheap counts,
 * no partition compute. Community-keyed artifacts (reports, DRIFT) must bind
 * to THIS value: community ids are only stable within a fingerprint.
 */
export function graphFingerprintOf(store: KnowledgeEngineStore, kbId: string): string {
  const entityStats = store.entitySupportStats(kbId);
  const edgeFp = store.edgeFingerprint(kbId);
  return `e${entityStats.count}:${entityStats.supportSum}:x${edgeFp.count}:${edgeFp.supportSum}:${edgeFp.maxCreatedAt ?? "none"}`;
}

export function createGraphRootsService(deps: GraphRootsServiceDeps): GraphRootsService {
  const { store } = deps;
  // Background revalidation state (per KB): at most one recompute in flight,
  // and a minimum interval between recomputes — during active ingestion the
  // fingerprint changes constantly, and each recompute is expensive.
  const inflight = new Map<string, Promise<void>>();
  const lastRevalidateAt = new Map<string, number>();

  const warn = (message: string, detail?: unknown) => deps.onWarn?.(message, detail);

  const fingerprintOf = (kbId: string): string => graphFingerprintOf(store, kbId);

  const namer = async (communities: readonly Community[]): Promise<Map<number, string>> => {
    const endpoint = deps.resolveEndpoint?.();
    if (!endpoint) return new Map(); // no model → representative-name fallback
    const text = await callPipelineLlm(
      { endpoint, ...(deps.llmInvoke ? { invoke: deps.llmInvoke } : {}) },
      NAMING_SYSTEM_PROMPT,
      buildNamingPrompt(communities),
      new AbortController().signal,
    );
    return parseNamingResponse(text);
  };

  const compute = async (kbId: string, fingerprint: string): Promise<GraphRoots> => {
    const entities = store.listEntitiesForGraph(kbId);
    const edges = store.listEdges(kbId, { limit: 100_000 });
    const { roots, assignments } = await buildGraphRoots(
      entities.map((entity) => ({
        id: entity.id,
        name: entity.name,
        type: entity.type,
        supportCount: entity.supportCount,
      })),
      edges.map((edge) => ({ srcId: edge.srcId, dstId: edge.dstId, supportCount: edge.supportCount })),
      fingerprint,
      namer,
    );
    try {
      store.setCommunityIds(kbId, assignments);
    } catch (error) {
      warn("ke_graph_roots_persist_failed", { kbId, error: error instanceof Error ? error.message : String(error) });
    }
    try {
      store.setSetting(cacheKey(kbId), JSON.stringify(roots));
    } catch (error) {
      warn("ke_graph_roots_cache_failed", { kbId, error: error instanceof Error ? error.message : String(error) });
    }
    return roots;
  };

  const maybeRevalidate = (kbId: string): void => {
    if (inflight.has(kbId)) return;
    const last = lastRevalidateAt.get(kbId) ?? 0;
    if (Date.now() - last < REVALIDATE_MIN_INTERVAL_MS) return;
    lastRevalidateAt.set(kbId, Date.now());
    const task = (async () => {
      // Fingerprint is measured at task START (before the entity/edge fetch):
      // the cached partition can only be NEWER than its label if the graph
      // moved mid-compute, which costs at most one extra revalidate — the
      // safe direction. (DA's comment claimed "at completion"; the code —
      // here faithfully — samples at start.)
      await compute(kbId, fingerprintOf(kbId));
    })();
    inflight.set(kbId, task);
    task
      .catch((error) => {
        warn("ke_graph_roots_revalidate_failed", { kbId, error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        inflight.delete(kbId);
      });
  };

  return {
    async getGraphRoots(kbId: string, opts?: { force?: boolean }): Promise<GraphRoots> {
      const fingerprint = fingerprintOf(kbId);
      if (opts?.force) {
        // Binding callers (report generation) must never key their artifacts
        // to a partition the store has already moved past: the SWR cache can
        // lag by up to REVALIDATE_MIN_INTERVAL_MS, and a stale-bound report
        // generation is invisible to every live-fingerprint consumer.
        return compute(kbId, fingerprint);
      }
      let cached: GraphRoots | null = null;
      const raw = store.getSetting(cacheKey(kbId));
      if (raw) {
        try {
          cached = JSON.parse(raw) as GraphRoots;
        } catch {
          cached = null; // corrupt cache — recompute
        }
      }
      if (cached && cached.fingerprint === fingerprint) return { ...cached };
      if (cached) {
        // Stale cache: serve it immediately, recompute in the background.
        maybeRevalidate(kbId);
        return { ...cached };
      }
      // First-ever load: nothing to show yet, compute synchronously.
      return compute(kbId, fingerprint);
    },
    async waitForRevalidate(kbId: string): Promise<void> {
      await inflight.get(kbId)?.catch(() => undefined);
    },
  };
}

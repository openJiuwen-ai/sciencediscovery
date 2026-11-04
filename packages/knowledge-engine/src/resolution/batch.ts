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
 * Batch entity-resolution helpers (offline track), ported from the
 * DeepAnalyze scholarly/resolution-runner module. Pure functions only —
 * the job handler that drives them over the store lives in services/api.
 *
 * Pipeline recap (industry-aligned):
 *   entity-type blocking (DEG-RAG: type blocking was the best strategy)
 *   → dual-channel recall per block: trgm name similarity ∪ embedding
 *     cosine (LHCb recipe)
 *   → connected components over pairs ≥ embedLow; oversized components
 *     trimmed weakest-edge-first (LHCb dynamic-threshold lightweight)
 *   → one LLM CLUSTER judge call per component (LLM-CER: clustering beats
 *     pairwise at ~0.06% of the cost)
 *   → physical merge per equivalence class (audited, rollback-able)
 */

export const TRGM_BLOCKING_MIN = 0.4; // recall line for the string channel (blocking, not decision)
export const MAX_PAIRWISE_BLOCK = 2000; // beyond this, embedding channel switches to per-entity ANN
export const MAX_CLUSTER = 25; // oversized clusters are trimmed weakest-edge-first
export const CONVERGE_MERGE_RATE = 0.1; // LHCb: iterate while ≥10% of entities merge per round
export const ANN_RECALL_K = 10;

export interface CandidatePair {
  aId: string;
  bId: string;
  /** max(trgm, cosine) — the union channel score. */
  score: number;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Connected components over candidate pairs (union-find). */
export function buildComponents(pairs: CandidatePair[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // path compression
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const members = new Set<string>();
  for (const p of pairs) {
    for (const id of [p.aId, p.bId]) {
      if (!parent.has(id)) parent.set(id, id);
      members.add(id);
    }
    union(p.aId, p.bId);
  }
  const groups = new Map<string, string[]>();
  for (const id of members) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(id);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/**
 * Trim oversized components: drop the weakest edges and recompute until no
 * component exceeds maxSize (LHCb's dynamic-threshold idea, lightweight).
 * Returns the surviving pairs.
 */
export function trimOversized(pairs: CandidatePair[], maxSize: number = MAX_CLUSTER): CandidatePair[] {
  let current = pairs;
  for (;;) {
    const components = buildComponents(current);
    const oversized = new Set(components.filter((c) => c.length > maxSize).flat());
    if (oversized.size === 0) return current;
    // Remove the single weakest edge that touches an oversized component.
    let weakest: CandidatePair | undefined;
    for (const p of current) {
      if (!oversized.has(p.aId) && !oversized.has(p.bId)) continue;
      if (!weakest || p.score < weakest.score) weakest = p;
    }
    if (!weakest) return current;
    current = current.filter((p) => p !== weakest);
  }
}

/** Every unordered pair of members already in the judged cache? */
export function everyPairCached(memberIds: readonly string[], cache: ReadonlySet<string>): boolean {
  for (let i = 0; i < memberIds.length; i++) {
    for (let j = i + 1; j < memberIds.length; j++) {
      if (!cache.has(pairKey(memberIds[i]!, memberIds[j]!))) return false;
    }
  }
  return true;
}

// --- Cluster judge -----------------------------------------------------------

export interface ClusterJudgeGroup {
  canonical: string;
  members: number[]; // 1-based indices into the cluster list
  reason?: string;
}

export function buildClusterJudgePrompt(
  members: Array<{ name: string; type: string; definition?: string | null }>,
): string {
  const list = members
    .map((m, i) => `${i + 1}. ${m.name} (${m.type})${m.definition ? ` — ${m.definition}` : ""}`)
    .join("\n");
  return `以下是从学科知识图谱中聚出的一组实体，它们的名称相似。请把【指向同一概念】的实体分组。

实体列表：
${list}

判定规则：
- 同一概念：缩写与全称、中英文异名、单复数、连字符/词序变体、常见别称。
- 不是同一概念：变体与原型、子类与父类、部分与整体、同领域的不同方法/指标/数据集——即使关系很近也要分开。

只返回 JSON 对象：{"groups": [{"canonical": "该组的规范名称", "members": [序号...], "reason": "一句话"}], "singletons": [各自独立的序号...]}，members 至少 2 个序号，不要输出其他内容。`;
}

/** Salvage-parse the cluster judge response; invalid groups are dropped. */
export function parseClusterJudgeResponse(response: string, clusterSize: number): ClusterJudgeGroup[] {
  try {
    const cleaned = response.replace(/```(?:json)?/g, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    if (!Array.isArray(parsed["groups"])) return [];
    const groups: ClusterJudgeGroup[] = [];
    for (const g of parsed["groups"] as Array<Record<string, unknown>>) {
      if (!Array.isArray(g["members"]) || typeof g["canonical"] !== "string") continue;
      const members = [...new Set(g["members"] as unknown[])]
        .filter((m): m is number => typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= clusterSize)
        .sort((x, y) => x - y);
      if (members.length < 2) continue;
      groups.push({
        canonical: g["canonical"],
        members,
        ...(typeof g["reason"] === "string" ? { reason: g["reason"] } : {}),
      });
    }
    return groups;
  } catch {
    return [];
  }
}

// NOTE: cosine similarity is NOT re-defined here — text/cosine-scan.ts owns
// the canonical implementation (this package's single export surface forbids
// the name collision DA had between modules).

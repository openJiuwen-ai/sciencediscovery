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
 * Entity resolver (online write-time track), ported from the DeepAnalyze
 * scholarly/entity-resolver module.
 *
 * Decides whether an extraction candidate names an entity ALREADY in the
 * graph (merge → attach names as aliases) or is genuinely new. Layered
 * gates, cheapest first (industry alignment: Graphiti 2025 layered dedupe;
 * DEG-RAG arXiv:2510.14271 direct-merge):
 *
 *   L0 exact    — normalized name hits canonical_name
 *   L1 alias    — candidate name or any of its aliases hits an existing
 *                 alias / canonical name
 *   L2 abbrev   — document-internal Schwartz–Hearst pair: candidate is an
 *                 abbreviation whose long form is in the graph (or vice
 *                 versa)
 *   L3 embed    — ANN cosine ≥ embedHigh + same type + non-core → merge
 *   L3.5 gate   — short/low-entropy names distrust embeddings: trgm
 *                 recall feeds L4 first; embedding gray zone only as
 *                 fallback when trgm recalls nothing (abbrev↔full-form)
 *   L4 judge    — gray-zone LLM verdict over ALL recalled neighbors
 *                 (not just top-1), budgeted, fail-open to 'new'
 *
 * Every layer fails OPEN to 'new' — which is exactly the pre-resolution
 * behavior, so a resolver outage can only miss merges, never corrupt.
 *
 * Port note: DeepAnalyze read the mode switch and thresholds from env +
 * plugin JSON inside this module; this package is IO-free, so both are
 * resolved by the services layer and injected via ResolverContext.
 */

import { normalizeEntityName } from "./normalize.js";

export type ResolveVia = "exact" | "alias" | "abbrev" | "embedding" | "llm" | "none";

export interface ResolutionDecision {
  action: "merge" | "new";
  /** Target entity id when action = 'merge'. */
  targetId?: string;
  via: ResolveVia;
  score?: number;
  rationale?: string;
  /** Normalized names (candidate name + its aliases) the caller should
   *  attach to the target on merge so future lookups hit L1. */
  attachNames?: string[];
}

export interface ResolverThresholds {
  /** Cosine ≥ embedHigh (+ same type + target not core) → merge directly. */
  embedHigh: number;
  /** Cosine < embedLow → new; [embedLow, embedHigh) is the LLM gray zone. */
  embedLow: number;
  /** Trigram similarity recall line for short/low-entropy names (L3.5). */
  trgmCandidate: number;
  /** Elastic per-document LLM judge budget (not a hard system cap). */
  maxJudgePerDoc: number;
  /** Core-entity grounding list size injected into the extraction prompt. */
  coreEntityListSize: number;
}

export const DEFAULT_RESOLVER_THRESHOLDS: ResolverThresholds = {
  embedHigh: 0.95,
  embedLow: 0.8,
  trgmCandidate: 0.5,
  maxJudgePerDoc: 8,
  coreEntityListSize: 50,
};

/** Resolution mode: off (byte-identical pre-resolution behavior) |
 *  shadow (decide + audit, never alter writes) | on (merge decisions act). */
export type EntityResolutionMode = "off" | "shadow" | "on";

/** The graph entity shape the resolver reasons over. Aliases and
 *  canonicalName are NORMALIZED (the storage adapter normalizes). */
export interface ResolverEntity {
  id: string;
  canonicalName: string;
  aliases: readonly string[];
  entityType: string;
  definition: string | null;
  supportCount: number;
  trustLevel: string;
  createdAt: string;
}

export interface ResolverCandidate {
  name: string;
  type: string;
  definition?: string;
  aliases?: string[];
}

/** Minimal repo surface the resolver needs (injectable for tests/eval). */
export interface ResolverRepo {
  getByName(kbId: string, canonicalName: string): Promise<ResolverEntity | undefined>;
  findByAlias(kbId: string, normalizedAlias: string): Promise<ResolverEntity | undefined>;
  /** L3: ANN recall. Absent → embedding layers skip (fail-open). */
  nearestByEmbedding?(kbId: string, vec: number[], limit: number): Promise<Array<ResolverEntity & { cosine: number }>>;
  /** L3.5: trigram recall for short/low-entropy names. Absent → gate skips. */
  similarByName?(kbId: string, name: string, minSim: number, limit: number): Promise<Array<ResolverEntity & { sim: number }>>;
}

// --- L4 judge -----------------------------------------------------------------

export interface JudgeSide {
  name: string;
  type: string;
  definition?: string | null;
}

export interface JudgeVerdict {
  verdict: "same" | "similar-but-distinct" | "unrelated";
  /** Suggested canonical name (only meaningful when verdict = same). */
  canonical?: string;
  reason?: string;
}

/** LLM judge abstraction — the pipeline wires the real model, tests mock it. */
export type JudgeFn = (a: JudgeSide, b: JudgeSide) => Promise<JudgeVerdict>;

export function buildJudgePrompt(a: JudgeSide, b: JudgeSide): string {
  const fmt = (s: JudgeSide) =>
    `名称: ${s.name}\n类型: ${s.type}\n定义: ${s.definition ?? "（无）"}`;
  return `判断以下两个实体是否指向同一个学科概念。

实体 A：
${fmt(a)}

实体 B：
${fmt(b)}

判定规则：
- same：同一概念的不同写法——缩写与全称、中英文异名、单复数、连字符/词序变体、常见别称。
- similar-but-distinct：相似但不是同一概念——变体与原型、子类与父类、部分与整体、同领域的不同方法/指标/数据集。即使关系很近，只要内涵不同就判此类。
- unrelated：无关概念。

只返回 JSON 对象：{"verdict": "same"|"similar-but-distinct"|"unrelated", "canonical": "建议的规范名称（仅 verdict=same 时给出）", "reason": "一句话理由"}，不要输出其他内容。`;
}

/** Parse the judge's JSON response (salvage-style, mirrors extraction). */
export function parseJudgeVerdict(response: string): JudgeVerdict | null {
  try {
    const cleaned = response.replace(/```(?:json)?/g, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    if (parsed["verdict"] === "same" || parsed["verdict"] === "similar-but-distinct" || parsed["verdict"] === "unrelated") {
      return {
        verdict: parsed["verdict"],
        ...(typeof parsed["canonical"] === "string" ? { canonical: parsed["canonical"] } : {}),
        ...(typeof parsed["reason"] === "string" ? { reason: parsed["reason"] } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export interface ResolverContext {
  /** Document-internal abbreviation pairs from extractAbbrevPairs. */
  abbrevMap?: Map<string, string>;
  thresholds?: ResolverThresholds;
  /** L3: name → embedding (null/throw = embeddings unavailable, L3 skips).
   *  Callers should precompute a batch and serve from a Map. */
  embed?: (text: string) => Promise<Float32Array | number[] | null>;
  /** L4: gray-zone LLM judge. Absent → gray zone falls through to 'new'. */
  judge?: JudgeFn;
  /** Elastic per-document judge budget. */
  budget?: { judgeLeft: number };
}

/** L3.5: short / low-entropy names — embeddings are untrustworthy here
 *  (Graphiti entropy-gate rule: a ≤4-char name collides semantically too
 *  easily, so recall goes through string similarity + judge instead). */
export function isLowEntropyName(normalizedName: string): boolean {
  return normalizedName.length <= 4;
}

function attachNamesFor(cand: ResolverCandidate): string[] {
  const out = new Set<string>();
  const push = (n: string | undefined) => {
    if (!n) return;
    const nn = normalizeEntityName(n);
    if (nn) out.add(nn);
  };
  push(cand.name);
  for (const a of cand.aliases ?? []) push(a);
  return [...out];
}

function mergeDecision(
  target: ResolverEntity,
  via: ResolveVia,
  cand: ResolverCandidate,
  extra?: Partial<ResolutionDecision>,
): ResolutionDecision {
  return { action: "merge", targetId: target.id, via, attachNames: attachNamesFor(cand), ...extra };
}

/**
 * Resolve one extraction candidate against the existing graph.
 * Deterministic layers L0–L2 first, then embedding/judge layers L3–L4
 * when the context provides them; every layer fails open to 'new'.
 */
export async function resolveEntityCandidate(
  repos: ResolverRepo,
  kbId: string,
  cand: ResolverCandidate,
  ctx: ResolverContext = {},
): Promise<ResolutionDecision> {
  const normalized = normalizeEntityName(cand.name);
  if (!normalized) return { action: "new", via: "none" };

  // L0 — exact canonical hit.
  const exact = await repos.getByName(kbId, normalized);
  if (exact) return mergeDecision(exact, "exact", cand);

  // L1 — candidate name as alias; then each of its aliases against
  // canonical names and aliases.
  const aliasHit = await repos.findByAlias(kbId, normalized);
  if (aliasHit) return mergeDecision(aliasHit, "alias", cand);
  for (const alias of cand.aliases ?? []) {
    const na = normalizeEntityName(alias);
    if (!na || na === normalized) continue;
    const byName = await repos.getByName(kbId, na);
    if (byName) return mergeDecision(byName, "alias", cand);
    const byAlias = await repos.findByAlias(kbId, na);
    if (byAlias) return mergeDecision(byAlias, "alias", cand);
  }

  // L2 — document-internal abbreviation pairs.
  if (ctx.abbrevMap && ctx.abbrevMap.size > 0) {
    // Candidate IS an abbreviation defined in this document: merge into the
    // long form when that long form is already in the graph.
    const longForm = ctx.abbrevMap.get(normalized);
    if (longForm) {
      const nf = normalizeEntityName(longForm);
      const hit = (await repos.getByName(kbId, nf)) ?? (await repos.findByAlias(kbId, nf));
      if (hit) {
        return mergeDecision(hit, "abbrev", cand, { rationale: `doc abbrev pair: ${normalized} → ${nf}` });
      }
    }
    // Candidate is a long form whose abbreviation is already in the graph.
    for (const [abbr, full] of ctx.abbrevMap) {
      if (normalizeEntityName(full) !== normalized) continue;
      const hit = (await repos.getByName(kbId, abbr)) ?? (await repos.findByAlias(kbId, abbr));
      if (hit) {
        return mergeDecision(hit, "abbrev", cand, { rationale: `doc abbrev pair: ${abbr} → ${normalized}` });
      }
    }
  }

  // L3.5 — low-entropy names: string-similarity recall first, then judge.
  // (Runs before L3 for short names — embeddings are untrustworthy here.)
  const th = ctx.thresholds ?? DEFAULT_RESOLVER_THRESHOLDS;
  const lowEntropy = isLowEntropyName(normalized);
  let trgmRecalled = false;
  if (lowEntropy && repos.similarByName) {
    try {
      const similars = await repos.similarByName(kbId, normalized, th.trgmCandidate, 3);
      trgmRecalled = similars.length > 0;
      for (const s of similars) {
        const judged = await judgeGate(cand, s, s.sim, ctx);
        if (judged) return judged;
      }
    } catch {
      // trgm unavailable — fall through
    }
  }

  // L3 — embedding ANN recall. Only reached when nothing deterministic hit;
  // every failure here fails open to 'new'.
  // Low-entropy names never merge directly off embeddings (short names
  // collide semantically too easily); they only fall back to the embedding
  // gray zone when trgm recalled nothing — abbreviation↔full-form pairs are
  // invisible to trgm (~0.05) but land in the embedding gray zone (measured
  // 0.81–0.88 on real splits like pdb/hprd/dca).
  if (ctx.embed && repos.nearestByEmbedding && !(lowEntropy && trgmRecalled)) {
    try {
      const vec = await ctx.embed(cand.name);
      if (vec && vec.length > 0) {
        const neighbors = await repos.nearestByEmbedding(kbId, Array.from(vec), 5);
        if (!lowEntropy) {
          // High-confidence direct merge: first neighbor meeting the bar.
          // Core targets always go to the judge instead (a wrong merge into
          // a hub node is the costliest error).
          for (const n of neighbors) {
            if (n.cosine >= th.embedHigh && n.entityType === cand.type && n.trustLevel !== "core") {
              return mergeDecision(n, "embedding", cand, { score: n.cosine });
            }
          }
        }
        // Gray zone (incl. ≥high but type conflict or core target): judge
        // EVERY neighbor ≥ embedLow in recall order until one verdicts same
        // or the elastic budget runs out — the true target is frequently the
        // 2nd/3rd neighbor (e.g. a generic-name node outranks it on cosine).
        for (const n of neighbors) {
          if (n.cosine < th.embedLow) break;
          const judged = await judgeGate(cand, n, n.cosine, ctx);
          if (judged) return judged;
        }
      }
    } catch {
      // embeddings unavailable mid-run — fall through
    }
  }

  return { action: "new", via: "none" };
}

/** L4 gray-zone judge gate. Returns a merge decision only on verdict=same;
 *  null otherwise (caller falls through to 'new'). Budgeted and fail-open.
 *  Judged merges always record via='llm' regardless of the recall channel
 *  (the channel score is preserved in `score`) — DA-faithful. */
async function judgeGate(
  cand: ResolverCandidate,
  target: ResolverEntity,
  score: number | undefined,
  ctx: ResolverContext,
): Promise<ResolutionDecision | null> {
  if (!ctx.judge || !ctx.budget || ctx.budget.judgeLeft <= 0) return null;
  ctx.budget.judgeLeft--;
  try {
    const verdict = await ctx.judge(
      { name: cand.name, type: cand.type, definition: cand.definition },
      { name: target.canonicalName, type: target.entityType, definition: target.definition },
    );
    if (verdict.verdict !== "same") return null;
    return mergeDecision(target, "llm", cand, {
      ...(score !== undefined ? { score } : {}),
      rationale: verdict.reason ?? `judge: same${verdict.canonical ? ` (canonical: ${verdict.canonical})` : ""}`,
    });
  } catch {
    return null; // judge failure fails open
  }
}

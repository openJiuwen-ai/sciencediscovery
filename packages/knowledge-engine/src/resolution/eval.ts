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
 * Entity-resolution eval harness core, ported from the DeepAnalyze
 * scripts/entity-resolution-eval module. Pure and IO-free: the CLI wrapper
 * (file loading, real embed/judge wiring) lives outside this package.
 *
 * Dataset format (JSON):
 *   graph: fixture entities [{id, name, type, aliases?, definition?}]
 *   items: [{id, gold: same|similar|unrelated, candidate: {name, type,
 *           definition?, aliases?}, docText?, expectTarget?, note?}]
 *   - same: the decision must merge AND target expectTarget
 *   - similar / unrelated: the decision must be new (any merge is a false
 *     merge — the most dangerous error)
 *
 * Metrics: pairwise P/R/F1 (merge = predicted positive, same = gold
 * positive; a merge to the wrong target counts FP+FN), B-cubed P/R/F1
 * (gold clusters by expectTarget, predicted by targetId, new = singleton),
 * per-class accuracy, merge rate. Ship gate: same precision ≥ 0.95,
 * recall ≥ 0.60, similar accuracy ≥ 0.90.
 */

import { extractAbbrevPairs } from "./abbrev.js";
import { normalizeEntityName } from "./normalize.js";
import { trigramSimilarity } from "../text/trigram.js";
import { cosineSimilarity } from "../text/cosine-scan.js";
import {
  resolveEntityCandidate,
  DEFAULT_RESOLVER_THRESHOLDS,
  type ResolutionDecision,
  type ResolverContext,
  type ResolverEntity,
  type ResolverRepo,
} from "./resolver.js";

// --- Dataset ------------------------------------------------------------------

export interface ErEntity {
  id: string;
  name: string;
  type: string;
  aliases?: string[];
  definition?: string;
}

export interface ErItem {
  id: string;
  gold: "same" | "similar" | "unrelated";
  candidate: { name: string; type: string; definition?: string; aliases?: string[] };
  /** When present, Schwartz–Hearst builds the L2 abbrev map from it. */
  docText?: string;
  /** Expected merge target when gold = same. */
  expectTarget?: string;
  note?: string;
}

export interface ErDataset {
  id: string;
  kind: "entity-resolution";
  description?: string;
  construction?: unknown;
  graph: ErEntity[];
  items: ErItem[];
}

/** Parse + validate a dataset from raw JSON text (IO stays with the caller). */
export function parseErDataset(json: string): ErDataset {
  const ds = JSON.parse(json) as ErDataset;
  if (ds.kind !== "entity-resolution") throw new Error("not an entity-resolution dataset");
  const ids = new Set(ds.graph.map((e) => e.id));
  for (const item of ds.items) {
    if (item.gold === "same" && (!item.expectTarget || !ids.has(item.expectTarget))) {
      throw new Error(`item ${item.id}: gold=same but expectTarget ${item.expectTarget} not in graph`);
    }
    if (item.gold !== "same" && item.expectTarget) {
      throw new Error(`item ${item.id}: gold=${item.gold} must not set expectTarget`);
    }
  }
  return ds;
}

// --- In-memory fixture repo ----------------------------------------------------

export interface MemoryRepoOptions {
  /** entity id → embedding vector; enables L3 nearestByEmbedding (in-memory cosine). */
  embeddings?: Map<string, number[]>;
  /** true enables L3.5 similarByName (the package trigram, pg_trgm-equivalent). */
  enableTrgm?: boolean;
}

export function buildMemoryRepo(graph: ErEntity[], opts: MemoryRepoOptions = {}): ResolverRepo {
  const entities: ResolverEntity[] = graph.map((e) => ({
    id: e.id,
    canonicalName: normalizeEntityName(e.name),
    aliases: (e.aliases ?? []).map(normalizeEntityName),
    entityType: e.type,
    definition: e.definition ?? null,
    supportCount: 1,
    trustLevel: "candidate",
    createdAt: "2026-01-01T00:00:00Z",
  }));
  const repo: ResolverRepo = {
    getByName: async (_kb, name) => {
      const n = normalizeEntityName(name);
      return entities.find((e) => e.canonicalName === n);
    },
    findByAlias: async (_kb, alias) => {
      const n = normalizeEntityName(alias);
      return entities.find((e) => e.aliases.includes(n));
    },
  };
  if (opts.embeddings) {
    const embeddings = opts.embeddings;
    repo.nearestByEmbedding = async (_kb, vec, limit) =>
      entities
        .map((e) => {
          const ev = embeddings.get(e.id);
          return ev ? { ...e, cosine: cosineSimilarity(vec, ev) } : null;
        })
        .filter((x): x is ResolverEntity & { cosine: number } => x !== null)
        .sort((x, y) => y.cosine - x.cosine)
        .slice(0, limit);
  }
  if (opts.enableTrgm) {
    repo.similarByName = async (_kb, name, minSim, limit) =>
      entities
        .map((e) => ({ ...e, sim: trigramSimilarity(name, e.canonicalName) }))
        .filter((x) => x.sim >= minSim)
        .sort((x, y) => y.sim - x.sim)
        .slice(0, limit);
  }
  return repo;
}

// --- Scoring (pure) ------------------------------------------------------------

export interface ScoredItem {
  id: string;
  gold: ErItem["gold"];
  predicted: "merge-correct" | "merge-wrong-target" | "merge-on-new" | "new";
  correct: boolean;
  decision: { action: string; targetId?: string; via: string; score?: number; rationale?: string };
}

export function scoreItem(item: ErItem, decision: ResolutionDecision): ScoredItem {
  const base = {
    id: item.id,
    gold: item.gold,
    decision: {
      action: decision.action,
      ...(decision.targetId !== undefined ? { targetId: decision.targetId } : {}),
      via: decision.via,
      ...(decision.score !== undefined ? { score: decision.score } : {}),
      ...(decision.rationale !== undefined ? { rationale: decision.rationale } : {}),
    },
  };
  if (item.gold === "same") {
    if (decision.action === "merge" && decision.targetId === item.expectTarget) {
      return { ...base, predicted: "merge-correct", correct: true };
    }
    if (decision.action === "merge") {
      return { ...base, predicted: "merge-wrong-target", correct: false };
    }
    return { ...base, predicted: "new", correct: false };
  }
  // similar / unrelated: any merge is a false merge
  return decision.action === "merge"
    ? { ...base, predicted: "merge-on-new", correct: false }
    : { ...base, predicted: "new", correct: true };
}

export interface ErMetrics {
  pairwise: { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number };
  bcubed: { precision: number; recall: number; f1: number };
  perClass: Record<string, { total: number; correct: number; accuracy: number }>;
  mergeRate: number;
  gate: { precisionOk: boolean; recallOk: boolean; similarOk: boolean; pass: boolean };
}

export const ER_GATE = { minPrecision: 0.95, minRecall: 0.6, minSimilarAccuracy: 0.9 };

/**
 * Aggregate metrics. goldClusterOf maps an item id to its gold cluster key
 * (same-gold items share their expectTarget's cluster; everything else is a
 * singleton) — the caller supplies it because ScoredItem deliberately does
 * not duplicate the dataset's expectTarget.
 */
export function computeMetrics(
  scored: ScoredItem[],
  goldClusterOf: (id: string) => string,
): ErMetrics {
  let tp = 0,
    fp = 0,
    fn = 0;
  for (const s of scored) {
    if (s.predicted === "merge-correct") tp++;
    else if (s.predicted === "merge-wrong-target") {
      fp++;
      fn++;
    } else if (s.predicted === "merge-on-new") fp++;
    else if (s.gold === "same") fn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  // B-cubed
  const predOf = new Map<string, string>();
  const goldOf = new Map<string, string>();
  for (const s of scored) {
    predOf.set(s.id, s.decision.action === "merge" ? `p:${s.decision.targetId}` : `p:${s.id}`);
    goldOf.set(s.id, goldClusterOf(s.id));
  }
  const byCluster = (m: Map<string, string>) => {
    const inv = new Map<string, Set<string>>();
    for (const [item, c] of m) {
      if (!inv.has(c)) inv.set(c, new Set());
      inv.get(c)!.add(item);
    }
    return inv;
  };
  const goldInv = byCluster(goldOf);
  const predInv = byCluster(predOf);
  let bpSum = 0,
    brSum = 0;
  for (const s of scored) {
    const g = goldInv.get(goldOf.get(s.id)!)!;
    const p = predInv.get(predOf.get(s.id)!)!;
    let inter = 0;
    for (const x of g) if (p.has(x)) inter++;
    bpSum += inter / p.size;
    brSum += inter / g.size;
  }
  const bp = scored.length > 0 ? bpSum / scored.length : 1;
  const br = scored.length > 0 ? brSum / scored.length : 1;
  const bf = bp + br > 0 ? (2 * bp * br) / (bp + br) : 0;

  const perClass: ErMetrics["perClass"] = {};
  for (const cls of ["same", "similar", "unrelated"]) {
    const inCls = scored.filter((s) => s.gold === cls);
    const correct = inCls.filter((s) => s.correct).length;
    perClass[cls] = {
      total: inCls.length,
      correct,
      accuracy: inCls.length > 0 ? correct / inCls.length : 1,
    };
  }

  const merges = scored.filter((s) => s.decision.action === "merge").length;
  const mergeRate = scored.length > 0 ? merges / scored.length : 0;

  const gate = {
    precisionOk: precision >= ER_GATE.minPrecision,
    recallOk: recall >= ER_GATE.minRecall,
    similarOk: (perClass["similar"]?.accuracy ?? 1) >= ER_GATE.minSimilarAccuracy,
    pass: false,
  };
  gate.pass = gate.precisionOk && gate.recallOk && gate.similarOk;

  return {
    pairwise: { tp, fp, fn, precision, recall, f1 },
    bcubed: { precision: bp, recall: br, f1: bf },
    perClass,
    mergeRate,
    gate,
  };
}

// --- Runner --------------------------------------------------------------------

export async function runErItem(
  item: ErItem,
  repos: ResolverRepo,
  ctx: ResolverContext = {},
): Promise<ScoredItem> {
  const abbrevMap = item.docText ? extractAbbrevPairs(item.docText) : undefined;
  // The judge budget is per-item here (production budgets per document; the
  // eval treats each item as its own "document").
  const budget = ctx.judge
    ? { judgeLeft: (ctx.thresholds ?? DEFAULT_RESOLVER_THRESHOLDS).maxJudgePerDoc }
    : ctx.budget;
  const decision = await resolveEntityCandidate(repos, "kb", item.candidate, {
    ...ctx,
    ...(abbrevMap ? { abbrevMap } : {}),
    ...(budget ? { budget } : {}),
  });
  return scoreItem(item, decision);
}

/** Gold cluster key for an item (same-gold items share expectTarget). */
export function goldClusterOf(dataset: ErDataset): (id: string) => string {
  const byId = new Map(dataset.items.map((i) => [i.id, i]));
  return (id: string) => {
    const item = byId.get(id);
    if (!item) return `g:${id}`;
    return item.gold === "same" ? `g:${item.expectTarget}` : `g:${item.id}`;
  };
}

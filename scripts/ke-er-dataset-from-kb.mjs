#!/usr/bin/env node
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
 * ke-er-dataset-from-kb: build an entity-resolution eval dataset from a LIVE
 * knowledge base (阶段 V / V3-C5). Read-only against the stack — safe to run
 * while the stack serves other traffic.
 *
 * What it emits (schema of packages/knowledge-engine/src/resolution/eval.ts):
 *   graph:  every entity of the KB [{id, name, type, aliases, definition}]
 *   items:  gold=same ONLY, one per (entity, alias) — the KB's own alias list
 *           is the authoritative source, so these labels need no human review.
 *           Trivial aliases (normalizing to the canonical name itself) are
 *           skipped — an exact self-match tests nothing.
 *   review: same-type entity PAIRS sharing a >=4-char content word, emitted
 *           under a separate top-level "review" array — NOT scored items. A
 *           human must triage each pair (true near-duplicate → merge the
 *           entities, or distinct → promote to items with gold:"similar")
 *           before the dataset feeds the ship gate. Auto-labeling these
 *           "similar" would be the machine grading its own homework: a real
 *           duplicate hiding in the KB would become a false gold label.
 *   unrelated items are NOT synthesized: any name we invent might legitimately
 *     belong in a domain KB, and a wrong "unrelated" label silently rewards
 *     false merges. Document that gap in the consuming report instead.
 *
 * Entity aliases are NOT on the graph route (lean entities only) — the builder
 * fetches each entity's detail route (GET /api/knowledge-engine/entities/:id).
 *
 * Env: SD_BASE (default http://127.0.0.1:4310), SD_TOKEN (required).
 *
 * Usage:
 *   node scripts/ke-er-dataset-from-kb.mjs --kb <kbId|name> \
 *     [--out packages/knowledge-engine/test-datasets/entity-resolution/pairs.<slug>.json] \
 *     [--limit N] [--maxReview 100] [--concurrency 4]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keDist = path.join(repoRoot, "packages", "knowledge-engine", "dist", "index.js");
if (!existsSync(keDist)) {
  console.error("[er-dataset] packages/knowledge-engine/dist missing — run `pnpm build` first");
  process.exit(1);
}
const { normalizeEntityName, parseErDataset } = await import(pathToFileURL(keDist).href);

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const kbRef = opt("kb");
const limit = opt("limit") ? Number(opt("limit")) : undefined;
const maxReview = Number(opt("maxReview") ?? 100);
const concurrency = Math.min(8, Math.max(1, Number(opt("concurrency") ?? 4)));
const BASE = (process.env.SD_BASE ?? "http://127.0.0.1:4310").replace(/\/+$/, "");
const TOKEN = process.env.SD_TOKEN;

if (!kbRef || !TOKEN) {
  console.error(
    "Usage: node scripts/ke-er-dataset-from-kb.mjs --kb <kbId|name> [--out <file>] " +
      "[--limit N] [--maxReview 100] [--concurrency 4]\nSD_TOKEN env is required.",
  );
  process.exit(1);
}
for (const [name, value] of [
  ["--maxReview", maxReview],
  ["--concurrency", concurrency],
  ...(limit !== undefined ? [["--limit", limit]] : []),
]) {
  if (!Number.isFinite(value) || value < 1) {
    console.error(`[er-dataset] ${name} 必须是正数（收到 "${opt(name.slice(2))}"）`);
    process.exit(1);
  }
}

const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };

async function apiJson(pathname) {
  const resp = await fetch(`${BASE}${pathname}`, { headers: H });
  if (!resp.ok) {
    throw new Error(`GET ${pathname} → HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  return resp.json();
}

// --- content words (shared-word review heuristic) -----------------------------
// ASCII words need >=4 chars; CJK runs (no whitespace tokenization) need >=4
// chars too — shorter tokens ("cell", "the", 中文双字词) collide across
// unrelated entities and flood the review queue.

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "via",
  "cell", "cells", "human", "mouse", "viral", "virus", "protein", "proteins",
  "gene", "genes", "disease", "diseases", "pathway", "pathways",
]);

function contentWords(name) {
  const words = new Set();
  for (const m of name.toLowerCase().matchAll(/[a-z0-9]+|[一-鿿]+/g)) {
    const w = m[0];
    if (w.length < 4) continue;
    if (STOP_WORDS.has(w)) continue;
    words.add(w);
  }
  return words;
}

// --- main ---------------------------------------------------------------------

async function main() {
  // Resolve --kb (id or exact name match) against the KB list.
  const kbsBody = await apiJson("/api/knowledge-engine/kbs");
  const kbs = kbsBody?.kbs ?? kbsBody;
  if (!Array.isArray(kbs)) {
    console.error(`[er-dataset] 意外的 KB 列表响应形状：${JSON.stringify(kbsBody).slice(0, 200)}`);
    process.exit(1);
  }
  const kb = kbs.find((k) => k.id === kbRef) ?? kbs.find((k) => k.name === kbRef);
  if (!kb) {
    console.error(
      `[er-dataset] KB "${kbRef}" not found. Available:\n` +
        kbs.map((k) => `  ${k.id}  ${k.name}`).join("\n"),
    );
    process.exit(1);
  }
  console.log(`[er-dataset] KB: ${kb.name} (${kb.id}) @ ${BASE}`);

  const graph = await apiJson(`/api/knowledge-engine/kbs/${encodeURIComponent(kb.id)}/graph`);
  let entities = (graph.entities ?? []).map((e) => ({ id: e.id, name: e.name, type: e.type }));
  entities.sort((a, b) => (a.id < b.id ? -1 : 1));
  if (limit) entities = entities.slice(0, limit);
  console.log(`[er-dataset] graph: ${entities.length} entities — fetching details (aliases)…`);

  // Detail fetch with a small concurrency pool (aliases live on the detail route).
  const detailed = new Array(entities.length);
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(concurrency, entities.length) }, async () => {
    while (cursor < entities.length) {
      const i = cursor++;
      const e = entities[i];
      try {
        const body = await apiJson(`/api/knowledge-engine/entities/${encodeURIComponent(e.id)}`);
        detailed[i] = {
          id: e.id,
          name: body.entity.name,
          type: body.entity.type,
          ...(body.entity.aliases?.length ? { aliases: body.entity.aliases } : {}),
          ...(body.entity.description ? { definition: body.entity.description } : {}),
        };
      } catch (err) {
        // A vanished entity (deleted between graph and detail) degrades to the
        // lean row — it loses its aliases/same items but stays a valid graph node.
        console.warn(`  warn: entity ${e.id} detail failed (${err instanceof Error ? err.message : err}) — lean row kept`);
        detailed[i] = { id: e.id, name: e.name, type: e.type };
      }
      done++;
      if (done % 25 === 0 || done === entities.length) {
        console.log(`  details ${done}/${entities.length}`);
      }
    }
  });
  await Promise.all(workers);

  // gold=same items: one per (entity, alias); skip trivial self-normalizing aliases.
  // P1: an alias shared by MULTIPLE entities (real KBs do this — "GP" on two
  // glycoproteins) produces same items pointing at different expectTargets for
  // the same candidate name; deterministic layers must fail one of them, which
  // would burn the ship gate on KB ambiguity, not resolver regression. Emit
  // the items (they are the honest L3/L4 exam) but flag them loudly.
  const aliasOwners = new Map(); // normalized alias → Set<entityId>
  for (const e of detailed) {
    const canonical = normalizeEntityName(e.name);
    for (const alias of e.aliases ?? []) {
      const norm = normalizeEntityName(alias);
      if (norm === canonical) continue;
      if (!aliasOwners.has(norm)) aliasOwners.set(norm, new Set());
      aliasOwners.get(norm).add(e.id);
    }
  }
  const items = [];
  let ambiguousAliases = 0;
  for (const e of detailed) {
    const canonical = normalizeEntityName(e.name);
    for (const [ai, alias] of (e.aliases ?? []).entries()) {
      const norm = normalizeEntityName(alias);
      if (norm === canonical) continue;
      const owners = aliasOwners.get(norm).size;
      if (owners > 1) ambiguousAliases++;
      items.push({
        id: `same-${e.id}-${ai}`,
        gold: "same",
        candidate: { name: alias, type: e.type },
        expectTarget: e.id,
        note:
          owners > 1
            ? `歧义别名（${owners} 个实体共享 "${alias}"）——预期只有 L3/L4 能判对；ship gate 未过时先区分「消解器退化」vs「KB 别名歧义」`
            : "KB 内别名（权威来源，无需人工复核）",
      });
    }
  }
  if (ambiguousAliases > 0) {
    console.warn(
      `[er-dataset] 警告：${ambiguousAliases} 个 same 项来自跨实体共享别名（KB 数据歧义），` +
        `确定性基线对它们必判错一部分——评估 gate 时先看这批`,
    );
  }

  // review pairs: same-type entities sharing a content word. Deterministic
  // order (sorted ids); groups larger than REVIEW_GROUP_CAP are truncated —
  // O(n²) on a 10k-entity "concept" group is pointless, the first hundreds of
  // pairs already saturate a human review session.
  const REVIEW_GROUP_CAP = 300;
  const byType = new Map();
  for (const e of detailed) {
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type).push(e);
  }
  const review = [];
  let reviewTruncated = false;
  outer: for (const [type, group] of [...byType.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const capped = group.length > REVIEW_GROUP_CAP ? group.slice(0, REVIEW_GROUP_CAP) : group;
    const wordsOf = capped.map((e) => contentWords(e.name));
    for (let i = 0; i < capped.length; i++) {
      for (let j = i + 1; j < capped.length; j++) {
        const shared = [...wordsOf[i]].filter((w) => wordsOf[j].has(w)).sort();
        if (shared.length === 0) continue;
        if (review.length >= maxReview) {
          // 截断即停——精确统计溢出需要跑完整个 O(n²)，对人类复核队列没有价值
          reviewTruncated = true;
          break outer;
        }
        review.push({
          id: `review-${capped[i].id}-${capped[j].id}`,
          candidate: {
            name: capped[j].name,
            type,
            ...(capped[j].definition ? { definition: capped[j].definition } : {}),
          },
          sharedWith: {
            entityId: capped[i].id,
            name: capped[i].name,
            // 人工分流要看定义才能判「重复 vs 不同」——两侧都带上
            ...(capped[i].definition ? { definition: capped[i].definition } : {}),
          },
          sharedWords: shared,
          suggestedGold: "similar",
          note: "人工复核：若实为重复实体 → 去 KB 里 merge 它们（本条删除）；若确为不同实体 → 提升为 items 条目（gold:\"similar\"，去 sharedWith/suggestedGold 字段）",
        });
      }
    }
  }

  const slug = kb.name.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || kb.id;
  const outPath = path.resolve(
    opt("out") ??
      path.join(repoRoot, "packages", "knowledge-engine", "test-datasets", "entity-resolution", `pairs.${slug}.json`),
  );
  const dataset = {
    id: `kb-${slug}-${new Date().toISOString().slice(0, 10)}`,
    kind: "entity-resolution",
    description:
      `实体消解评测集（活 KB "${kb.name}" 自动构建）。items 仅含 gold=same（KB 自带别名，权威标签）；` +
      `review 数组是同类型共享内容词的疑似重复实体对，必须人工分流（merge 或提升为 gold:"similar" 条目）后才计入 ship gate；` +
      `不合成 unrelated 条目（无法诚实构造——编造的名字可能恰是领域合法实体，错误标签会奖励误并）。`,
    construction: {
      method: "live-kb",
      kb: { id: kb.id, name: kb.name },
      base: BASE,
      generatedAt: new Date().toISOString(),
      ...(limit ? { entityLimit: limit } : {}),
      reviewHeuristic:
        "同类型实体对共享 >=4 字符内容词（ASCII/CJK 词，停用词表剔除高频泛词）；类型组截断 " +
        `${REVIEW_GROUP_CAP} 实体，review 上限 ${maxReview} 条`,
      caveats: [
        "graph 路由是瘦实体（无 aliases）——别名来自逐实体 detail 路由，抓取期间被删的实体降级为瘦行",
        "确定性 L0-L2 基线预期能过大部分 same 项（alias 精确命中即 L1）；review 分流后的 similar 项才是误并风险的真实考卷",
      ],
    },
    graph: detailed,
    items,
    review,
  };

  // Self-check: the emitted items must pass the harness's own validation
  // (same → expectTarget in graph). review 不参与校验（非评分条目）。
  parseErDataset(JSON.stringify({ ...dataset, review: undefined }));

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(dataset, null, 2), "utf-8");
  console.log(
    `\n[er-dataset] graph ${detailed.length} entities | same items ${items.length} | review pairs ${review.length}` +
      (reviewTruncated ? `（已达 --maxReview ${maxReview} 上限，后续对被截断）` : ""),
  );
  console.log(`[er-dataset] dataset: ${outPath}`);
  console.log(
    "[er-dataset] 下一步：人工分流 review 数组 → 运行 " +
      `node scripts/ke-resolution-eval.mjs --set pairs.${slug} [--trgm]`,
  );
}

await main();

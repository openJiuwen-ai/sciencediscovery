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
 * W10 citation-chain store + route tests: migration v4 (ke_citations /
 * ke_formulae), replace-then-read round-trips, filters, cross-KB 404s, and
 * the entity_unified_search citations section wiring.
 */

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { createKnowledgeEngineTools } from "./tools.js";
import { KnowledgeEngineStore } from "./store.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

function seedCitationDoc(store: KnowledgeEngineStore, kbId: string, dedupKey: string, title: string, authors: string[], year: number | null, fulltext: string | null) {
  return store.upsertDocument({ kbId, dedupKey, title, authors, year, status: fulltext ? "ready" : "pending", ...(fulltext ? { fulltext } : {}) });
}

test("citations: replace/list/filter/stats round-trip", async (context) => {
  const root = tempRoot("ke-citations-store");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  const citing = seedCitationDoc(store, kb.id, "doi:10.1/citing", "Citing paper", ["Anna Author"], 2020,
    "# Intro\n\nUses the method [@b1]. Methods section too [@b1].\n\n## References\n\n- [b1] Bob B, et al. 2019 J Immunol.");
  const cited = seedCitationDoc(store, kb.id, "doi:10.1/bob", "Bob 2019 paper", ["Bob Beta", "Carl Co"], 2019, "Body text.");

  store.replaceCitations(kb.id, citing.id, [
    { kbId: kb.id, srcDocId: citing.id, dstDocId: cited.id, dstKey: "b1", sentence: "Uses the method [@b1].", section: "Intro", intent: "uses", confidence: 0.9 },
    { kbId: kb.id, srcDocId: citing.id, dstDocId: null, dstKey: "b1", sentence: "Methods section too [@b1].", section: "Intro", intent: null, confidence: null },
  ]);
  store.replaceFormulae(kb.id, citing.id, [
    { kbId: kb.id, docId: citing.id, latex: "K_d = 4", displayLatex: "K_d = 4", context: "binding affinity […formula…] measured", label: "eq:kd", section: null },
  ]);

  const all = store.listCitations(kb.id);
  assert.equal(all.length, 2);
  const linked = all.find((row) => row.sentence === "Uses the method [@b1].")!;
  assert.equal(linked.srcTitle, "Citing paper");
  assert.equal(linked.dstTitle, "Bob 2019 paper");

  const byIntent = store.listCitations(kb.id, { intent: "uses" });
  assert.equal(byIntent.length, 1);
  assert.equal(byIntent[0]!.sentence.includes("[@b1]"), true);

  const byDst = store.listCitations(kb.id, { dstDocId: cited.id });
  assert.equal(byDst.length, 1);

  // Re-derivation replaces: same anchors minus one → one row left.
  store.replaceCitations(kb.id, citing.id, [
    { kbId: kb.id, srcDocId: citing.id, dstDocId: cited.id, dstKey: "b1", sentence: "Uses the method [@b1].", section: "Intro", intent: "uses", confidence: 0.9 },
  ]);
  assert.equal(store.listCitations(kb.id).length, 1);

  const stats = store.citationStats(kb.id);
  assert.deepEqual(stats.get(citing.id), { outgoing: 1, outgoingResolved: 1, incoming: 0, incomingResolved: 0 });
  assert.deepEqual(stats.get(cited.id), { outgoing: 0, outgoingResolved: 0, incoming: 1, incomingResolved: 1 });

  const formulae = store.listFormulae(kb.id);
  assert.equal(formulae.length, 1);
  assert.equal(formulae[0]!.docTitle, "Citing paper");
  assert.ok(formulae[0]!.context.includes("[…formula…]"));
  const byQuery = store.listFormulae(kb.id, { q: "K_d" });
  assert.equal(byQuery.length, 1);
  assert.deepEqual(store.listFormulae(kb.id, { q: "zzz-not-there" }), []);
  store.replaceFormulae(kb.id, citing.id, []);
  assert.deepEqual(store.listFormulae(kb.id), []);
});

test("tools: entityUnifiedSearch citations section surfaces sentence mentions", async (context) => {
  const root = tempRoot("ke-citations-tools");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const tools = createKnowledgeEngineTools(store);
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  const citing = seedCitationDoc(store, kb.id, "doi:10.1/citing", "Citing paper", ["Anna Author"], 2020,
    "# Intro\n\nmAb114 builds on prior work [@b1].\n\n## References\n\n- [b1] Bob B, et al. 2019 J Immunol.");
  const cited = seedCitationDoc(store, kb.id, "doi:10.1/bob", "Bob 2019 paper", ["Bob Beta"], 2019, "Body.");
  store.upsertEntity({ kbId: kb.id, name: "mAb114", type: "antibody" });
  store.replaceCitations(kb.id, citing.id, [
    { kbId: kb.id, srcDocId: citing.id, dstDocId: cited.id, dstKey: "b1", sentence: "mAb114 builds on prior work [@b1].", section: "Intro", intent: "extends", confidence: 0.8 },
  ]);

  const result = await tools.entityUnifiedSearch(kb.id, "mAb114", {});
  assert.equal(result.sources.citations.status, "ok");
  const hits = result.sources.citations.hits ?? [];
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.intent, "extends");
  assert.equal(hits[0]!.dstDocId, cited.id);

  const none = await tools.entityUnifiedSearch(kb.id, "zebraquantum", {});
  assert.equal(none.sources.citations.status, "empty");
});

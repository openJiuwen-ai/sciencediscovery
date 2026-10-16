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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import {
  NOVELTY_SIMILAR_COVERAGE,
  PU_CAVEAT_INCONCLUSIVE,
  PU_CAVEAT_NOVEL,
  PU_CAVEAT_SIMILAR,
  briefUncertaintyFrom,
  buildAntiHallucinationBrief,
  combineNovelty,
  noveltyCheck,
  runExternalNoveltyStage,
  verifyCitation,
  type NoveltyExternalSource,
} from "./anti-hallucination.js";
import type { KbSearchDocumentInput } from "./search.js";

const DOC: KbSearchDocumentInput = {
  docId: "doc-1",
  title: "Surfactant protein D study",
  fulltext: [
    "# Surfactant protein D study",
    "",
    "The calcium-dependent interaction of SP-D's CRD domain localizes on the virus spike glycoprotein leading to neutralization of viral infection.",
    "",
    "SP-D was described to facilitate infection in rare cases.",
  ].join("\n"),
};

test("verifyCitation returns three states with per-document evidence", () => {
  const verbatim = verifyCitation({
    kbId: "kb1",
    quote: "localizes on the virus spike glycoprotein leading to neutralization of viral infection",
    documents: [DOC],
  });
  assert.equal(verbatim.state, "verbatim");
  assert.equal(verbatim.verifiedIn.length, 1);
  assert.equal(verbatim.verifiedIn[0]!.state, "verbatim");
  assert.equal(verbatim.note, undefined);

  // ≥85% word overlap but not a substring (one swapped word) → fuzzy with an honest note.
  const fuzzy = verifyCitation({
    kbId: "kb1",
    quote: "The calcium-dependent interaction of SP-D's CRD domain localizes on the virus spike glycoprotein causing neutralization of viral infection",
    documents: [DOC],
  });
  assert.equal(fuzzy.state, "fuzzy");
  assert.match(fuzzy.note ?? "", /paraphrase/i);

  const missing = verifyCitation({ kbId: "kb1", quote: "zebra quantum entanglement cures everything", documents: [DOC] });
  assert.equal(missing.state, "none");
  assert.deepEqual(missing.verifiedIn, []);
  assert.match(missing.note ?? "", /do not present/i);
});

test("noveltyCheck reports collisions and stays honest about scope", () => {
  const collision = noveltyCheck({
    kbId: "kb1",
    claim: "SP-D interacts with the virus spike glycoprotein to cause neutralization of viral infection",
    entities: [
      { name: "SP-D", type: "protein", supportCount: 5, aliases: ["Surfactant protein D"] },
      { name: "glycoprotein", type: "protein", supportCount: 3 },
    ],
    relations: [
      {
        sourceName: "SP-D",
        targetName: "glycoprotein",
        type: "binds",
        supportCount: 2,
        quote: "localized on the virus spike glycoprotein leading to neutralization of viral infection",
      },
    ],
    documents: [DOC],
  });
  // Both entity endpoints are named AND the quote shares the claim's terms.
  assert.equal(collision.verdict, "collision");
  assert.ok(collision.relationHits.length > 0);
  assert.ok(collision.entityHits.length >= 2);
  assert.match(collision.note, /already covers|reframe/i);

  const partial = noveltyCheck({
    kbId: "kb1",
    claim: "glycoprotein folding machinery",
    entities: [
      { name: "SP-D", type: "protein", supportCount: 5 },
      { name: "glycoprotein", type: "protein", supportCount: 3 },
    ],
    relations: [],
    documents: [DOC],
  });
  assert.equal(partial.verdict, "partial");

  const none = noveltyCheck({
    kbId: "kb1",
    claim: "zebra quantum entanglement cures everything",
    entities: [
      { name: "SP-D", type: "protein", supportCount: 5 },
      { name: "glycoprotein", type: "protein", supportCount: 3 },
    ],
    relations: [],
    documents: [DOC],
  });
  assert.equal(none.verdict, "no-collision");
  assert.match(none.note, /wider literature|out of scope/i);
});

test("buildAntiHallucinationBrief renders three tiers, capped and deterministic", () => {
  const uncertainty = briefUncertaintyFrom({ id: "kb1", name: "Ebola" }, {
    entities: [
      { name: "SP-D", supportCount: 5 },
      { name: "mAb114", supportCount: 1 },
    ],
    edges: [
      { type: "contradicts", sourceName: "SP-D", targetName: "mAb114", quote: "SP-D facilitates infection" },
      { type: "binds", sourceName: "SP-D", targetName: "glycoprotein", quote: null },
    ],
  });
  const brief = buildAntiHallucinationBrief([uncertainty]);
  assert.ok(brief);
  assert.match(brief!, /VERIFIED/);
  assert.match(brief!, /UNCERTAIN/);
  assert.match(brief!, /conflict: SP-D contradicts mAb114/);
  assert.match(brief!, /single-source entities \(1\): mAb114/);
  assert.match(brief!, /FORBIDDEN/);
  assert.match(brief!, /validate_entities/);
  assert.ok(brief!.length <= 2_000);
  assert.equal(brief, buildAntiHallucinationBrief([uncertainty]));

  const quiet = buildAntiHallucinationBrief([briefUncertaintyFrom({ id: "kb2", name: "Quiet" }, { entities: [{ name: "X", supportCount: 9 }], edges: [] })]);
  assert.match(quiet!, /- none: no open conflicts/);
  assert.equal(buildAntiHallucinationBrief([]), null);
});

// ------------------------------------------------- V1-Z1 external stage tests

const source = (name: "semantic-scholar" | "openalex", impl: (claim: string, limit: number) => Promise<unknown>): NoveltyExternalSource => ({
  name,
  search: impl as NoveltyExternalSource["search"],
});

const internalNoCollision = noveltyCheck({
  kbId: "kb1",
  claim: "zebra fish regenerate cardiac tissue after cryoinjury",
  entities: [],
  relations: [],
  documents: [],
});

test("runExternalNoveltyStage prefers S2 and scores coverage against the claim", async () => {
  const s2 = source("semantic-scholar", async () => [
    { title: "Zebrafish cardiac regeneration after cryoinjury", year: 2020, url: "https://doi.org/10.1/x", abstract: "cardiac tissue regenerate cryoinjury zebra fish study" },
    { title: "Unrelated magnet paper", year: 2001, url: null, abstract: null },
  ]);
  const openalex = source("openalex", async () => { throw new Error("must not be called when S2 succeeds"); });
  const section = await runExternalNoveltyStage("zebra fish regenerate cardiac tissue after cryoinjury", [s2, openalex], { backoffMs: 0 });
  assert.equal(section.status, "ok");
  assert.deepEqual(section.checkedSources, ["semantic-scholar"]);
  const [top, unrelated] = section.items;
  assert.ok(top, "first item exists");
  assert.ok(unrelated, "second item exists");
  assert.ok(top.aboveThreshold, "claim words all covered → above threshold");
  assert.ok(top.coverage >= NOVELTY_SIMILAR_COVERAGE);
  assert.equal(unrelated.aboveThreshold, false);
  assert.match(top.reason, /external index hit; claim-word coverage \d+%/);
});

test("runExternalNoveltyStage retries S2 once on 429 then falls back to OpenAlex", async () => {
  let s2Calls = 0;
  const s2 = source("semantic-scholar", async () => {
    s2Calls += 1;
    throw new Error("Semantic Scholar API HTTP 429");
  });
  const openalex = source("openalex", async () => [
    { title: "Zebrafish cardiac regeneration", year: 2019, url: null, abstract: null },
  ]);
  const section = await runExternalNoveltyStage("zebra fish cardiac regeneration", [s2, openalex], { backoffMs: 0 });
  assert.equal(s2Calls, 2, "exactly one retry");
  assert.deepEqual(section.checkedSources, ["semantic-scholar", "semantic-scholar(retry)", "openalex"]);
  assert.equal(section.status, "ok");
  assert.match(section.error ?? "", /degraded to openalex/);
});

test("runExternalNoveltyStage reports error when both sources fail", async () => {
  const s2 = source("semantic-scholar", async () => { throw new Error("HTTP 500"); });
  const openalex = source("openalex", async () => { throw new Error("HTTP 403"); });
  const section = await runExternalNoveltyStage("zebra fish cardiac regeneration", [s2, openalex], { backoffMs: 0 });
  assert.equal(section.status, "error");
  assert.match(section.error ?? "", /openalex: HTTP 403/);
  assert.deepEqual(section.items, []);
});

test("combineNovelty: weak claims are inconclusive regardless of probe state", () => {
  const combined = combineNovelty({ claim: "novel", internal: internalNoCollision, external: null });
  assert.equal(combined.verdict, "inconclusive");
  assert.equal(combined.caveat, PU_CAVEAT_INCONCLUSIVE);
  assert.match(combined.reasons[0] ?? "", /not a reliable search term set/);
});

test("combineNovelty: internal collision and external threshold hits both read similar-found", () => {
  const internal = noveltyCheck({
    kbId: "kb1",
    claim: "mAb114 binds Ebola virus glycoprotein and neutralizes the virus",
    entities: [{ name: "mAb114", type: "antibody", supportCount: 4 }],
    relations: [{ sourceName: "mAb114", targetName: "glycoprotein", type: "binds", supportCount: 3, quote: "mAb114 binds GP" }],
    documents: [],
  });
  assert.equal(internal.verdict, "collision");
  const fromGraph = combineNovelty({ claim: "mAb114 binds Ebola virus glycoprotein", internal, external: null });
  assert.equal(fromGraph.verdict, "similar-found");
  assert.equal(fromGraph.caveat, PU_CAVEAT_SIMILAR);
  assert.equal(fromGraph.similarItems[0]?.source, "kb-graph");

  const fromExternal = combineNovelty({
    claim: "zebra fish regenerate cardiac tissue after cryoinjury",
    internal: internalNoCollision,
    external: {
      status: "ok", checkedSources: ["semantic-scholar"], candidates: 1,
      items: [{
        title: "Zebrafish cardiac regeneration", source: "semantic-scholar", coverage: 0.8,
        aboveThreshold: true, reason: "external index hit", link: null, year: 2020,
      }],
    },
  });
  assert.equal(fromExternal.verdict, "similar-found");
});

test("combineNovelty: a failed external probe degrades novel to inconclusive (better to miss than overclaim)", () => {
  const combined = combineNovelty({
    claim: "zebra fish regenerate cardiac tissue after cryoinjury",
    internal: internalNoCollision,
    external: { status: "error", checkedSources: ["semantic-scholar", "openalex"], error: "HTTP 429; HTTP 403", candidates: 0, items: [] },
  });
  assert.equal(combined.verdict, "inconclusive");
  assert.match(combined.reasons.join(" "), /external counter-evidence failed/);
});

test("combineNovelty: a skipped external stage yields novel with the scope disclosed", () => {
  const skipped = combineNovelty({
    claim: "zebra fish regenerate cardiac tissue after cryoinjury",
    internal: internalNoCollision,
    external: null,
  });
  assert.equal(skipped.verdict, "novel");
  assert.match(skipped.caveat, /^PU principle: unseen/);
  assert.match(skipped.caveat, /external stage not executed/);

  const clean = combineNovelty({
    claim: "zebra fish regenerate cardiac tissue after cryoinjury",
    internal: internalNoCollision,
    external: { status: "ok", checkedSources: ["semantic-scholar"], candidates: 0, items: [] },
  });
  assert.equal(clean.verdict, "novel");
  assert.equal(clean.caveat, PU_CAVEAT_NOVEL);
});

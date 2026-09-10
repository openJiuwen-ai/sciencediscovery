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

import assert from "node:assert/strict";
import test from "node:test";

import {
  briefUncertaintyFrom,
  buildAntiHallucinationBrief,
  noveltyCheck,
  verifyCitation,
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

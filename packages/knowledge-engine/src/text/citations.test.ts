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
  applyIntentResults,
  buildIntentPrompt,
  extractCitationContexts,
  extractFormulas,
  parseIntentResponse,
  parseReferenceEntries,
  parseReferenceKey,
  resolveCitedDocuments,
} from "./citations.js";

const MARKDOWN = [
  "# Intro",
  "",
  "The antibody mAb114 binds GP [@b1] and neutralizes the virus. This builds on prior work [@b2, b3].",
  "",
  "## Methods",
  "",
  "We used the assay as described previously [@b1].",
  "",
  "$$",
  "K_d = \\frac{k_{off}}{k_{on}} \\label{eq:kd}",
  "$$",
  "",
  "## References",
  "",
  "- [b1] Corti D, et al. Science 2016;351:1336-1343.",
  "- [b2] Murin CD, et al. (2014) Structure of Ebola GP.",
  "- [b3] Unknown reference without authors.",
].join("\n");

test("extractCitationContexts maps anchors to sentences and sections", () => {
  const contexts = extractCitationContexts(MARKDOWN);
  assert.equal(contexts.length, 4);
  const first = contexts[0]!;
  assert.equal(first.dstKey, "b1");
  assert.equal(first.section, "Intro");
  assert.ok(first.sentence.includes("mAb114"));
  // Multi-key anchors expand one row per key, same sentence.
  const b2 = contexts.find((context) => context.dstKey === "b2")!;
  const b3 = contexts.find((context) => context.dstKey === "b3")!;
  assert.equal(b2.sentence, b3.sentence);
  assert.equal(b2.section, "Intro");
  // Repeated citation later in the document carries the later section.
  const repeat = contexts.filter((context) => context.dstKey === "b1")[1]!;
  assert.equal(repeat.section, "Methods");
  assert.ok(repeat.sentence.includes("as described previously"));
});

test("extractCitationContexts returns empty for anchor-free text", () => {
  assert.deepEqual(extractCitationContexts("No anchors here. Just text."), []);
});

test("extractFormulas pulls display math with label split and context", () => {
  const formulas = extractFormulas(MARKDOWN);
  assert.equal(formulas.length, 1);
  const formula = formulas[0]!;
  assert.equal(formula.label, "eq:kd");
  assert.equal(formula.latex, "K_d = \\frac{k_{off}}{k_{on}}");
  assert.ok(formula.displayLatex.includes("\\label{eq:kd}"));
  assert.ok(formula.context.includes("[…formula…]"));
  assert.deepEqual(extractFormulas("no math"), []);
});

test("parseReferenceEntries reads the jats bibliography shape", () => {
  const entries = parseReferenceEntries(MARKDOWN);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.rid, "b1");
  assert.ok(entries[0]!.text.startsWith("Corti D"));
});

test("parseReferenceKey extracts surname and year from reference text", () => {
  assert.deepEqual(parseReferenceKey("Corti D, et al. Science 2016;351:1336-1343."), { surname: "corti", year: 2016 });
  assert.deepEqual(parseReferenceKey("Murin CD, et al. (2014) Structure of Ebola GP."), { surname: "murin", year: 2014 });
  assert.equal(parseReferenceKey("No year in here"), null);
  assert.equal(parseReferenceKey("2016 only, no author tokens"), null);
});

test("resolveCitedDocuments links only unambiguous (surname, year) matches", () => {
  const contexts = extractCitationContexts(MARKDOWN);
  const references = parseReferenceEntries(MARKDOWN);
  const documents = [
    { docId: "doc-corti", authors: ["Davide Corti", "Ali Zuma"], year: 2016 },
    { docId: "doc-murin", authors: ["Murin, Christina D."], year: 2014 },
    { docId: "doc-corti-dup", authors: ["Enrico Corti"], year: 2016 }, // same (surname, year) → ambiguous
    { docId: "doc-unknown", authors: ["Nobody"], year: 2001 },
  ];
  const resolved = resolveCitedDocuments(contexts, references, documents);
  // b2 (Murin 2014) resolves uniquely; b1 (Corti 2016) is ambiguous → no link;
  // b3 has no usable key → no link.
  assert.equal(resolved.get("b2"), "doc-murin");
  assert.equal(resolved.has("b1"), false);
  assert.equal(resolved.has("b3"), false);
});

test("intent prompt lists whitelist and wraps sentences; parser salvages JSON", () => {
  const prompt = buildIntentPrompt(["Uses the method [@b1].", "Contrasts [@b2]."]);
  assert.match(prompt, /uses\/extends\/contrasts_with/);
  assert.match(prompt, /<sentences>/);
  assert.match(prompt, /1\. Contrasts/);

  const items = parseIntentResponse('思考中…[{"i":0,"intent":"uses","confidence":0.9},{"i":1,"intent":"made-up","confidence":1},{"i":5,"intent":"extends"}]');
  assert.equal(items.length, 3);

  const results = [{ intent: null, confidence: null }, { intent: null, confidence: null }];
  applyIntentResults(results, 0, 2, items);
  assert.deepEqual(results[0], { intent: "uses", confidence: 0.9 });
  // Whitelist violation and out-of-batch index are both ignored.
  assert.deepEqual(results[1], { intent: null, confidence: null });

  // Confidence clamping.
  const clamped = [{ intent: null, confidence: null }];
  applyIntentResults(clamped, 0, 1, parseIntentResponse('[{"i":0,"intent":"mentions","confidence":7}]'));
  assert.deepEqual(clamped[0], { intent: "mentions", confidence: 1 });

  assert.deepEqual(parseIntentResponse("no json at all"), []);
  assert.deepEqual(parseIntentResponse('{"not":"an array"}'), []);
});

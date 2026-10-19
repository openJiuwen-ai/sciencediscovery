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
  buildExtractionCorrectionPrompt,
  isBibliographicOrGeneric,
  MAX_EVIDENCE_QUOTE_CHARS,
  parseExtractionResponse,
  validateExtractionProposal,
} from "./parse.js";
import { buildExtractionPrompt, PROMPT_TEXT_CAP } from "./prompt.js";
import { applyProvenanceGate, verifyEvidence } from "./provenance-gate.js";
import { BIOMEDICAL_SCHEMA, DEFAULT_SCHEMA } from "./schema.js";

void test("parseExtractionResponse extracts entities and relations from fenced JSON", () => {
  const response = `思考过程略。\`\`\`json
  {
    "entities": [
      {"name": "Ebola virus", "type": "virus", "definition": "Filoviridae"},
      {"name": "GP", "type": "protein", "aliases": ["glycoprotein"]},
      {"name": "Stanford University", "type": "other"},
      {"name": "results", "type": "other"}
    ],
    "relations": [
      {"source": "Ebola virus", "target": "GP", "type": "encodes", "evidence_quote": "Ebola virus encodes the glycoprotein GP."},
      {"source": "GP", "target": "Ebola virus", "type": "unknown-type", "evidence_quote": "short"}
    ]
  }
  \`\`\``;
  const { entities, relations } = parseExtractionResponse(response, BIOMEDICAL_SCHEMA);
  // Bibliographic (university) and generic (results) entities filtered.
  assert.deepEqual(entities.map((entity) => entity.name), ["Ebola virus", "GP"]);
  // Unknown edge type falls back to the raw type; too-short evidence filtered.
  assert.equal(relations.length, 1);
  assert.equal(relations[0]?.type, "encodes");
});

void test("parseExtractionResponse tolerates trailing commas and junk", () => {
  const { entities } = parseExtractionResponse('{"entities": [{"name": "GP", "type": "protein",},],}', DEFAULT_SCHEMA);
  assert.equal(entities.length, 1);
  assert.deepEqual(parseExtractionResponse("no json here", DEFAULT_SCHEMA), { entities: [], relations: [] });
});

void test("isBibliographicOrGeneric filters institutions and generic words", () => {
  assert.ok(isBibliographicOrGeneric("MIT University"));
  assert.ok(isBibliographicOrGeneric("methods"));
  assert.ok(isBibliographicOrGeneric("X"));
  assert.ok(isBibliographicOrGeneric("2024"));
  assert.ok(!isBibliographicOrGeneric("Ebola virus glycoprotein"));
  assert.ok(!isBibliographicOrGeneric("mAb114"));
});

void test("validateExtractionProposal accepts a clean proposal with zero rejects", () => {
  const response = JSON.stringify({
    entities: [
      { name: "Ebola virus", type: "virus", definition: "Filoviridae" },
      { name: "glycoprotein", type: "protein" },
    ],
    relations: [{
      source: "Ebola virus", target: "glycoprotein", type: "encodes",
      evidence_quote: "Ebola virus encodes the glycoprotein GP.",
    }],
  });
  const validated = validateExtractionProposal(response, BIOMEDICAL_SCHEMA);
  assert.equal(validated.parseError, null);
  assert.deepEqual(validated.rejects, []);
  assert.equal(validated.entities.length, 2);
  assert.equal(validated.relations.length, 1);
});

void test("validateExtractionProposal rejects schema violations with reason and excerpt", () => {
  const response = JSON.stringify({
    entities: [
      { name: "", type: "protein" },                              // missing name
      { name: "GP", type: "membrane-thing" },                     // bad enum
      { name: "VP40", type: "protein", aliases: [7] },            // bad aliases
      { name: "Stanford University", type: "other" },             // policy screen: silent drop
      { name: "NP", type: "protein" },                            // valid
    ],
    relations: [
      { source: "NP", type: "binds", evidence_quote: "NP binds RNA." },                       // missing target
      { source: "NP", target: "NP", type: "wrap", evidence_quote: "NP wraps the genome." },    // bad edge type
      { source: "NP", target: "NP", evidence_quote: "NP binds RNA." },                        // missing edge type
      { source: "NP", target: "NP", type: "binds", evidence_quote: "short" },                 // quote < 10
      { source: "NP", target: "NP", type: "binds", evidence_quote: "x".repeat(MAX_EVIDENCE_QUOTE_CHARS + 1) },
      { source: "NP", target: "NP", type: "binds", evidence_quote: "NP binds the viral RNA genome." }, // valid
    ],
  });
  const validated = validateExtractionProposal(response, BIOMEDICAL_SCHEMA);
  assert.equal(validated.parseError, null);
  assert.equal(validated.entities.length, 1); // only NP survives
  assert.equal(validated.relations.length, 1);
  const reasons = validated.rejects.map((reject) => reject.reason).sort();
  assert.equal(validated.rejects.length, 8);
  assert.ok(reasons.some((reason) => reason.includes("entity.name is required")));
  assert.ok(reasons.some((reason) => reason.includes("entity.type must be one of")));
  assert.ok(reasons.some((reason) => reason.includes("aliases must be an array of strings")));
  assert.ok(reasons.some((reason) => reason.includes("relation.source and relation.target are required")));
  assert.ok(reasons.some((reason) => reason.includes("relation.type must be one of")));
  assert.ok(reasons.some((reason) => reason.includes("at least 10 characters")));
  assert.ok(reasons.some((reason) => reason.includes(`exceeds ${MAX_EVIDENCE_QUOTE_CHARS} characters`)));
  // Every reject carries a truncated excerpt of the offending raw item.
  for (const reject of validated.rejects) {
    assert.ok(reject.excerpt.length > 0 && reject.excerpt.length <= 200);
  }
});

void test("validateExtractionProposal reports unparseable responses as parse errors", () => {
  const validated = validateExtractionProposal("no json here at all", DEFAULT_SCHEMA);
  assert.equal(validated.parseError, "unparseable-json");
  assert.equal(validated.rejects.length, 1);
  assert.equal(validated.rejects[0]?.section, "response");
  assert.deepEqual(validated.entities, []);
  const shaped = validateExtractionProposal('["an", "array"]', DEFAULT_SCHEMA);
  assert.equal(shaped.parseError, "invalid-shape");
});

void test("buildExtractionCorrectionPrompt itemizes reasons and restates the contract", () => {
  const validated = validateExtractionProposal(
    JSON.stringify({
      entities: [{ name: "GP", type: "membrane-thing" }],
      relations: [{ source: "GP", target: "GP", type: "binds", evidence_quote: "short" }],
    }),
    BIOMEDICAL_SCHEMA,
  );
  const prompt = buildExtractionCorrectionPrompt(validated, BIOMEDICAL_SCHEMA);
  assert.match(prompt, /failed deterministic validation/);
  assert.match(prompt, /entities\[0\]: entity\.type must be one of/);
  assert.match(prompt, /relations\[0\]: relation\.evidence_quote must be at least 10 characters/);
  assert.match(prompt, /virus \/ protein \/ antibody/);
  assert.match(prompt, /binds \/ neutralizes/);
  assert.match(prompt, /COMPLETE corrected JSON/);
  const parseFailed = validateExtractionProposal("garbage", DEFAULT_SCHEMA);
  assert.match(buildExtractionCorrectionPrompt(parseFailed, DEFAULT_SCHEMA), /could not be parsed \(unparseable-json\)/);
});

void test("validateExtractionProposal rejects dangling relation endpoints as evidence", () => {
  const validated = validateExtractionProposal(
    JSON.stringify({
      entities: [
        { name: "NP", type: "protein" },
        // Policy-screened but EMITTED — relations may still reference it.
        { name: "Stanford University", type: "other" },
      ],
      relations: [
        { source: "NP", target: "VP35", type: "binds", evidence_quote: "NP binds VP35 during replication." },
        { source: "NP", target: "Stanford University", type: "uses", evidence_quote: "NP was characterized at Stanford University." },
      ],
    }),
    BIOMEDICAL_SCHEMA,
  );
  // VP35 was never emitted -> rejected with the offending name in the reason.
  assert.equal(validated.relations.length, 1);
  assert.equal(validated.rejects.length, 1);
  assert.match(validated.rejects[0]!.reason, /relation\.target "VP35" does not match any emitted entity name/);
  // The screened entity was still EMITTED, so referencing it is valid input
  // (it silently drops later at the write stage, as before).
  assert.equal(validated.relations[0]!.target, "Stanford University");
});

void test("buildExtractionPrompt embeds schema vocabularies and core entity list", () => {
  const prompt = buildExtractionPrompt("DOC TEXT", {
    schema: BIOMEDICAL_SCHEMA,
    coreEntityLines: ["Ebola virus (virus)"],
  });
  assert.match(prompt, /virus\/protein\/antibody/);
  assert.match(prompt, /binds\/neutralizes/);
  assert.match(prompt, /必须复用该确切名称/);
  assert.match(prompt, /Ebola virus \(virus\)/);
  assert.match(prompt, /DOC TEXT/);
});

void test("buildExtractionPrompt caps document text", () => {
  const prompt = buildExtractionPrompt("x".repeat(PROMPT_TEXT_CAP + 1000), { schema: DEFAULT_SCHEMA });
  assert.ok(prompt.length < PROMPT_TEXT_CAP + 4000);
});

void test("buildExtractionPrompt teaches the vision-annotation secondary-evidence rule", () => {
  const prompt = buildExtractionPrompt("DOC TEXT", { schema: DEFAULT_SCHEMA });
  // Claude's PDF vision pass injects "### Page N vision-model annotation"
  // blocks into the fulltext; the extractor must know they are model
  // generated descriptions (secondary evidence) and prefer verbatim text.
  assert.match(prompt, /vision-model annotation/);
  assert.match(prompt, /二级证据/);
  assert.match(prompt, /优先引用原文/);
});

void test("verifyEvidence accepts verbatim quotes after whitespace normalization", () => {
  const haystack = "The  glycoprotein   mediates viral entry.\nNext sentence here.";
  assert.ok(verifyEvidence("The glycoprotein mediates viral entry.", haystack));
});

void test("verifyEvidence accepts minor punctuation differences at >=85% overlap", () => {
  const haystack = "mAb114 binds the GP core domain with high affinity in vitro.";
  assert.ok(verifyEvidence("mAb114 binds the GP core domain with high affinity.", haystack));
});

void test("verifyEvidence rejects fabricated and short quotes", () => {
  const haystack = "Ebola virus causes severe disease in humans.";
  assert.ok(!verifyEvidence("Ebola virus is harmless to humans.", haystack));
  assert.ok(!verifyEvidence("too short", haystack));
  assert.ok(!verifyEvidence("", haystack));
});

void test("applyProvenanceGate partitions and counts", () => {
  const haystack = "GP mediates entry. NPC1 is the receptor.";
  const relations = [
    { evidence_quote: "GP mediates entry." },
    { evidence_quote: "Something completely different and absent." },
  ];
  const result = applyProvenanceGate(relations, haystack);
  assert.equal(result.verified.length, 1);
  assert.equal(result.dropped, 1);
});

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

import { test } from "node:test";
import assert from "node:assert/strict";

import { isBibliographicOrGeneric, parseExtractionResponse } from "./parse.js";
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

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

import { salvageJson, stripThinkingProcess } from "./llm-text.js";

void test("stripThinkingProcess removes closed think blocks", () => {
  assert.equal(stripThinkingProcess('<think>reasoning with [brackets]</think>{"a": 1}'), '{"a": 1}');
});

void test("stripThinkingProcess removes an unclosed trailing think block", () => {
  assert.equal(stripThinkingProcess('answer<think>still thinking'), "answer");
});

void test("stripThinkingProcess passes through content without blocks", () => {
  assert.equal(stripThinkingProcess('{"a": 1}'), '{"a": 1}');
});

void test("salvageJson prefers a fenced json block", () => {
  const content = 'Here is the result:\n```json\n{"entities": []}\n```\nDone.';
  assert.equal(salvageJson(content), '{"entities": []}');
});

void test("salvageJson finds a balanced object span in prose", () => {
  const content = 'prefix {"a": [1, {"b": 2}]} suffix';
  assert.equal(salvageJson(content), '{"a": [1, {"b": 2}]}');
});

void test("salvageJson handles arrays", () => {
  assert.equal(salvageJson("[1, 2, 3]"), "[1, 2, 3]");
});

void test("salvageJson ignores brackets inside strings", () => {
  assert.equal(salvageJson('{"quote": "a } b { c"}'), '{"quote": "a } b { c"}');
});

void test("salvageJson returns null without JSON", () => {
  assert.equal(salvageJson("no json here"), null);
});

void test("the MiniMax trap: thinking block brackets must not poison salvage", () => {
  // Regression for the DeepAnalyze production bug: a reasoning model whose
  // think block contains [ ... ] — naive first-[ to last-] salvage grabbed
  // the thinking span and silently parsed empty.
  const content = '<think>try options [1, 2] and {"wrong": true}</think>{"right": true}';
  const stripped = stripThinkingProcess(content);
  const salvaged = salvageJson(stripped);
  assert.equal(salvaged, '{"right": true}');
  assert.deepEqual(JSON.parse(salvaged!), { right: true });
});
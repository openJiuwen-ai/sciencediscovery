// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
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
import { test } from "node:test";

import {
  createLocalSessionTitle,
  SESSION_TITLE_MAX_CHARACTERS,
  type ModelProfile,
} from "@science-agent/schema";

import {
  generateRefinedSessionTitle,
  sanitizeRefinedSessionTitle,
} from "./session-naming.js";

const model: ModelProfile = {
  baseUrl: "https://models.example.test/v1",
  createdAt: "2026-07-30T00:00:00.000Z",
  hasApiToken: true,
  id: "model-1",
  model: "naming-model",
  name: "Naming model",
  proxyPolicy: "inherit",
  updatedAt: "2026-07-30T00:00:00.000Z",
  vision: false,
};

test("local Session titles collapse whitespace and truncate by Unicode character", () => {
  assert.equal(createLocalSessionTitle("  Analyze\nTP53   expression  "), "Analyze TP53 expression");
  const title = createLocalSessionTitle("研究单细胞数据中的肿瘤免疫微环境与细胞通讯变化及治疗响应机制");
  assert.equal(Array.from(title).length, SESSION_TITLE_MAX_CHARACTERS);
  assert.equal(title.endsWith("…"), true);
  assert.equal(createLocalSessionTitle(" \n ", "2026-07-30T09:42:00.000Z"), "Session 07-30 09:42");
});

test("refined Session titles remove wrappers, labels, and terminal punctuation", () => {
  assert.equal(sanitizeRefinedSessionTitle("标题：“TP53 表达与预后分析。”"), "TP53 表达与预后分析");
  assert.equal(sanitizeRefinedSessionTitle("\"Title: TP53 cohort comparison.\""), "TP53 cohort comparison");
  assert.equal(sanitizeRefinedSessionTitle("# \"Title: TP53 cohort comparison.\""), "TP53 cohort comparison");
  assert.equal(sanitizeRefinedSessionTitle("**Session title: Marker gene analysis**"), "Marker gene analysis");
  assert.equal(sanitizeRefinedSessionTitle("```text\n# Protein structure comparison\n```"), "Protein structure comparison");
  assert.equal(
    sanitizeRefinedSessionTitle("A comprehensive analysis of TP53 expression across treatment cohorts and cell states…"),
    "A comprehensive analysis of TP53 expression across treatment cohorts and cell states",
  );
  assert.equal(sanitizeRefinedSessionTitle("Title:\nTP53 cohort comparison"), "TP53 cohort comparison");
  assert.equal(sanitizeRefinedSessionTitle(" \n "), undefined);
});

test("Session title refinement uses an OpenAI-compatible model and records provider usage", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const refined = await generateRefinedSessionTitle({
    apiToken: "secret",
    fetchImpl: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "标题：TP53 单细胞表达分析" } }],
        usage: { completion_tokens: 6, prompt_tokens: 18, total_tokens: 24 },
      }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
    firstMessage: "分析单细胞数据中的 TP53 表达",
    model,
  });

  assert.equal(requestBody?.model, model.model);
  assert.equal(requestBody?.thinking, undefined);
  const messages = requestBody?.messages as Array<{ content: string; role: string }>;
  assert.equal(messages[0]?.role, "system");
  assert.doesNotMatch(messages[0]?.content ?? "", /no more than|characters/i);
  assert.equal((requestBody?.messages as Array<{ role: string }>)[1]?.role, "user");
  assert.equal(refined.title, "TP53 单细胞表达分析");
  assert.deepEqual(refined.usage, {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTokens: 18,
    outputTokens: 6,
    totalTokens: 24,
    usageStatus: "reported",
  });
});

test("Session title refinement disables DeepSeek thinking mode", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const refined = await generateRefinedSessionTitle({
    apiToken: "secret",
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "Trump news search" } }],
        usage: { completion_tokens: 3, prompt_tokens: 30, total_tokens: 33 },
      }), { status: 200 });
    },
    firstMessage: "search for news about trumps",
    model: {
      ...model,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
    },
  });

  assert.deepEqual(requestBody?.thinking, { type: "disabled" });
  assert.equal(refined.title, "Trump news search");
});

test("Session title refinement rejects a provider-truncated title", async () => {
  await assert.rejects(generateRefinedSessionTitle({
    apiToken: "secret",
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "length",
        message: { content: "An incomplete title that ends in the middle of" },
      }],
      usage: { completion_tokens: 64, prompt_tokens: 30, total_tokens: 94 },
    }), { status: 200 }),
    firstMessage: "Analyze a large multi-cohort study",
    model,
  }), /truncated its title/);
});

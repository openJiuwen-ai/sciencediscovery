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
} from "@sciencediscovery/schema";

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
  assert.equal(requestBody?.max_tokens, undefined);
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
  assert.equal(requestBody?.max_tokens, 64);
  assert.equal(refined.title, "Trump news search");
});

test("Session title refinement disables thinking on ark too, not just deepseek", async () => {
  // GLM on Volcano Engine's ark honours the same flag. Without it a one-shot
  // naming call spends its budget reasoning about a title.
  let requestBody: Record<string, unknown> | undefined;
  await generateRefinedSessionTitle({
    apiToken: "secret",
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "ODE solver search" } }],
        usage: { completion_tokens: 3, prompt_tokens: 30, total_tokens: 33 },
      }), { status: 200 });
    },
    firstMessage: "write an ODE solver",
    model: {
      ...model,
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      model: "glm-5.2",
    },
  });

  assert.deepEqual(requestBody?.thinking, { type: "disabled" });
});

test("Session title refinement leaves thinking alone on endpoints that do not take the flag", async () => {
  let requestBody: Record<string, unknown> | undefined;
  await generateRefinedSessionTitle({
    apiToken: "secret",
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "A title" } }],
        usage: { completion_tokens: 3, prompt_tokens: 30, total_tokens: 33 },
      }), { status: 200 });
    },
    firstMessage: "anything",
    model: { ...model, baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
  });

  assert.equal(requestBody?.thinking, undefined);
});

test("Session title refinement disables thinking for compatible DeepSeek and GLM model IDs", async () => {
  for (const endpoint of [
    { baseUrl: "https://models.example.test/v1", model: "deepseek-v4-flash" },
    { baseUrl: "https://api.modelarts-maas.com/openai/v1", model: "glm-5.2" },
  ]) {
    let requestBody: Record<string, unknown> | undefined;
    const refined = await generateRefinedSessionTitle({
      apiToken: "secret",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "模型兼容性分析" } }],
          usage: { completion_tokens: 4, prompt_tokens: 20, total_tokens: 24 },
        }), { status: 200 });
      },
      firstMessage: "分析模型兼容性",
      model: { ...model, ...endpoint },
    });

    assert.deepEqual(requestBody?.thinking, { type: "disabled" });
    assert.equal(requestBody?.max_tokens, 64);
    assert.equal(refined.title, "模型兼容性分析");
  }
});

test("Session title refinement retries without thinking for a strict compatible endpoint", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const refined = await generateRefinedSessionTitle({
    apiToken: "secret",
    fetchImpl: async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        return new Response(JSON.stringify({ error: "Unknown field: thinking" }), { status: 400 });
      }
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "Gateway fallback" } }],
        usage: { completion_tokens: 2, prompt_tokens: 20, total_tokens: 22 },
      }), { status: 200 });
    },
    firstMessage: "Test a strict gateway",
    model: { ...model, model: "deepseek-v4-flash" },
  });

  assert.equal(requestBodies.length, 2);
  assert.deepEqual(requestBodies[0]?.thinking, { type: "disabled" });
  assert.equal(requestBodies[0]?.max_tokens, 64);
  assert.equal(requestBodies[1]?.thinking, undefined);
  assert.equal(requestBodies[1]?.max_tokens, undefined);
  assert.equal(refined.title, "Gateway fallback");
});

test("Session title refinement retries without a token limit when a gateway ignores thinking control", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const visibleAnswer = "A comprehensive analysis of TP53 expression across all treatment cohorts";
  const refined = await generateRefinedSessionTitle({
    apiToken: "secret",
    fetchImpl: async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: "length",
            message: { content: "", reasoning_content: "The model spent the entire output budget reasoning" },
          }],
          usage: {
            completion_tokens: 64,
            completion_tokens_details: { reasoning_tokens: 64 },
            prompt_tokens: 30,
            total_tokens: 94,
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: {
            content: visibleAnswer,
            reasoning_content: "This must not become the Session title",
          },
        }],
        usage: { completion_tokens: 120, prompt_tokens: 30, total_tokens: 150 },
      }), { status: 200 });
    },
    firstMessage: "Analyze TP53 expression across all treatment cohorts",
    model: { ...model, model: "deepseek-v4-flash" },
  });

  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0]?.max_tokens, 64);
  assert.deepEqual(requestBodies[0]?.thinking, { type: "disabled" });
  assert.equal(requestBodies[1]?.max_tokens, undefined);
  assert.equal(requestBodies[1]?.thinking, undefined);
  assert.equal(refined.title, createLocalSessionTitle(visibleAnswer));
  assert.equal(Array.from(refined.title).length, SESSION_TITLE_MAX_CHARACTERS);
  assert.deepEqual(refined.usage, {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTokens: 60,
    outputTokens: 184,
    totalTokens: 244,
    usageStatus: "reported",
  });
});

test("Session title refinement keeps a usable provider-limited title", async () => {
  const refined = await generateRefinedSessionTitle({
    apiToken: "secret",
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "length",
        message: { content: "A usable title" },
      }],
      usage: { completion_tokens: 64, prompt_tokens: 30, total_tokens: 94 },
    }), { status: 200 }),
    firstMessage: "Analyze a large multi-cohort study",
    model,
  });

  assert.equal(refined.title, "A usable title");
});

test("Session title refinement rejects a provider-truncated empty title", async () => {
  await assert.rejects(generateRefinedSessionTitle({
    apiToken: "secret",
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "length",
        message: { content: "", reasoning_content: "The model spent the output budget reasoning" },
      }],
      usage: {
        completion_tokens: 64,
        completion_tokens_details: { reasoning_tokens: 64 },
        prompt_tokens: 30,
        total_tokens: 94,
      },
    }), { status: 200 }),
    firstMessage: "Analyze a large multi-cohort study",
    model,
  }), /truncated its title/);
});

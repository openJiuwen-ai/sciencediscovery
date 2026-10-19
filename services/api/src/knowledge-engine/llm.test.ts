// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { callPipelineLlm, callPipelineLlmJson, extractAssistantText } from "./llm.js";

const endpoint = { baseUrl: "http://unused", model: "m" };
const signal = new AbortController().signal;

test("extractAssistantText handles string content", () => {
  assert.equal(extractAssistantText({ role: "assistant", content: "hello" }), "hello");
});

test("extractAssistantText handles anthropic block arrays", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "part1" },
      { type: "text", text: "part2" },
    ],
  };
  assert.equal(extractAssistantText(message), "part1part2");
});

test("extractAssistantText returns empty for missing content", () => {
  assert.equal(extractAssistantText({ role: "assistant" }), "");
});

test("callPipelineLlm strips thinking from the response", async () => {
  const text = await callPipelineLlm(
    { endpoint, invoke: async () => "<think>[not json]</think>  clean answer  " },
    "system",
    "user",
    signal,
  );
  assert.equal(text, "clean answer");
});

test("callPipelineLlmJson salvages and parses JSON", async () => {
  const result = await callPipelineLlmJson<{ entities: string[] }>(
    { endpoint, invoke: async () => 'prose ```json\n{"entities": ["GP"]}\n``` tail' },
    "system",
    "user",
    signal,
  );
  assert.deepEqual(result, { entities: ["GP"] });
});

test("callPipelineLlmJson throws with context when no JSON is present", async () => {
  await assert.rejects(
    () => callPipelineLlmJson({ endpoint, invoke: async () => "no json at all" }, "system", "user", signal),
    /no JSON/,
  );
});

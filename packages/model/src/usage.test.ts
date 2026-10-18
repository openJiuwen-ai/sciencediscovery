// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { normalizeUsage } from "./client.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

const cases = [
  { name: "Chat zero aliases cannot mask standard counts", protocol: "openai-chat-completions", raw: { prompt_tokens: 30393, input_tokens: 0, completion_tokens: 84, output_tokens: 0, total_tokens: 30477 }, expected: [30393, 84, 30477] },
  { name: "Chat keeps reported completion despite inconsistent total", protocol: "openai-chat-completions", raw: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 19 }, expected: [10, 7, 19] },
  { name: "Chat preserves real zero", protocol: "openai-chat-completions", raw: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 }, expected: [10, 0, 10] },
  { name: "Chat authoritative zero wins even over a positive alias", protocol: "openai-chat-completions", raw: { prompt_tokens: 10, completion_tokens: 0, output_tokens: 7, total_tokens: 10 }, expected: [10, 0, 10] },
  { name: "Chat positive aliases are alternatives, not additions", protocol: "openai-chat-completions", raw: { prompt_tokens: 10, input_tokens: 20, completion_tokens: 7, output_tokens: 9, total_tokens: 17, completion_tokens_details: { reasoning_tokens: 6 } }, expected: [10, 7, 17] },
  { name: "Chat falls back when standard fields are absent", protocol: "openai-chat-completions", raw: { input_tokens: 8, output_tokens: 5 }, expected: [8, 5, 13] },
  { name: "Responses uses input and output even with zero Chat aliases", protocol: "openai-responses", raw: { input_tokens: 8, output_tokens: 5, prompt_tokens: 0, completion_tokens: 0, total_tokens: 13, output_tokens_details: { reasoning_tokens: 4 } }, expected: [8, 5, 13] },
  { name: "Anthropic uses input and output", protocol: "anthropic-messages", raw: { input_tokens: 8, output_tokens: 5, prompt_tokens: 20, completion_tokens: 9, total_tokens: 13 }, expected: [8, 5, 13] },
  { name: "Responses authoritative zero is preserved", protocol: "openai-responses", raw: { input_tokens: 8, output_tokens: 0, completion_tokens: 5, total_tokens: 8 }, expected: [8, 0, 8] },
] as const;

for (const { name, protocol, raw, expected } of cases) {
  test(name, () => {
    const usage = normalizeUsage(raw, protocol);
    assert.deepEqual([usage?.inputTokens, usage?.outputTokens, usage?.totalTokens], expected);
  });
}

test("unknown protocol resolves positive aliases by a complete pair matching total", () => {
  const raw = { prompt_tokens: 10, completion_tokens: 7, input_tokens: 20, output_tokens: 9 };
  for (const [total_tokens, input, output] of [[17, 10, 7], [29, 20, 9], [99, 20, 9]]) {
    const usage = normalizeUsage({ ...raw, total_tokens });
    assert.deepEqual([usage?.inputTokens, usage?.outputTokens], [input, output]);
    assert.deepEqual(usage?.aliasConflict, raw);
  }
});

for (const { name, raw, expected } of [
  { name: "Chat output zero", raw: { prompt_tokens: 10, completion_tokens: 0, input_tokens: 20, output_tokens: 9, total_tokens: 10 }, expected: [10, 0, 10] },
  { name: "input/output output zero", raw: { prompt_tokens: 10, completion_tokens: 7, input_tokens: 20, output_tokens: 0, total_tokens: 20 }, expected: [20, 0, 20] },
  { name: "Chat input zero", raw: { prompt_tokens: 0, completion_tokens: 7, input_tokens: 20, output_tokens: 9, total_tokens: 7 }, expected: [0, 7, 7] },
  { name: "input/output input zero", raw: { prompt_tokens: 10, completion_tokens: 7, input_tokens: 0, output_tokens: 9, total_tokens: 9 }, expected: [0, 9, 9] },
  { name: "Chat zero total", raw: { prompt_tokens: 0, completion_tokens: 0, input_tokens: 20, output_tokens: 9, total_tokens: 0 }, expected: [0, 0, 0] },
  { name: "input/output zero total", raw: { prompt_tokens: 10, completion_tokens: 7, input_tokens: 0, output_tokens: 0, total_tokens: 0 }, expected: [0, 0, 0] },
  { name: "input/output wins when both pairs match", raw: { prompt_tokens: 10, completion_tokens: 0, input_tokens: 0, output_tokens: 10, total_tokens: 10 }, expected: [0, 10, 10] },
]) {
  test(`unknown protocol preserves a total-matched pair: ${name}`, () => {
    const { total_tokens, ...aliases } = raw;
    const usage = normalizeUsage(raw);
    assert.deepEqual([usage?.inputTokens, usage?.outputTokens, usage?.totalTokens], expected);
    assert.deepEqual(usage?.aliasConflict, aliases);
  });
}

test("unknown protocol does not let zero hide a positive alias in either direction", () => {
  for (const raw of [
    { prompt_tokens: 100, completion_tokens: 7, input_tokens: 0, output_tokens: 0 },
    { prompt_tokens: 0, completion_tokens: 0, input_tokens: 100, output_tokens: 7 },
  ]) {
    for (const total_tokens of [107, 999, undefined]) {
      const usage = normalizeUsage({ ...raw, total_tokens });
      assert.deepEqual([usage?.inputTokens, usage?.outputTokens, usage?.totalTokens], [100, 7, total_tokens ?? 107]);
      assert.deepEqual(usage?.aliasConflict, raw);
    }
  }
});

test("missing fields can be derived but missing usage is not a zero bill", () => {
  assert.equal(normalizeUsage({ prompt_tokens: 12 }), undefined);
  assert.equal(normalizeUsage(null), undefined);
  assert.equal(normalizeUsage({ prompt_tokens: -1, completion_tokens: NaN }), undefined);
  assert.equal(normalizeUsage({ prompt_tokens: 12, total_tokens: 19 }, "openai-chat-completions")?.outputTokens, 7);
  assert.equal(normalizeUsage({ completion_tokens: 7, total_tokens: 19 }, "openai-chat-completions")?.inputTokens, 12);
});

test("oversized counts cannot overflow normalized totals or masquerade as measured usage", () => {
  assert.equal(normalizeUsage({ input_tokens: Number.MAX_VALUE, output_tokens: Number.MAX_VALUE }, "openai-responses"), undefined);
  assert.equal(normalizeUsage({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }, "openai-responses"), undefined);
});

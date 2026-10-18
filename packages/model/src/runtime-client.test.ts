// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { ProviderModelClient } from "./runtime-client.js";
import { ModelRequestError, type ModelTurn } from "./client.js";
const endpoint = { baseUrl: "http://127.0.0.1:1", model: "synthetic" };
const policy = { maxTokens: 16, maxRetries: 0, requestTimeoutMs: 1000 };
const input = { systemPrompt: "synthetic", history: [{ role: "user", content: "synthetic" }], tools: [] };
for (const failure of ["incomplete", "malformed"] as const) test(`runtime rejects ${failure} stream evidence`, async () => {
  const client = new ProviderModelClient(endpoint, policy, async () => ({ assistantMessage: { role: "assistant", content: "partial" }, toolCalls: [], ...(failure === "incomplete" ? { completionObserved: false } : { streamDiagnostics: { protocol: "openai-responses", unparseableSsePayloads: 1 } }) }));
  await assert.rejects(client.invoke(input, new AbortController().signal, {}), /Model stream/);
});
test("runtime preserves original errors and unavailable usage without failing successful completion", async () => {
  const failure = new ModelRequestError("original provider error", 429);
  const bad = new ProviderModelClient(endpoint, policy, async () => { throw failure; });
  await assert.rejects(bad.invoke(input, new AbortController().signal, {}), e => e === failure);
  assert.equal(bad.isInputTooLargeError(failure), false);
  const turn: ModelTurn = { assistantMessage: { role: "assistant", content: "OK" }, toolCalls: [], completionObserved: true };
  const good = new ProviderModelClient(endpoint, policy, async () => turn);
  assert.equal((await good.invoke(input, new AbortController().signal, {})).usage, undefined);
});

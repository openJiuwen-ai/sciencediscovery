// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { EmptyModelTurnError, ModelRequestError, classifyModelWireError, modelWireDiagnosticsOf } from "./client.js";
import {
  EMPTY_TURN_CLASSES,
  EmptyTurnRecoveryExhaustedError,
  EmptyTurnReplay,
  MAX_EMPTY_TURN_RETRIES,
  emptyTurnRetryDelayMs,
  type EmptyTurnRetry,
} from "./empty-turn-recovery.js";
import type { ModelWireDiagnostics } from "./client.js";

function wire(requestId: string, classification: "reasoning_only" | "empty_completion"): ModelWireDiagnostics {
  const at = new Date().toISOString();
  return {
    requestId, endpoint: "http://model.test", protocol: "openai-chat-completions", model: "stub",
    attempts: 1, retries: 0, startedAt: at, completedAt: at, elapsedMs: 1,
    transportChunks: 1, bytes: 1, sseRecords: 2, sseParseErrors: 0,
    hasText: false, hasToolCalls: false, hasReasoning: classification === "reasoning_only",
    finishReason: "stop", truncated: false, retryErrors: [], error: { classification },
  };
}

test("the shared replay keeps the gateway's bound and backoff", () => {
  assert.equal(MAX_EMPTY_TURN_RETRIES, 2, "the bound is the same for both executors");
  assert.deepEqual([...EMPTY_TURN_CLASSES].sort(), ["empty_completion", "reasoning_only"]);
  assert.equal(emptyTurnRetryDelayMs(1), 250);
  assert.equal(emptyTurnRetryDelayMs(2), 500);
});

test("a replay never re-forwards reasoning and stops once text was exposed", async () => {
  const replay = new EmptyTurnReplay(new AbortController().signal, { maxRetries: 1 });
  const thinking: string[] = [];
  replay.callbacksFor(0, { onThinkingDelta: (delta) => thinking.push(delta) }).onThinkingDelta?.("first thought");
  // The second attempt's reasoning is dropped: the client already saw the first.
  replay.callbacksFor(1, { onThinkingDelta: (delta) => thinking.push(delta) }).onThinkingDelta?.("second thought");
  assert.deepEqual(thinking, ["first thought"]);

  // Text is not replayed either: a turn that already streamed an answer cannot
  // be run again without duplicating it.
  const visible = new EmptyTurnReplay(new AbortController().signal);
  visible.callbacksFor(0, {}).onTextDelta?.("partial answer");
  assert.equal(await visible.replay(new EmptyModelTurnError(wire("text", "empty_completion"))), false);
});

test("only the two empty terminal shapes are replayed, and never for auxiliary requests", async () => {
  const replay = new EmptyTurnReplay(new AbortController().signal, { maxRetries: 0 });
  assert.equal(await replay.replay(new ModelRequestError("upstream refused", 502)), false,
    "a provider failure is not this rule's to absorb");
  const auxiliary = new EmptyTurnReplay(new AbortController().signal, { enabled: false });
  assert.equal(await auxiliary.replay(new EmptyModelTurnError(wire("aux", "empty_completion"))), false,
    "housekeeping and compaction calls are not replayed");
});

test("spending the bound throws the readable failure and keeps its wire record", async () => {
  const retries: EmptyTurnRetry[] = [];
  const replay = new EmptyTurnReplay(new AbortController().signal, { maxRetries: 1, onRetry: (retry) => retries.push(retry) });
  const failure = new EmptyModelTurnError(wire("empty-1", "reasoning_only"));
  assert.equal(await replay.replay(failure), true, "the first empty turn is replayed");
  assert.deepEqual(retries, [{ attempt: 1, maxRetries: 1, classification: "reasoning_only", delayMs: 250 }]);
  const exhausted = await replay.replay(new EmptyModelTurnError(wire("empty-2", "reasoning_only")))
    .then(() => assert.fail("the bound must end the replay"), (error: unknown) => error);
  assert.ok(exhausted instanceof EmptyTurnRecoveryExhaustedError);
  assert.ok(exhausted instanceof EmptyModelTurnError, "it is still an empty terminal turn for diagnostics");
  assert.match(exhausted.message, /returned no answer for this step after 1 retry \(empty terminal turn/i);
  assert.match(exhausted.message, /requestId=empty-2/, "the last attempt's wire summary is preserved");
  assert.equal(classifyModelWireError(exhausted), "reasoning_only", "the wire classification is unchanged");
  assert.equal(modelWireDiagnosticsOf(exhausted)?.requestId, "empty-2",
    "the wire record stays attached to the failure a caller reports");
});

test("an aborted run does not wait out the replay delay", async () => {
  const controller = new AbortController();
  const replay = new EmptyTurnReplay(controller.signal);
  const waiting = replay.replay(new EmptyModelTurnError(wire("empty-abort", "empty_completion")));
  controller.abort();
  await assert.rejects(waiting, /aborted/);
});

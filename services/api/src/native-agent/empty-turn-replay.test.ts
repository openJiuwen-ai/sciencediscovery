// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "@sciencediscovery/orchestration";
import { EmptyModelTurnError, modelWireDiagnosticsOf, type ModelTurn, type ModelWireDiagnostics } from "@sciencediscovery/model";

import { createNativeAgent, setModelTurnStreamerForTest, type ModelTurnStreamer, type NativeAgentOptions } from "./index.js";
import { classifyRunFailure } from "../run-failure.js";

/**
 * #1526: the bounded replay of an empty terminal turn lived only in the
 * JiuwenSwarm model gateway, so the native loop — the default deployment's
 * executor — dropped the turn on the first empty answer and surfaced the raw
 * transport diagnostics. These cases drive the real native loop through the
 * model-turn seam, so they fail on the old behaviour (the run ends on the first
 * attempt) and pass only when the shared replay is wired in.
 */

function workspace(): NativeAgentOptions {
  const root = mkdtempSync(join(tmpdir(), "native-empty-turn-"));
  return {
    config: { baseUrl: "http://model.test", dataDir: root, model: "stub" },
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not called"); },
    executeShell: async () => { throw new Error("not called"); },
    sessionId: "session-empty-turn",
    workspaceRoot: root,
  } as NativeAgentOptions;
}

/** A privacy-safe wire record, as the transport would report it for one attempt. */
function wire(requestId: string, error?: ModelWireDiagnostics["error"]): ModelWireDiagnostics {
  const at = new Date().toISOString();
  return {
    requestId, endpoint: "http://model.test", protocol: "openai-chat-completions", model: "stub",
    attempts: 1, retries: 0, startedAt: at, completedAt: at, elapsedMs: 1,
    transportChunks: 1, bytes: 1, sseRecords: 2, sseParseErrors: 0,
    hasText: false, hasToolCalls: false, hasReasoning: Boolean(error), finishReason: "stop", truncated: false,
    retryErrors: [], ...(error ? { error } : {}),
  };
}

/** The thinking deltas the run forwarded to its clients, in order. */
function thinkingDeltas(events: AgentEvent[]): string[] {
  return events.flatMap((event) => event.type === "message_update"
    && event.assistantMessageEvent.type === "thinking_delta"
    ? [event.assistantMessageEvent.delta] : []);
}

test("native loop replays an empty terminal turn and adopts the second answer", async () => {
  const requests: string[] = [];
  const streamer: ModelTurnStreamer = async (_endpoint, _systemPrompt, _history, _tools, _policy, _signal, callbacks) => {
    const requestId = `empty-${requests.length + 1}`;
    requests.push(requestId);
    callbacks?.onProgress?.();
    if (requests.length === 1) {
      // Reasoning streamed, then the provider closed the turn with neither text
      // nor a tool call: the shape the gateway already replays.
      callbacks?.onThinkingDelta?.("first attempt reasoning");
      callbacks?.onWireDiagnostics?.(wire(requestId, { classification: "reasoning_only" }));
      return { assistantMessage: { role: "assistant", content: "" }, toolCalls: [], completionObserved: true } as ModelTurn;
    }
    callbacks?.onThinkingDelta?.("second attempt reasoning");
    callbacks?.onWireDiagnostics?.(wire(requestId));
    callbacks?.onTextDelta?.("recovered answer");
    return { assistantMessage: { role: "assistant", content: "recovered answer" }, toolCalls: [] } as ModelTurn;
  };
  const restore = setModelTurnStreamerForTest(streamer);
  try {
    const events: AgentEvent[] = [];
    const agent = createNativeAgent(workspace());
    agent.subscribe((event) => events.push(event));
    const result = await agent.execute("answer the question");
    assert.equal(requests.length, 2, "the empty turn is replayed once instead of ending the run");
    assert.equal(result.finalMessages.at(-1)?.content, "recovered answer", "the replayed attempt's answer is adopted");
    assert.equal(events.filter((event) => event.type === "response_start").length, 1,
      "the replay stays inside one model turn");
    assert.deepEqual(thinkingDeltas(events), ["first attempt reasoning"],
      "a replayed attempt does not stream reasoning the client already saw");
  } finally { restore(); }
});

test("native loop stops at the replay bound with a readable failure, keeping the wire summary", async () => {
  const requests: string[] = [];
  const streamer: ModelTurnStreamer = async (_endpoint, _systemPrompt, _history, _tools, _policy, _signal, callbacks) => {
    const requestId = `empty-${requests.length + 1}`;
    requests.push(requestId);
    callbacks?.onProgress?.();
    callbacks?.onThinkingDelta?.(`attempt ${requests.length} reasoning`);
    throw new EmptyModelTurnError(wire(requestId, { classification: "reasoning_only" }));
  };
  const restore = setModelTurnStreamerForTest(streamer);
  try {
    const events: AgentEvent[] = [];
    const agent = createNativeAgent(workspace());
    agent.subscribe((event) => events.push(event));
    const error = await agent.execute("answer the question").then(
      () => { throw new Error("the run must fail once the bounded replay is spent"); },
      (failure: unknown) => failure,
    );
    assert.ok(error instanceof Error);
    assert.equal(requests.length, 3, "two replays plus the initial request");
    assert.match(error.message, /empty terminal turn/i, "the failure still names the shape");
    assert.match(error.message, /returned no answer for this step after 2 retries/i);
    assert.match(error.message, /requestId=empty-3/, "the last attempt's wire summary is preserved");
    assert.match(error.message, /hasReasoning=true/);
    assert.equal(modelWireDiagnosticsOf(error)?.requestId, "empty-3",
      "the wire record stays attached to the exhausted failure for the run's diagnostics");
    assert.equal(classifyRunFailure(error), "server-error", "run-failure.ts keeps classifying it as a model-service failure");
    assert.deepEqual(thinkingDeltas(events), ["attempt 1 reasoning"],
      "reasoning is streamed once, not once per replayed attempt");
  } finally { restore(); }
});

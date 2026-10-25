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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { ChatMessage, RunStreamEvent, SessionRun, SessionRunEvent } from "../src/api/types.js";
import { emptyRunStream } from "../src/run-stream/model.js";
import { foldRunRecords, placeReplays, replayRun, type RunReplay } from "../src/run-stream/replay.js";

/** One persisted event, as the JSON replay route hands it back. */
function record(sequence: number, event: RunStreamEvent, runId = "run-1"): SessionRunEvent {
  return { createdAt: "2026-01-01T00:00:00.000Z", event, runId, sequence, sessionId: "session-1" };
}

function responseStarted(responseId: string, turn = 1): RunStreamEvent {
  return { responseId, turn, type: "assistant.response.started" };
}

function delta(text: string, responseId: string): RunStreamEvent {
  return { delta: text, responseId, type: "assistant.delta" };
}

function message(id: string, role: ChatMessage["role"]): ChatMessage {
  return { content: "", createdAt: "2026-01-01T00:00:00.000Z", id, role };
}

function replay(overrides: Partial<RunReplay> = {}): RunReplay {
  return { runId: "run-1", state: emptyRunStream(), ...overrides };
}

/** A finished run of the server's own record, as `listRuns` hands it over. */
function run(overrides: Partial<SessionRun> = {}): SessionRun {
  return {
    annotationIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "run-1",
    prompt: "",
    queueOrder: 1,
    references: [],
    sessionId: "session-1",
    ...overrides,
  } as SessionRun;
}

/** The state a finished run leaves behind when it answers with `text`. */
function answeredState(text: string): ReturnType<typeof foldRunRecords> {
  return foldRunRecords([record(1, responseStarted("r1")), record(2, delta(text, "r1"))]);
}

test("a run that answered takes the place of the answer it wrote", () => {
  const rebuilt = replayRun(
    run({ assistantMessageId: "answer-a", userMessageId: "question-a" }),
    answeredState("the answer"),
  );
  assert.equal(rebuilt?.messageId, "answer-a");
  assert.equal(rebuilt?.userMessageId, "question-a");
});

test("a run that failed before answering keeps its status line after the question", () => {
  // No answer of its own to stand in for, and nothing to hide behind either:
  // the persisted message, if the server wrote one, stays where it is.
  const state = foldRunRecords([
    record(1, responseStarted("r1")),
    record(2, { error: "API 进程退出", errorCode: "internal", type: "run.failed" }),
  ]);
  const rebuilt = replayRun(run({ assistantMessageId: "answer-a", userMessageId: "question-a" }), state);
  assert.equal(rebuilt?.messageId, undefined);
  assert.equal(rebuilt?.userMessageId, "question-a");
  assert.equal(rebuilt?.state.error?.message, "API 进程退出");
});

test("a run that only thought does not hide the answer it never wrote", () => {
  // Thinking has no persisted form, so it is rebuilt — but it is not an answer,
  // and standing in for one would take the turn's answer off the screen.
  const state = foldRunRecords([
    record(1, responseStarted("r1")),
    record(2, { delta: "想了一下", turn: 1, type: "assistant.thinking.delta" } as RunStreamEvent),
  ]);
  const rebuilt = replayRun(run({ assistantMessageId: "answer-a" }), state);
  assert.equal(rebuilt?.messageId, undefined);
  assert.ok(rebuilt !== undefined);
});

test("a run the server kept no events for is not held at all", () => {
  // The pre-persistence run. An empty reconstruction in the transcript would be
  // a blank turn, and its stored answer is the only account of it there is.
  assert.equal(replayRun(run({ assistantMessageId: "answer-a" }), foldRunRecords([])), undefined);
});

test("folding reads the log in sequence order, not in the order it arrived", () => {
  const state = foldRunRecords([
    record(3, delta(" world", "r1")),
    record(1, responseStarted("r1")),
    record(2, delta("Hello", "r1")),
  ]);
  assert.equal(state.turns[0]?.responses[0]?.content, "Hello world");
});

test("a replay is closed, so nothing in it is still streaming", () => {
  const state = foldRunRecords([record(1, responseStarted("r1")), record(2, delta("done", "r1"))]);
  // No `assistant.response.settled` in this log, and no `run.status`: the state
  // a live stream leaves behind only reaches this shape through `closeRunStream`,
  // which is what the live path calls when its response body ends.
  assert.equal(state.terminal, true);
  assert.equal(state.turns[0]?.responses[0]?.settled, true);
});

test("a run with no events folds to an empty, closed state", () => {
  // A run recorded before events were persisted. Nothing to rebuild, but it
  // must still be a state the view can render — hence the close.
  assert.deepEqual(foldRunRecords([]), { ...emptyRunStream(), terminal: true });
});

test("a reconstruction takes the place of the answer it wrote", () => {
  const placement = placeReplays(
    [replay({ messageId: "answer-b", userMessageId: "question-b" })],
    [message("question-b", "user"), message("answer-b", "assistant")],
  );
  assert.deepEqual([...placement.replacing.keys()], ["answer-b"]);
  assert.equal(placement.following.size, 0);
  assert.deepEqual(placement.trailing, []);
});

test("a run with no answer of its own follows the message that started it", () => {
  // Cancelled before the server wrote an answer: there is nothing to replace,
  // and the run still has to stay where it happened rather than move to the end.
  const placement = placeReplays(
    [replay({ userMessageId: "question-a" })],
    [message("question-a", "user"), message("question-b", "user")],
  );
  assert.equal(placement.replacing.size, 0);
  assert.deepEqual([...placement.following.keys()], ["question-a"]);
  assert.equal(placement.following.get("question-a")?.length, 1);
  assert.deepEqual(placement.trailing, []);
});

test("the answer is preferred over the question when both are in the transcript", () => {
  const placement = placeReplays(
    [replay({ messageId: "answer-a", userMessageId: "question-a" })],
    [message("question-a", "user"), message("answer-a", "assistant")],
  );
  assert.deepEqual([...placement.replacing.keys()], ["answer-a"]);
  assert.equal(placement.following.size, 0);
});

test("a run whose messages are both gone is left over for the end", () => {
  const placement = placeReplays(
    [replay({ messageId: "answer-a", userMessageId: "question-a" })],
    [message("question-b", "user")],
  );
  assert.equal(placement.replacing.size, 0);
  assert.equal(placement.following.size, 0);
  assert.equal(placement.trailing.length, 1);
});

test("one question can carry more than one run", () => {
  const placement = placeReplays(
    [
      replay({ runId: "run-1", userMessageId: "question-a" }),
      replay({ runId: "run-2", userMessageId: "question-a" }),
    ],
    [message("question-a", "user")],
  );
  assert.deepEqual(
    placement.following.get("question-a")?.map((entry) => entry.runId),
    ["run-1", "run-2"],
  );
});

test("run order survives placement", () => {
  const placement = placeReplays(
    [
      replay({ runId: "run-1", messageId: "answer-a" }),
      replay({ runId: "run-2", messageId: "answer-b" }),
      replay({ runId: "run-3", messageId: "answer-c" }),
    ],
    [message("answer-a", "assistant"), message("answer-c", "assistant")],
  );
  assert.deepEqual([...placement.replacing.keys()], ["answer-a", "answer-c"]);
  assert.deepEqual(placement.trailing.map((entry) => entry.runId), ["run-2"]);
});

test("a session with nothing replayed places nothing", () => {
  const placement = placeReplays([], [message("question-a", "user")]);
  assert.equal(placement.replacing.size, 0);
  assert.equal(placement.following.size, 0);
  assert.deepEqual(placement.trailing, []);
});

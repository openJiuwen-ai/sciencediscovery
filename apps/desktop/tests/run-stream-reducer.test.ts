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

import type { RunStreamEvent, Subagent, SubagentStep } from "../src/api/types.js";
import { closeRunStream, reduceRunStream } from "../src/run-stream/reducer.js";
import { emptyRunStream, hasVisibleAnswer, thinkingSteps, type RunStreamState } from "../src/run-stream/model.js";

/** Fold a script of events, which is what both a live stream and a replay are. */
function fold(events: RunStreamEvent[], start: RunStreamState = emptyRunStream()): RunStreamState {
  return events.reduce((state, event) => reduceRunStream(state, event), start);
}

function responseStarted(responseId: string, turn = 1): RunStreamEvent {
  return { responseId, turn, type: "assistant.response.started" };
}

function delta(text: string, responseId?: string): RunStreamEvent {
  return responseId === undefined
    ? ({ delta: text, type: "assistant.delta" } as RunStreamEvent)
    : ({ delta: text, responseId, type: "assistant.delta" } as RunStreamEvent);
}

function subagent(id: string, overrides: Partial<Subagent> = {}): Subagent {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    input: { description: `task ${id}`, prompt: "carry out the task" },
    maxTurns: 12,
    parentTurnId: "turn-1",
    sessionId: "s1",
    status: "running",
    steps: [],
    timeoutSeconds: 600,
    turnCount: 0,
    ...overrides,
  };
}

function step(id: string, overrides: Partial<SubagentStep> = {}): SubagentStep {
  return { content: "", createdAt: "2026-01-01T00:00:00.000Z", id, kind: "tool", ...overrides };
}

test("deltas accumulate into a response's body", () => {
  const state = fold([responseStarted("r1"), delta("Hello", "r1"), delta(", world", "r1")]);
  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0]!.responses[0]!.content, "Hello, world");
  assert.equal(state.turns[0]!.responses[0]!.settled, false);
});

test("thinking goes to the turn, never to a response body", () => {
  const state = fold([
    responseStarted("r1"),
    { delta: "first thought", turn: 1, type: "assistant.thinking.delta" } as RunStreamEvent,
    delta("answer", "r1"),
  ]);
  assert.equal(state.turns[0]!.thinking, "first thought");
  assert.equal(state.turns[0]!.responses[0]!.content, "answer");
  // The two streams must not bleed into each other: thinking shown as the
  // answer is the worst possible rendering bug here.
  assert.equal(hasVisibleAnswer(state), true);
});

test("a snapshot replaces the body", () => {
  const state = fold([
    responseStarted("r1"),
    delta("partial", "r1"),
    { content: "a complete replacement", responseId: "r1", type: "assistant.snapshot" } as RunStreamEvent,
  ]);
  assert.equal(state.turns[0]!.responses[0]!.content, "a complete replacement");
});

test("a truncated snapshot never shortens what is already rendered", () => {
  // The server uses a truncated snapshot to describe part of a long answer.
  // Letting it win would make text the user already read disappear.
  const state = fold([
    responseStarted("r1"),
    delta("the whole first paragraph", "r1"),
    {
      content: "the first",
      responseId: "r1",
      truncated: true,
      type: "assistant.snapshot",
    } as RunStreamEvent,
  ]);
  assert.equal(state.turns[0]!.responses[0]!.content, "the whole first paragraph");
  // Recorded, so the UI can say the text shown is not all of it.
  assert.equal(state.turns[0]!.responses[0]!.truncated, true);
});

test("a longer truncated snapshot still wins", () => {
  const state = fold([
    responseStarted("r1"),
    delta("short", "r1"),
    { content: "short plus more", responseId: "r1", truncated: true, type: "assistant.snapshot" } as RunStreamEvent,
  ]);
  assert.equal(state.turns[0]!.responses[0]!.content, "short plus more");
});

test("a truncated thinking snapshot does not shorten the thinking either", () => {
  const state = fold([
    { content: "a long stretch of reasoning", truncated: true, turn: 1, type: "assistant.thinking.snapshot" } as RunStreamEvent,
    { content: "a long", truncated: true, turn: 1, type: "assistant.thinking.snapshot" } as RunStreamEvent,
  ]);
  assert.equal(state.turns[0]!.thinking, "a long stretch of reasoning");
  assert.equal(state.turns[0]!.thinkingTruncated, true);
});

test("a second response in one turn is a separate block", () => {
  const state = fold([
    responseStarted("r1"),
    delta("before the tool call", "r1"),
    { responseId: "r1", type: "assistant.response.settled" } as RunStreamEvent,
    responseStarted("r2"),
    delta("after the tool call", "r2"),
  ]);
  const responses = state.turns[0]!.responses;
  assert.equal(responses.length, 2);
  assert.equal(responses[0]!.content, "before the tool call");
  assert.equal(responses[0]!.settled, true);
  assert.equal(responses[1]!.content, "after the tool call");
  assert.equal(responses[1]!.settled, false);
});

test("text arriving before its response.started opens a block instead of vanishing", () => {
  const state = fold([delta("orphan text")]);
  assert.equal(state.turns[0]!.responses[0]!.content, "orphan text");
});

test("the persisted answer outranks the assembled deltas", () => {
  const state = fold([
    responseStarted("r1"),
    delta("partial", "r1"),
    {
      files: [],
      message: { content: "the answer of record" },
      type: "run.completed",
    } as unknown as RunStreamEvent,
  ]);
  assert.equal(state.finalContent, "the answer of record");
  assert.equal(state.status, "completed");
  // The streamed block is sealed: nothing more is coming for it.
  assert.equal(state.turns[0]!.responses[0]!.settled, true);
});

test("run.started names the model and supplies the run id", () => {
  const state = fold([
    { model: { id: "m", name: "gpt-4o-mini" }, runId: "run-1", type: "run.started" } as RunStreamEvent,
  ]);
  assert.equal(state.modelName, "gpt-4o-mini");
  assert.equal(state.runId, "run-1");
  assert.equal(state.status, "running");
});

test("run.queued is where the run id first appears, since the POST returns none", () => {
  const state = fold([
    { run: { id: "run-9", status: "queued" }, type: "run.queued" } as RunStreamEvent,
  ]);
  assert.equal(state.runId, "run-9");
  assert.equal(state.status, "queued");
});

test("only a terminal status marks the run terminal", () => {
  const running = fold([{ status: "running", type: "run.status" } as RunStreamEvent]);
  assert.equal(running.terminal, false);
  for (const status of ["cancelled", "completed", "failed", "interrupted"] as const) {
    const state = fold([{ status, type: "run.status" } as RunStreamEvent]);
    assert.equal(state.terminal, true, `${status} must be terminal`);
  }
  // blocked is waiting on the user, not finished.
  assert.equal(fold([{ status: "blocked", type: "run.status" } as RunStreamEvent]).terminal, false);
});

test("terminality is sticky: a later non-terminal status cannot reopen a run", () => {
  const state = fold([
    { status: "cancelled", type: "run.status" } as RunStreamEvent,
    { status: "running", type: "run.status" } as RunStreamEvent,
  ]);
  assert.equal(state.terminal, true);
});

test("closing the stream seals open responses and marks the run terminal", () => {
  const state = closeRunStream(fold([responseStarted("r1"), delta("cut off", "r1")]));
  assert.equal(state.terminal, true);
  assert.equal(state.turns[0]!.responses[0]!.settled, true);
});

test("the run's own start and end times are recorded for the folded line", () => {
  // Both events carry the whole `SessionRun`, and which one has the answer is
  // the server's business: the queueing event knows when it was created, the
  // terminal status knows when it finished.
  const state = fold([
    {
      run: {
        createdAt: "2026-01-01T00:13:33.993Z",
        id: "run-1",
        startedAt: "2026-01-01T00:13:34.000Z",
        status: "queued",
      },
      type: "run.queued",
    } as RunStreamEvent,
    {
      run: {
        createdAt: "2026-01-01T00:13:33.993Z",
        finishedAt: "2026-01-01T00:46:06.303Z",
        id: "run-1",
        startedAt: "2026-01-01T00:13:34.000Z",
        status: "completed",
      },
      status: "completed",
      type: "run.status",
    } as RunStreamEvent,
  ]);
  assert.equal(state.startedAt, Date.parse("2026-01-01T00:13:34.000Z"));
  assert.equal(state.finishedAt, Date.parse("2026-01-01T00:46:06.303Z"));
});

test("a later snapshot cannot un-finish a run, or move its start", () => {
  const started = fold([
    { run: { createdAt: "2026-01-01T00:00:00.000Z", status: "queued" }, type: "run.queued" } as RunStreamEvent,
    {
      run: { createdAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:02:00.000Z", status: "completed" },
      status: "completed",
      type: "run.status",
    } as RunStreamEvent,
  ]);
  // A snapshot that says nothing about the finish is not news that the run is
  // running again — the elapsed time would reset on every redelivery.
  const again = fold(
    [{ run: { createdAt: "2026-01-01T00:00:00.000Z", status: "completed" }, status: "completed", type: "run.status" } as RunStreamEvent],
    started,
  );
  assert.equal(again.finishedAt, started.finishedAt);
  assert.equal(again.startedAt, Date.parse("2026-01-01T00:00:00.000Z"));
});

test("a status event without its snapshot leaves the times alone", () => {
  // Older records, and the reconnect path, can deliver a status without the run
  // it belongs to; the transcript must still render.
  const state = fold([{ status: "running", type: "run.status" } as RunStreamEvent]);
  assert.equal(state.startedAt, undefined);
  assert.equal(state.finishedAt, undefined);
  assert.equal(state.status, "running");
});

test("truncated history and unknown events are counted, not swallowed", () => {
  const state = fold([
    { droppedEvents: 4, type: "run.history.truncated" } as RunStreamEvent,
    { droppedEvents: 2, type: "run.history.truncated" } as RunStreamEvent,
    { type: "something.this.build.has.never.seen" } as RunStreamEvent,
  ]);
  assert.equal(state.droppedEvents, 6);
  assert.equal(state.unknownEvents, 1);
});

test("deferred event types do not count as unknown", () => {
  // Artifacts and the session title are a phase-two surface, not a surprise:
  // counting them would make the "N events this build cannot draw" note
  // permanently wrong.
  const state = fold([
    { type: "artifact.upserted" } as RunStreamEvent,
    { type: "session.updated" } as RunStreamEvent,
  ]);
  assert.equal(state.unknownEvents, 0);
});

test("a tool output frame is neither unknown nor a cursor step", () => {
  // It is a copy of what the substream already holds, so it carries no `id:`
  // line and must not be treated as a gap in the numbering — nor as something
  // this build failed to understand.
  const state = reduceRunStream(
    emptyRunStream(),
    { chunk: "hello", toolCallId: "c1", type: "tool.output" } as RunStreamEvent,
    undefined,
  );
  assert.equal(state.unknownEvents, 0);
  assert.equal(state.lastSequence, undefined);
});

test("a tool call lands after the answer it followed", () => {
  const state = fold([
    responseStarted("r1"),
    delta("let me look", "r1"),
    toolStarted("c1", "read_file"),
    responseStarted("r2"),
    delta("it is 3", "r2"),
  ]);
  const turn = state.turns[0]!;
  assert.equal(turn.tools.length, 1);
  // Index 0 is the answer it followed; the next answer sits after it.
  assert.equal(turn.tools[0]!.after, 0);
  assert.equal(turn.tools[0]!.trace.name, "read_file");
  assert.equal(turn.tools[0]!.trace.status, "running");
});

test("a tool call made before any answer belongs before all of them", () => {
  const state = fold([toolStarted("c1", "list_files"), responseStarted("r1"), delta("done", "r1")]);
  assert.equal(state.turns[0]!.tools[0]!.after, -1);
});

test("a completion keeps the arguments its start carried", () => {
  // The completion event no longer repeats them, so losing them here would
  // blank the input fold of every finished call.
  const state = fold([
    toolStarted("c1", "run_python", { args: { code: "print(1)" }, input: '{"code":"print(1)"}' }),
    { trace: { id: "c1", name: "run_python", outputStream: "tool-c1", status: "completed" }, type: "tool.completed" } as RunStreamEvent,
  ]);
  const trace = state.turns[0]!.tools[0]!.trace;
  assert.deepEqual(trace.args, { code: "print(1)" });
  assert.equal(trace.input, '{"code":"print(1)"}');
  assert.equal(trace.status, "completed");
  assert.equal(trace.outputStream, "tool-c1");
  assert.equal(state.turns[0]!.tools.length, 1);
});

test("a completion that does repeat the arguments keeps its own copy", () => {
  const state = fold([
    toolStarted("c1", "run_python", { args: { code: "old" } }),
    { trace: { args: { code: "new" }, id: "c1", name: "run_python", status: "completed" }, type: "tool.completed" } as RunStreamEvent,
  ]);
  assert.deepEqual(state.turns[0]!.tools[0]!.trace.args, { code: "new" });
});

test("a repeated start of the same call replaces it in place", () => {
  const state = fold([
    toolStarted("c1", "read_file"),
    responseStarted("r1"),
    delta("text", "r1"),
    toolStarted("c1", "read_file", { args: { path: "/a" } }),
  ]);
  const tools = state.turns[0]!.tools;
  assert.equal(tools.length, 1);
  // It keeps the slot it was in rather than moving to the end.
  assert.equal(tools[0]!.after, -1);
  assert.deepEqual(tools[0]!.trace.args, { path: "/a" });
});

test("a completion whose start was missed still appears", () => {
  const state = fold([
    responseStarted("r1"),
    delta("answer", "r1"),
    { trace: { id: "c9", name: "shell", status: "completed" }, type: "tool.completed" } as RunStreamEvent,
  ]);
  assert.equal(state.turns[0]!.tools[0]!.after, 0);
  assert.equal(state.turns[0]!.tools[0]!.trace.status, "completed");
});

test("a permission request is keyed, and its decision sticks", () => {
  const asked = { createdAt: "2026-01-01T00:00:00Z", id: "p1", summary: "跑一段代码", resource: "python:run", state: "pending" };
  const state = fold([
    { request: { ...asked, action: "sandbox" }, type: "permission.required" } as RunStreamEvent,
    { request: { ...asked, action: "sandbox", decidedAt: "2026-01-01T00:00:05Z", decision: "allow_once", state: "allowed" }, type: "permission.resolved" } as RunStreamEvent,
    // A late redelivery of the pending snapshot must not put the buttons back.
    { request: { ...asked, action: "sandbox" }, type: "permission.required" } as RunStreamEvent,
  ]);
  assert.equal(state.permissions.length, 1);
  assert.equal(state.permissions[0]!.request.state, "allowed");
});

function toolStarted(
  id: string,
  name: string,
  extra: { args?: Record<string, unknown>; input?: string } = {},
): RunStreamEvent {
  return {
    trace: { id, name, status: "running", ...extra },
    type: "tool.started",
  } as RunStreamEvent;
}

test("failure and cancellation both keep their reason", () => {
  const failed = fold([
    { error: "provider refused", errorCode: "provider_error", type: "run.failed" } as RunStreamEvent,
  ]);
  assert.equal(failed.error?.message, "provider refused");
  assert.equal(failed.error?.code, "provider_error");

  const cancelled = fold([{ reason: "用户取消", type: "run.cancelled" } as RunStreamEvent]);
  assert.equal(cancelled.cancelledReason, "用户取消");
});

test("the replay cursor only ever moves forward", () => {
  const forward = reduceRunStream(emptyRunStream(), { type: "run.status", status: "running" } as RunStreamEvent, 5);
  assert.equal(forward.lastSequence, 5);
  const backward = reduceRunStream(forward, { type: "run.status", status: "running" } as RunStreamEvent, 3);
  // A reconnect that replays from an older cursor must not send `?after=3` next.
  assert.equal(backward.lastSequence, 5);
});

test("a frame that could not be read still moves the cursor", () => {
  // The stream could not parse the frame, so there is no event to fold — but
  // the frame carried an id, and a reconnect asks for `?after=`. Leaving the
  // cursor where it was would fetch the same unreadable frame again, forever.
  const state = reduceRunStream(emptyRunStream(), null, 4);
  assert.equal(state.lastSequence, 4);
  assert.deepEqual(state.turns, []);
  assert.equal(state.unknownEvents, 0);
  // A frame with no id has no cursor to move.
  assert.equal(reduceRunStream(emptyRunStream(), null).lastSequence, undefined);
});

test("hasVisibleAnswer separates a real answer from thinking alone", () => {
  const thinkingOnly = fold([
    { content: "weighing options", turn: 1, type: "assistant.thinking.snapshot" } as RunStreamEvent,
  ]);
  // Hiding the persisted message for a run that only thought would leave the
  // turn blank, so thinking must not count as an answer.
  assert.equal(hasVisibleAnswer(thinkingOnly), false);
  assert.equal(hasVisibleAnswer(fold([delta("an answer")])), true);
  assert.equal(
    hasVisibleAnswer({ ...emptyRunStream(), finalContent: "persisted" }),
    true,
  );
});

test("a delegated subagent opens one line on the turn it was delegated from", () => {
  const state = fold([
    responseStarted("r1"),
    delta("I will look into this", "r1"),
    { subagent: subagent("a1"), type: "subagent.updated" } as RunStreamEvent,
  ]);
  assert.equal(state.turns.length, 1);
  const entries = state.turns[0]!.subagents;
  assert.equal(entries.length, 1);
  // `after` is the response the model had just written when it delegated, the
  // same anchor a tool call uses — that is what puts the line inside the fold.
  assert.equal(entries[0]!.after, 0);
  assert.equal(entries[0]!.subagent.input.description, "task a1");
});

test("a later snapshot updates the line instead of opening a second one", () => {
  const state = fold([
    responseStarted("r1"),
    { subagent: subagent("a1"), type: "subagent.updated" } as RunStreamEvent,
    responseStarted("r2"),
    delta("the child is still working", "r2"),
    {
      subagent: subagent("a1", {
        status: "completed",
        steps: [step("s1", { content: "read the files" })],
        turnCount: 3,
      }),
      type: "subagent.updated",
    } as RunStreamEvent,
  ]);
  const entries = state.turns.flatMap((turn) => turn.subagents);
  assert.equal(entries.length, 1);
  // The line stays where it was delegated; it does not drift to the newest
  // response just because a snapshot arrived later.
  assert.equal(entries[0]!.after, 0);
  assert.equal(entries[0]!.subagent.status, "completed");
  assert.equal(entries[0]!.subagent.turnCount, 3);
  assert.equal(entries[0]!.subagent.steps.length, 1);
});

test("step and usage events refine a child that has already been announced", () => {
  const state = fold([
    responseStarted("r1"),
    { subagent: subagent("a1"), type: "subagent.updated" } as RunStreamEvent,
    { step: step("s1", { status: "running", toolName: "read_file" }), subagentId: "a1", type: "subagent.step" } as RunStreamEvent,
    { subagentId: "a1", type: "subagent.usage", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } } as RunStreamEvent,
  ]);
  const child = state.turns[0]!.subagents[0]!.subagent;
  assert.equal(child.steps.length, 1);
  assert.equal(child.steps[0]!.toolName, "read_file");
  assert.equal(child.usage?.totalTokens, 7);
});

test("a step that overtakes its snapshot does not invent a line", () => {
  // Without the snapshot there is no task description to name the line with,
  // so a half-populated row would be worse than dropping the event.
  const state = fold([
    responseStarted("r1"),
    { step: step("s1"), subagentId: "ghost", type: "subagent.step" } as RunStreamEvent,
  ]);
  assert.equal(state.turns[0]!.subagents.length, 0);
});

test("a restarted step keeps its place rather than appearing twice", () => {
  const state = fold([
    responseStarted("r1"),
    { subagent: subagent("a1"), type: "subagent.updated" } as RunStreamEvent,
    { step: step("s1", { status: "running" }), subagentId: "a1", type: "subagent.step" } as RunStreamEvent,
    { step: step("s1", { status: "completed" }), subagentId: "a1", type: "subagent.step" } as RunStreamEvent,
  ]);
  const steps = state.turns[0]!.subagents[0]!.subagent.steps;
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.status, "completed");
});

test("a resumed child goes back to running on the same line", () => {
  // A child interrupted by an API restart is continued on the same id; the
  // server reports the resume as a running snapshot, and a line that refused
  // it would stay finished while the work went on.
  const state = fold([
    responseStarted("r1"),
    { subagent: subagent("a1", { status: "failed", error: "restart" }), type: "subagent.updated" } as RunStreamEvent,
    { subagent: subagent("a1", { status: "running" }), type: "subagent.updated" } as RunStreamEvent,
  ]);
  const entries = state.turns.flatMap((turn) => turn.subagents);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.subagent.status, "running");
});

test("thinking paragraphs split into steps on a blank line only", () => {
  assert.deepEqual(thinkingSteps("one\ncontinues\n\n two \n\n\nthree"), [
    "one\ncontinues",
    "two",
    "three",
  ]);
  assert.deepEqual(thinkingSteps("   "), []);
});

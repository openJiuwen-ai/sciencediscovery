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
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ApiClient } from "../src/api/client.js";
import type { ChatMessage, SessionDetail, WorkspaceFile } from "../src/api/types.js";
import { emptyRunStream, type RunStreamState } from "../src/run-stream/model.js";
import type { RunReplay } from "../src/run-stream/replay.js";
import { Conversation } from "../src/views/Conversation.js";

const client = new Proxy({} as ApiClient, {
  get: () => () => Promise.reject(new Error("no request is expected from a static render")),
});

function message(id: string, role: ChatMessage["role"], content: string, kind?: ChatMessage["kind"]): ChatMessage {
  return { content, createdAt: "2026-01-01T00:00:00.000Z", id, kind, role };
}

/** A finished run: one turn that thought something, then answered. */
function answered(runId: string, thinking: string, answer: string): RunStreamState {
  return {
    ...emptyRunStream(),
    modelName: "m",
    runId,
    terminal: true,
    turns: [{
      responses: [{ content: answer, settled: true, truncated: false }],
      subagents: [],
      thinking,
      thinkingTruncated: false,
      tools: [],
      turn: 1,
    }],
  };
}

function detail(messages: ChatMessage[]): SessionDetail {
  return { id: "session-1", messages } as never;
}

function render(over: Partial<Parameters<typeof Conversation>[0]> = {}): string {
  return renderToStaticMarkup(
    <Conversation
      client={client}
      detail={detail([])}
      loading={false}
      onDecidePermission={() => Promise.resolve()}
      replays={[]}
      run={emptyRunStream()}
      workspaceFiles={[]}
      {...over}
    />,
  );
}

/** The transcript of a session that took two turns: a question that was
 *  interrupted, and the automatic wake that carried on from it. */
const TWO_RUNS = [
  message("question-a", "user", "QUESTION-A"),
  message("answer-a", "assistant", "PLAIN-ANSWER-A"),
  message("wake", "user", "", "wake_notice"),
  message("answer-b", "assistant", "PLAIN-ANSWER-B"),
];

const TWO_REPLAYS: RunReplay[] = [
  { messageId: "answer-a", runId: "run-a", state: answered("run-a", "THOUGHT-A", "REBUILT-ANSWER-A"), userMessageId: "question-a" },
  { messageId: "answer-b", runId: "run-b", state: answered("run-b", "THOUGHT-B", "REBUILT-ANSWER-B"), userMessageId: "wake" },
];

test("every finished run is rebuilt in the place of its own answer", () => {
  const markup = render({ detail: detail(TWO_RUNS), replays: TWO_REPLAYS });
  // The point of the whole merge: a run's thinking has no persisted form, so a
  // run that is not replayed leaves a bare answer no one can account for.
  assert.match(markup, /THOUGHT-A/);
  assert.match(markup, /THOUGHT-B/);
  assert.doesNotMatch(markup, /PLAIN-ANSWER-A/);
  assert.doesNotMatch(markup, /PLAIN-ANSWER-B/);
  assert.equal(markup.match(/REBUILT-ANSWER-A/gu)?.length, 1);
});

test("the two runs stay in the order the conversation happened in", () => {
  const markup = render({ detail: detail(TWO_RUNS), replays: TWO_REPLAYS });
  const positions = ["QUESTION-A", "THOUGHT-A", "REBUILT-ANSWER-A", "THOUGHT-B", "REBUILT-ANSWER-B"]
    .map((needle) => {
      const at = markup.indexOf(needle);
      assert.notEqual(at, -1, `${needle} is missing from the transcript`);
      return at;
    });
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

test("the reader's turn is its text alone, in the grey bubble", () => {
  const markup = render({ detail: detail([message("question-a", "user", "QUESTION-A")]) });
  // The handoff draws the question as a grey bubble against the right edge:
  // the bubble's side is the role, so there is no avatar and no 我 line.
  assert.match(markup, /class="message user"><div class="body"><div class="text">QUESTION-A<\/div><\/div>/);
  assert.doesNotMatch(markup, /avatar-mini/);
  assert.doesNotMatch(markup, /class="role"/);
  assert.doesNotMatch(markup, />我</);
});

test("an answer's name is a header above the prose, not a column beside it", () => {
  // The handoff puts the mark and the name on their own line and starts the
  // answer below them at the column's left edge. Nesting the body inside a row
  // beside the avatar is what used to indent every answer by 48px.
  const markup = render({ detail: detail([message("answer-a", "assistant", "PLAIN-ANSWER-A")]) });
  assert.match(
    markup,
    /<div class="assistant-head"><div aria-hidden="true" class="avatar-mini is-brand"><\/div><div class="role"><span>[^<]*<\/span><\/div><\/div><div class="body">.*?PLAIN-ANSWER-A/u,
  );
});

test("an automatic wake leaves no card of its own", () => {
  // A wake carries no user-authored body, so its card was a blank strip. The
  // run it started is the thing to read, and it is still drawn where the wake
  // happened rather than at the end of the conversation.
  const markup = render({ detail: detail(TWO_RUNS), replays: TWO_REPLAYS });
  assert.doesNotMatch(markup, /唤醒/u);
  assert.ok(markup.indexOf("REBUILT-ANSWER-A") < markup.indexOf("THOUGHT-B"));
});

test("the wake's own run is not pushed to the end of the transcript", () => {
  // The notice is still *in* `messages` even though nothing is drawn for it —
  // that is what anchors the wake's run between the two answers. Without it the
  // run would have nowhere to go and would be appended after everything.
  const wakeRun: RunReplay = {
    runId: "run-b",
    state: answered("run-b", "THOUGHT-B", ""),
    userMessageId: "wake",
  };
  const markup = render({ detail: detail(TWO_RUNS), replays: [wakeRun] });
  assert.doesNotMatch(markup, /唤醒/u);
  assert.match(markup, /THOUGHT-B/);
  assert.ok(markup.indexOf("PLAIN-ANSWER-A") < markup.indexOf("THOUGHT-B"));
  assert.ok(markup.indexOf("THOUGHT-B") < markup.indexOf("PLAIN-ANSWER-B"));
});

test("a run with no replay to stand for it keeps its persisted answer", () => {
  // A run recorded before events were persisted replays empty, and is therefore
  // not held at all. Nothing must go missing because of that.
  const markup = render({ detail: detail(TWO_RUNS), replays: [TWO_REPLAYS[0]!] });
  assert.match(markup, /REBUILT-ANSWER-A/);
  assert.match(markup, /PLAIN-ANSWER-B/);
  assert.doesNotMatch(markup, /THOUGHT-B/);
});

test("a run that wrote no answer still stays after the message that started it", () => {
  const orphan: RunReplay = { runId: "run-a", state: answered("run-a", "THOUGHT-A", ""), userMessageId: "answer-a" };
  const markup = render({ detail: detail([message("answer-a", "assistant", "PLAIN-ANSWER-A")]), replays: [orphan] });
  assert.match(markup, /PLAIN-ANSWER-A/);
  assert.ok(markup.indexOf("PLAIN-ANSWER-A") < markup.indexOf("THOUGHT-A"));
});

test("a message just sent keeps the placeholder back for a beat", () => {
  // `pending` is set on the press and the run has no turns until the request
  // comes back. The line stands in for a run the server has not started, so it
  // waits a second instead of landing in the same frame as the press; the
  // message itself is shown at once. The timer is what static markup cannot
  // advance, so what is asserted here is the state before it fires.
  const markup = render({ pending: { content: "JUST-SENT" } });
  assert.match(markup, /JUST-SENT/);
  assert.doesNotMatch(markup, /正在思考/);
});

test("the run still streaming is the last thing in the transcript", () => {
  const live: RunStreamState = {
    ...emptyRunStream(),
    modelName: "m",
    runId: "run-live",
    turns: [{
      responses: [{ content: "LIVE-ANSWER", settled: false, truncated: false }],
      subagents: [],
      thinking: "LIVE-THOUGHT",
      thinkingTruncated: false,
      tools: [],
      turn: 1,
    }],
  };
  const markup = render({ detail: detail(TWO_RUNS), replays: TWO_REPLAYS, run: live });
  assert.match(markup, /LIVE-THOUGHT/);
  assert.ok(markup.indexOf("REBUILT-ANSWER-B") < markup.indexOf("LIVE-ANSWER"));
});

test("a run whose messages are both gone is rendered rather than dropped", () => {
  // Nothing to anchor to, but its events are still the only account of it.
  const stray: RunReplay = {
    messageId: "answer-gone",
    runId: "run-gone",
    state: answered("run-gone", "THOUGHT-GONE", "REBUILT-ANSWER-GONE"),
    userMessageId: "question-gone",
  };
  const markup = render({ detail: detail([message("question-a", "user", "QUESTION-A")]), replays: [stray] });
  assert.match(markup, /THOUGHT-GONE/);
  assert.ok(markup.indexOf("QUESTION-A") < markup.indexOf("THOUGHT-GONE"));
});

test("each run of a session folds into its own line, timed from its own span", () => {
  // Two runs in one transcript, each with its own elapsed time: the line
  // belongs to the run, not to the session, and a session that took two turns
  // has to be able to say how long each took.
  const timed = (runId: string, tail: string, seconds: number): RunStreamState => ({
    ...answered(runId, `THOUGHT-${tail}`, `REPLY-${tail}`),
    finishedAt: Date.parse("2026-01-01T01:00:00.000Z") + seconds * 1000,
    startedAt: Date.parse("2026-01-01T01:00:00.000Z"),
  });
  const markup = render({
    detail: detail(TWO_RUNS),
    replays: [
      { messageId: "answer-a", runId: "run-a", state: timed("run-a", "A", 32 * 60 + 32), userMessageId: "question-a" },
      { messageId: "answer-b", runId: "run-b", state: timed("run-b", "B", 72), userMessageId: "wake" },
    ],
  });
  assert.match(markup, /用时 32 分 32 秒/u);
  assert.match(markup, /用时 1 分 12 秒/u);
  assert.equal(markup.match(/class="msg-collapse run-fold"/gu)?.length, 2);
  // Each line is followed by its own answer, not by the other run's.
  const line = markup.indexOf("用时 32 分 32 秒");
  assert.ok(line < markup.indexOf("REPLY-A"));
  assert.ok(markup.indexOf("REPLY-A") < markup.indexOf("用时 1 分 12 秒"));
});

test("a replayed run's unanswered authorization is history, not a live question", () => {
  // The run ended still waiting on this one, so the card is the only record of
  // what it was blocked on — but nothing is left to unblock, and its buttons
  // must not pretend otherwise.
  const blocked: RunStreamState = {
    ...answered("run-a", "THOUGHT-A", ""),
    permissions: [{
      request: {
        action: "shell",
        createdAt: "2026-01-01T00:00:00.000Z",
        id: "perm-1",
        resource: "shell:echo",
        state: "pending",
        summary: "PERMISSION-SUMMARY",
      },
    }],
  };
  const replay: RunReplay = { runId: "run-a", state: blocked, userMessageId: "question-a" };
  const markup = render({ detail: detail([message("question-a", "user", "QUESTION-A")]), replays: [replay] });
  assert.equal(markup.match(/PERMISSION-SUMMARY/gu)?.length, 1, "the card is rendered once, not once per path");
  assert.match(markup, /<button[^>]*disabled/u);
});

test("an empty transcript draws nothing: the welcome page is not its furniture", () => {
  // The welcome page replaced the line that used to sit here, so a transcript
  // with nothing in it has to stay empty rather than print a slogan of its
  // own. What remains is the frame the messages will fill.
  const markup = render();
  assert.match(markup, /<section class="conversation">/u);
  assert.equal(markup.match(/class="message (?:user|assistant)/gu), null);
  assert.doesNotMatch(markup, /让科研发现更简单/u);
});

/** One uploaded file, as the workspace lists it: the provenance is what says
 *  the reader sent it, and its timestamp is what ties it to a question. */
function upload(name: string, at: string): WorkspaceFile {
  return {
    modifiedAt: at,
    path: name,
    provenance: { fileId: name, origin: "upload", recordedAt: at, revisionId: `${name}@${at}` },
    size: 8,
  };
}

function asked(id: string, content: string, at: string): ChatMessage {
  return { content, createdAt: at, id, role: "user" };
}

test("files sent with a question are drawn above its bubble, two at most", () => {
  const workspaceFiles = [
    upload("行业分析报告.pdf", "2026-01-01T00:01:00.000Z"),
    upload("各AI产品标注功能.xlsx", "2026-01-01T00:02:00.000Z"),
    upload("附录数据.csv", "2026-01-01T00:03:00.000Z"),
    upload("方法说明.docx", "2026-01-01T00:04:00.000Z"),
  ];
  const markup = render({
    detail: detail([asked("q1", "QUESTION-A", "2026-01-01T00:10:00.000Z")]),
    workspaceFiles,
  });
  // The cards come before the bubble: they are what was sent with it.
  assert.ok(markup.indexOf("行业分析报告") < markup.indexOf("QUESTION-A"));
  assert.match(markup, /class="upload-cards is-two has-more"/u);
  assert.equal(markup.match(/class="upload-card"/gu)?.length, 2);
  assert.match(markup, /<small>pdf<\/small>/u);
  assert.match(markup, /<small>xlsx<\/small>/u);
  // Two more than the two cards, and the folded ones stay out of the card row.
  assert.match(markup, />\+2</u);
  assert.match(markup, /aria-label="另外 2 个文件"/u);
  assert.doesNotMatch(markup, /附录数据/u);
  // A card can only ellipsize the name it shows; the whole one is still
  // reachable as its tooltip.
  assert.match(markup, /title="行业分析报告.pdf"/u);
});

test("a file uploaded after the last question waits above the next one", () => {
  const markup = render({
    detail: detail([asked("q1", "QUESTION-A", "2026-01-01T00:01:00.000Z")]),
    workspaceFiles: [upload("waiting.pdf", "2026-01-01T00:20:00.000Z")],
    pending: { content: "QUESTION-B" },
  });
  assert.ok(markup.indexOf("waiting") < markup.indexOf("QUESTION-B"));
  // It belongs to the pending bubble only; the earlier question has no card.
  assert.equal(markup.match(/class="upload-cards /gu)?.length, 1);
});

test("a question without files keeps the bare bubble", () => {
  const markup = render({ detail: detail([asked("q1", "QUESTION-A", "2026-01-01T00:01:00.000Z")]) });
  assert.doesNotMatch(markup, /class="upload-cards"/u);
  assert.match(markup, /class="message user"><div class="body"><div class="text">QUESTION-A<\/div><\/div>/u);
});

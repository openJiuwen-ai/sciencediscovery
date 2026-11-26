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
import type { IdeaResearchView } from "@sciencediscovery/schema";
import { IdeaResearchCards } from "../src/views/idea/IdeaResearchCard.js";
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

function failed(runId: string, code: string, errorMessage: string): RunStreamState {
  return {
    ...emptyRunStream(),
    error: { code, message: errorMessage },
    modelName: "m",
    runId,
    status: "failed",
    terminal: true,
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

test("a review card is drawn at the end of the turn it reviewed, not under the question", () => {
  // The checkpoint message is written when the review starts, mid-turn —
  // before the run writes its answer. Stored order would put the card between
  // the question and the work it reviews, reading as the assistant's reply.
  const checkpoint = checkpointMessage("review-1", "2026-01-01T00:00:00.000Z");
  const markup = render({
    detail: detail([
      message("question-a", "user", "QUESTION-A"),
      checkpoint,
      message("answer-a", "assistant", "PLAIN-ANSWER-A"),
    ]),
    replays: [{ messageId: "answer-a", runId: "run-a", state: answered("run-a", "THOUGHT-A", "ANSWER-A"), userMessageId: "question-a" }],
  });
  const positions = ["QUESTION-A", "ANSWER-A", 'data-testid="review-card"']
    .map((needle) => {
      const at = markup.indexOf(needle);
      assert.notEqual(at, -1, `${needle} is missing from the transcript`);
      return at;
    });
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

test("a review card does not cross into the next turn", () => {
  // The card answers for the first turn's artifacts, so it stays above the
  // second question even though persistence wrote it earlier.
  const checkpoint = checkpointMessage("review-1", "2026-01-01T00:00:00.000Z");
  const markup = render({
    detail: detail([
      message("question-a", "user", "QUESTION-A"),
      checkpoint,
      message("answer-a", "assistant", "PLAIN-ANSWER-A"),
      message("question-b", "user", "QUESTION-B"),
      message("answer-b", "assistant", "PLAIN-ANSWER-B"),
    ]),
  });
  const card = markup.indexOf('data-testid="review-card"');
  assert.notEqual(card, -1);
  assert.ok(markup.indexOf("QUESTION-A") < card);
  assert.ok(card < markup.indexOf("QUESTION-B"));
});

/** A review checkpoint message, stamped so the live-turn rule can read it.
 *  `overrides` lets a test make two checkpoints distinguishable on screen. */
function checkpointMessage(
  id: string,
  createdAt: string,
  overrides: Partial<NonNullable<ChatMessage["reviewerCheckpoint"]>> = {},
): ChatMessage {
  const message = { content: "Reviewer Specialist review", createdAt, id, kind: "reviewer_checkpoint" as const, role: "assistant" as const };
  return { ...message, reviewerCheckpoint: { status: "completed", toolCallId: `tool-${id}`, ...overrides } };
}

/** A running checkpoint's progress, named so the card renders the name. */
function runningProgress(artifactLogicalName: string): NonNullable<NonNullable<ChatMessage["reviewerCheckpoint"]>["progress"]> {
  return { artifactCompleted: 0, artifactLogicalName, artifactTotal: 0, completed: 0, failed: 0, queued: 0, total: 0 };
}

test("a review card written by the running turn waits for that turn's answer", () => {
  // A checkpoint is written mid-turn, before the answer. Drawing it while the
  // turn streams puts it above the reply it is a verdict on, so it is held
  // back until the turn ends.
  const cards = [message("question-a", "user", "QUESTION-A"), checkpointMessage("review-live", "2026-01-01T00:00:10.000Z")];
  const streaming = render({
    detail: detail(cards),
    run: {
      ...answered("run-live", "THOUGHT-LIVE", "ANSWER-LIVE"),
      startedAt: Date.parse("2026-01-01T00:00:05.000Z"),
      terminal: false,
    },
  });
  assert.doesNotMatch(streaming, /data-testid="review-card"/);

  // The turn ended and its answer is stored: the card is drawn at the end.
  const finished = render({ detail: detail([...cards, message("answer-a", "assistant", "ANSWER-A")]) });
  assert.match(finished, /data-testid="review-card"/);

  // A review the reader started is theirs to watch while it runs: the live
  // turn's hold does not apply to it.
  const manual = checkpointMessage("review-manual", "2026-01-01T00:00:10.000Z");
  manual.reviewerCheckpoint = { status: "running", toolCallId: "manual-review:review-manual" };
  const started = render({
    detail: detail([message("question-a", "user", "QUESTION-A"), manual]),
    run: {
      ...answered("run-live", "THOUGHT-LIVE", "ANSWER-LIVE"),
      startedAt: Date.parse("2026-01-01T00:00:05.000Z"),
      terminal: false,
    },
  });
  assert.match(started, /data-testid="review-card-running"/);
});

test("a card written before the first question keeps its place at the head", () => {
  // There is no turn for it to move after: the boundary rule only carries a
  // held checkpoint to the next question, and one already above the first
  // question stays there.
  const markup = render({
    detail: detail([
      checkpointMessage("review-head", "2025-12-31T23:59:00.000Z"),
      message("question-a", "user", "QUESTION-A"),
      message("answer-a", "assistant", "ANSWER-A"),
    ]),
  });
  const card = markup.indexOf('data-testid="review-card"');
  assert.notEqual(card, -1);
  assert.ok(card < markup.indexOf("QUESTION-A"));
});

test("two cards written in one turn both follow its answer, in the order they were written", () => {
  // The two cards must be distinguishable on screen, or the assertions below
  // would pass just as well with their order reversed: an empty completed
  // card renders the same markup for every checkpoint. A running card names
  // the artifact it is on, which gives each one a unique string to find.
  const markup = render({
    detail: detail([
      message("question-a", "user", "QUESTION-A"),
      checkpointMessage("review-one", "2026-01-01T00:00:01.000Z", { progress: runningProgress("one.md"), status: "running" }),
      checkpointMessage("review-two", "2026-01-01T00:00:02.000Z", { progress: runningProgress("two.md"), status: "running" }),
      message("answer-a", "assistant", "ANSWER-A"),
      message("question-b", "user", "QUESTION-B"),
    ]),
  });
  const first = markup.indexOf("one.md");
  const second = markup.indexOf("two.md");
  assert.notEqual(first, -1);
  assert.notEqual(second, -1);
  assert.ok(markup.indexOf("ANSWER-A") < first);
  assert.ok(first < second);
  assert.ok(second < markup.indexOf("QUESTION-B"));
});

test("a card whose write time cannot be read is drawn rather than hidden", () => {
  // The live-turn hold compares the checkpoint's stamp with the run's start.
  // An unreadable or missing stamp cannot prove the card belongs to the
  // running turn, and losing a review is worse than drawing it a turn early,
  // so the comparison fails open.
  const unreadable = render({
    detail: detail([message("question-a", "user", "QUESTION-A"), checkpointMessage("review-unreadable", "not-a-timestamp")]),
    run: {
      ...answered("run-live", "THOUGHT-LIVE", "ANSWER-LIVE"),
      startedAt: Date.parse("2026-01-01T00:00:05.000Z"),
      terminal: false,
    },
  });
  assert.match(unreadable, /data-testid="review-card"/);

  const missing = checkpointMessage("review-missing", "");
  delete (missing as { createdAt?: string }).createdAt;
  const unstamped = render({
    detail: detail([message("question-a", "user", "QUESTION-A"), missing]),
    run: {
      ...answered("run-live", "THOUGHT-LIVE", "ANSWER-LIVE"),
      startedAt: Date.parse("2026-01-01T00:00:05.000Z"),
      terminal: false,
    },
  });
  assert.match(unstamped, /data-testid="review-card"/);
});

test("a card from an earlier turn is drawn while the next turn streams", () => {
  // Only what the live run wrote is held. A card the coordinator wrote after
  // the previous turn belongs to that turn and is readable at once.
  const markup = render({
    detail: detail([
      message("question-a", "user", "QUESTION-A"),
      message("answer-a", "assistant", "ANSWER-A"),
      checkpointMessage("review-earlier", "2026-01-01T00:00:00.000Z"),
      message("question-b", "user", "QUESTION-B"),
    ]),
    run: {
      ...answered("run-live", "THOUGHT-LIVE", "ANSWER-LIVE"),
      startedAt: Date.parse("2026-01-01T00:00:05.000Z"),
      terminal: false,
    },
  });
  assert.match(markup, /data-testid="review-card"/);
  assert.ok(markup.indexOf('data-testid="review-card"') < markup.indexOf("QUESTION-B"));
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

test("the reviewer's record is not drawn as part of the conversation", () => {
  // The Reviewer Specialist writes its verdict into the session so the review
  // can be audited, and the API keeps doing that. The desktop transcript is not
  // where the record is read: drawn as a status line it sat under the answer
  // like a further answer to the question above it.
  const markup = render({
    detail: detail([
      message("question", "user", "QUESTION"),
      message("checkpoint", "assistant", "REVIEWER-VERDICT", "reviewer_checkpoint"),
      message("notice", "assistant", "REVIEW-NOTICE", "review_notice"),
      message("timeout", "assistant", "TIMED-OUT-RUN", "timeout_notice"),
    ]),
  });
  assert.doesNotMatch(markup, /REVIEWER-VERDICT/);
  assert.doesNotMatch(markup, /REVIEW-NOTICE/);
  assert.doesNotMatch(markup, /审阅/u);
  // Every other notice still draws: this hides one record, not the row type.
  assert.match(markup, /TIMED-OUT-RUN/);
  assert.match(markup, /超时/u);
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

test("a timeout notice shows a localized summary and hides raw diagnostics in details", () => {
  const markup = render({
    detail: detail([
      message("timeout-1", "assistant", "Request stopped because the Agent idle timeout was reached after 1 seconds. Agent run stalled: no gateway progress for 1000 ms", "timeout_notice"),
    ]),
  });
  assert.match(markup, /运行超时/u);
  assert.match(markup, /class="run-failure-details"/u);
  assert.match(markup, /Agent idle timeout was reached/u);
});

test("a replayed failed run shows the localized summary and keeps diagnostics in details", () => {
  const sessionMessages = [
    message("question-1", "user", "do it"),
    message("answer-1", "assistant", "I will try"),
  ];
  const replays: RunReplay[] = [
    { messageId: "answer-1", runId: "run-1", state: failed("run-1", "timeout", "no gateway progress for 1000 ms"), userMessageId: "question-1" },
  ];
  const markup = render({ detail: detail(sessionMessages), replays });
  assert.match(markup, /运行超时/u);
  assert.match(markup, /class="run-failure-details"/u);
  assert.match(markup, /no gateway progress for 1000 ms/u);
});

test("a run timeout merges its transcript notice into one card without losing diagnostics", () => {
  // Both records describe the same failure in the same conversational turn.
  const sessionMessages = [
    message("question-1", "user", "do it"),
    { ...message("notice-1", "assistant", "Request stopped because the Agent idle timeout was reached after 1 seconds. no gateway progress for 1000 ms", "timeout_notice"), timeout: { kind: "gateway_idle", reason: "no gateway progress for 1000 ms", timeoutMs: 1000 } },
    message("answer-1", "assistant", "I will try"),
  ];
  const replays: RunReplay[] = [
    { messageId: "answer-1", runId: "run-1", state: failed("run-1", "timeout", "no gateway progress for 1000 ms"), userMessageId: "question-1" },
  ];
  const markup = render({ detail: detail(sessionMessages), replays });
  assert.match(markup, /运行超时/u);
  assert.equal((markup.match(/class="run-failure-details"/gu) ?? []).length, 1);
  assert.match(markup, /no gateway progress for 1000 ms/u);
  assert.match(markup, /Agent idle timeout was reached/u);
});

function timeoutNotice(id: string, reason = "no gateway progress for 1000 ms"): ChatMessage {
  return {
    ...message(id, "assistant", `TIMEOUT-CONTEXT-${id}: ${reason}`, "timeout_notice"),
    timeout: { kind: "gateway_idle", reason, timeoutMs: 1000 },
  };
}

test("two failed turns keep one card each even with identical timeout reasons", () => {
  const messages = [message("q1", "user", "first"), timeoutNotice("n1"), message("q2", "user", "second"), timeoutNotice("n2")];
  const replays = ["1", "2"].map(id => ({ runId: `r${id}`, userMessageId: `q${id}`, state: failed(`r${id}`, "timeout", "no gateway progress for 1000 ms") }));
  const markup = render({ detail: detail(messages), replays });
  assert.equal((markup.match(/class="run-failure"/gu) ?? []).length, 2);
  assert.match(markup, /TIMEOUT-CONTEXT-n1/);
  assert.match(markup, /TIMEOUT-CONTEXT-n2/);
});

test("an unrelated or unmatched timeout is never hidden by another failure", () => {
  const messages = [message("q1", "user", "first"), timeoutNotice("n1", "different reason"), message("q2", "user", "second"), timeoutNotice("n2")];
  const replays = [{ runId: "r1", userMessageId: "q1", state: failed("r1", "timeout", "no gateway progress for 1000 ms") }];
  const markup = render({ detail: detail(messages), replays });
  assert.equal((markup.match(/class="run-failure"/gu) ?? []).length, 3);
  assert.match(markup, /different reason/);
  assert.match(markup, /TIMEOUT-CONTEXT-n2/);
});

test("live failure before its first answer is visible and merges its timeout notice", () => {
  const markup = render({
    detail: detail([message("q1", "user", "first"), timeoutNotice("n1")]),
    run: failed("live", "timeout", "no gateway progress for 1000 ms"),
  });
  assert.equal((markup.match(/class="run-failure"/gu) ?? []).length, 1);
  assert.match(markup, /TIMEOUT-CONTEXT-n1/);
});

test("a live snapshot and replay of the same run are rendered only once", () => {
  const run = failed("r1", "timeout", "no gateway progress for 1000 ms");
  const markup = render({
    detail: detail([message("q1", "user", "first"), timeoutNotice("n1")]),
    replays: [{ runId: "r1", userMessageId: "q1", state: run }],
    run,
  });
  assert.equal((markup.match(/class="run-failure"/gu) ?? []).length, 1);
});

test("legacy notices without timeout metadata merge only when diagnostics match", () => {
  const markup = render({
    detail: detail([message("q1", "user", "first"), message("n1", "assistant", "Timeout: no gateway progress for 1000 ms", "timeout_notice")]),
    replays: [{ runId: "r1", userMessageId: "q1", state: failed("r1", "timeout", "no gateway progress for 1000 ms") }],
  });
  assert.equal((markup.match(/class="run-failure"/gu) ?? []).length, 1);
  assert.match(markup, /Timeout: no gateway progress/);
});

test("multiple records for one failure preserve every diagnostic and source records", () => {
  const messages = [message("q1", "user", "first"), timeoutNotice("n1"), timeoutNotice("n2")];
  const run = failed("r1", "timeout", "no gateway progress for 1000 ms");
  const before = JSON.stringify({ messages, run });
  const markup = render({ detail: detail(messages), replays: [{ runId: "r1", userMessageId: "q1", state: run }] });
  assert.equal((markup.match(/class="run-failure"/gu) ?? []).length, 1);
  for (const id of ["n1", "n2"]) assert.match(markup, new RegExp(`TIMEOUT-CONTEXT-${id}`));
  assert.equal(JSON.stringify({ messages, run }), before);
});

test("ambiguous failures in one user turn retain the standalone notice", () => {
  const markup = render({
    detail: detail([message("q1", "user", "first"), timeoutNotice("n1")]),
    replays: ["r1", "r2"].map(runId => ({ runId, userMessageId: "q1", state: failed(runId, "timeout", "no gateway progress for 1000 ms") })),
  });
  assert.equal((markup.match(/class="run-failure"/gu) ?? []).length, 3);
});

test("a standalone timeout uses its persisted duration without parsing opaque diagnostics", () => {
  const notice: ChatMessage = {
    ...message("n1", "assistant", "opaque-timeout-diagnostic", "timeout_notice"),
    timeout: { kind: "gateway_idle", timeoutMs: 4500, reason: "opaque-timeout-diagnostic" },
  };
  const markup = render({ detail: detail([notice]) });
  assert.match(markup, /<h3>运行超时<\/h3>/);
  assert.match(markup, /Agent 在 4.5 秒内没有产生进展/);
  assert.match(markup, /适当增加 Agent 空闲超时时间/);
  assert.match(markup, /<pre>opaque-timeout-diagnostic<\/pre>/);
});

test("a merged timeout carries its persisted duration into the single failure card", () => {
  const reason = "idle budget exhausted";
  const notice: ChatMessage = {
    ...message("n1", "assistant", `Retained notice: ${reason}`, "timeout_notice"),
    timeout: { kind: "gateway_idle", timeoutMs: 3500, reason },
  };
  const messages = [message("q1", "user", "first"), notice];
  const run = failed("r1", "timeout", reason);
  const before = JSON.stringify({ messages, run });
  const markup = render({ detail: detail(messages), replays: [{ runId: "r1", userMessageId: "q1", state: run }] });
  assert.equal((markup.match(/class="run-failure"/gu) ?? []).length, 1);
  assert.match(markup, /Agent 在 3.5 秒内没有产生进展/);
  assert.match(markup, /Retained notice: idle budget exhausted/);
  assert.equal(JSON.stringify({ messages, run }), before);
});


test("tool and kernel timeout notices do not claim the completed run timed out", () => {
  for (const [kind, title] of [["runner_exec", "工具执行超时"], ["kernel_idle", "内核空闲超时"]] as const) {
    const notice: ChatMessage = {
      ...message("notice", "assistant", "opaque tool diagnostic", "timeout_notice"),
      timeout: { kind, reason: "opaque tool diagnostic", timeoutMs: 1000 },
    };
    const markup = render({
      detail: detail([message("q", "user", "continue after the tool timeout"), notice, message("a", "assistant", "RECOVERED")]),
      replays: [{ runId: "r", userMessageId: "q", messageId: "a", state: answered("r", "", "RECOVERED") }],
    });
    assert.match(markup, new RegExp(`<h3>${title}</h3>`));
    assert.match(markup, /RECOVERED/);
    assert.match(markup, /opaque tool diagnostic/);
    assert.doesNotMatch(markup, /运行超时|运行已终止|运行已停止/);
  }
});

test("an untyped standalone timeout notice does not invent a terminated run", () => {
  const markup = render({ detail: detail([message("notice", "assistant", "legacy opaque timeout", "timeout_notice")]) });
  assert.match(markup, /<h3>超时提示<\/h3>/);
  assert.match(markup, /legacy opaque timeout/);
  assert.doesNotMatch(markup, /运行超时|运行已终止|运行已停止/);
});

/** One research as the API reports it; the card reads only these fields. */
function research(id: string, objective: string): IdeaResearchView {
  return {
    research: {
      id, objective, status: "running", phase: "building_tree", round: 1, batch: [], batchCompleted: 0,
      tokens: 0, usageKnown: false, reason: null, modelId: "model-x", currentNodeId: null,
      settings: { maxRounds: 3, candidatesPerRound: 2, maxSearchRounds: 2, maxNodes: 20, maxDepth: 3, maxActiveDirections: 2, pruneThreshold: 0.2 },
    },
    graph: { edges: [], nodes: [], objective, revision: 1, treeId: "tree-1", updatedAt: "2026-11-18T00:00:00Z" },
  };
}

function ideaCards(views: readonly IdeaResearchView[]): React.ReactElement {
  return <IdeaResearchCards onOpen={() => undefined} views={views} />;
}

/** Each needle's position, asserting it exists so an absent marker cannot look
 *  like a passing order. */
function positions(markup: string, needles: readonly string[]): number[] {
  return needles.map((needle) => {
    const at = markup.indexOf(needle);
    assert.notEqual(at, -1, `${needle} is missing from the markup`);
    return at;
  });
}

test("one research is drawn at the foot of the transcript, not pinned above it", () => {
  const markup = render({
    detail: detail([message("q", "user", "QUESTION-TOP"), message("a", "assistant", "ANSWER-BOTTOM")]),
    ideaCards: ideaCards([research("research-1", "FIRST-RESEARCH")]),
    evolve: <div className="evolve-runs">EVOLVE-CARD</div>,
  });
  const order = positions(markup, ["QUESTION-TOP", "ANSWER-BOTTOM", "FIRST-RESEARCH", "EVOLVE-CARD"]);
  assert.deepEqual([...order].sort((left, right) => left - right), order,
    "the card belongs after the messages and before the searches");
  // It is inside the scrolling transcript column, where the Evolve cards live,
  // rather than a sibling the session pins above it.
  assert.ok(markup.indexOf('class="messages"') < markup.indexOf('class="idea-tree-slot"'));
  assert.equal(markup.match(/class="idea-cards"/gu)?.length, 1);
  assert.equal(markup.match(/class="evolve-run-card idea-run-card/gu)?.length, 1);
});

test("two researches keep their list order at the foot of the transcript", () => {
  const markup = render({
    detail: detail([message("q", "user", "QUESTION-TOP"), message("a", "assistant", "ANSWER-BOTTOM")]),
    ideaCards: ideaCards([research("research-1", "FIRST-RESEARCH"), research("research-2", "SECOND-RESEARCH")]),
    evolve: <div className="evolve-runs">EVOLVE-CARD</div>,
  });
  const order = positions(markup, ["QUESTION-TOP", "ANSWER-BOTTOM", "FIRST-RESEARCH", "SECOND-RESEARCH", "EVOLVE-CARD"]);
  assert.deepEqual([...order].sort((left, right) => left - right), order);
  assert.equal(markup.match(/class="evolve-run-card idea-run-card/gu)?.length, 2);
});

test("the legacy card and an unreadable list sit between the cards and the searches", () => {
  const markup = render({
    detail: detail([message("q", "user", "QUESTION-TOP")]),
    ideaCards: ideaCards([research("research-1", "FIRST-RESEARCH")]),
    ideaLegacy: <div className="evolve-run-card idea-run-card is-legacy">LEGACY-CARD</div>,
    ideaNotice: <p className="idea-notice" role="alert">IDEA-NOTICE</p>,
    evolve: <div className="evolve-runs">EVOLVE-CARD</div>,
  });
  const order = positions(markup, ["QUESTION-TOP", "FIRST-RESEARCH", "LEGACY-CARD", "IDEA-NOTICE", "EVOLVE-CARD"]);
  assert.deepEqual([...order].sort((left, right) => left - right), order);
});

test("a session with no Idea Tree surfaces draws no empty foot-of-transcript block", () => {
  const markup = render({ detail: detail([message("q", "user", "QUESTION-TOP")]) });
  assert.doesNotMatch(markup, /idea-tree-slot/);
});

test("a wake after an interrupted run says why the second run exists and keeps the link", () => {
  // The reported transcript showed `已中断` and then a second run card with no
  // explanation. The wake message stays the anchor for that run, but now its
  // card names the interruption, the attempt and the interrupted run.
  const resumed: ChatMessage = {
    content: "",
    createdAt: "2026-01-01T00:05:00.000Z",
    id: "wake-resume",
    kind: "wake_notice",
    role: "user",
    runtimeNotice: {
      executions: 1,
      prompt: "[Execution notifications]\nThese are retained status/reminder records.",
      wakeAfterRunId: "run-a",
      wakeAttempt: 2,
      timers: 0,
    },
  };
  const markup = render({ detail: detail([
    message("question", "user", "QUESTION"),
    resumed,
    message("answer", "assistant", "AFTER-WAKE"),
  ]) });
  assert.match(markup, /中断恢复/);
  assert.match(markup, /第 2 次尝试/);
  assert.match(markup, /被中断的运行：run-a（仍标记为已中断）/);
  assert.match(markup, /不会重跑上一轮的任务/);
  // The model-facing prompt stays out of the transcript.
  assert.doesNotMatch(markup, /Execution notifications/);
});

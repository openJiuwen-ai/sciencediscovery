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

// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { createTest } from "../../../test/support/tagged/compat.mjs";
import type { ApiClient } from "../src/api/client.js";
import { emptyRunStream, type AssistantTurn, type RunStreamState } from "../src/run-stream/model.js";
import { AssistantTurns } from "../src/views/AssistantTurn.js";

const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

const client = new Proxy({} as ApiClient, {
  get: () => () => Promise.reject(new Error("no request is expected from a static render")),
});

function turn(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return { responses: [], thinking: "", thinkingTruncated: false, tools: [], turn: 1, ...overrides };
}

function render(run: Partial<RunStreamState>): string {
  return renderToStaticMarkup(
    <AssistantTurns
      client={client}
      onDecide={() => Promise.resolve()}
      run={{ ...emptyRunStream(), modelName: "m", runId: "r1", ...run }}
      sessionId="s1"
    />,
  );
}

function spinners(html: string): number {
  return (html.match(/class="spinner"/gu) ?? []).length;
}

/**
 * Where the `<details>` opened at `at` ends.
 *
 * Static markup has no DOM to ask, and "is this text inside the fold" is
 * exactly the question the tests below are asking — the nested folds (thinking,
 * every tool card) mean counting tags is the only answer that stays right when
 * the shape of the body changes.
 */
function closesAt(html: string, at: number): number {
  const tag = /<\/?details\b/gu;
  tag.lastIndex = at;
  let depth = 0;
  for (let match = tag.exec(html); match !== null; match = tag.exec(html)) {
    depth += match[0] === "</details" ? -1 : 1;
    if (depth === 0) return match.index;
  }
  throw new Error("the fold is never closed");
}

describe("the streaming indicator belongs to one response, not to a turn", () => {
  it("spins only on the response that has not settled", () => {
    const html = render({
      turns: [
        turn({
          responses: [
            { content: "first turn", responseId: "r-1", settled: true, truncated: false },
            { content: "still going", responseId: "r-2", settled: false, truncated: false },
          ],
          turn: 1,
        }),
      ],
    });
    assert.equal(spinners(html), 1);
    assert.match(html, /still going/);
  });

  it("leaves finished turns alone while a later turn streams", () => {
    // Every turn has a last response of its own, so "is this the turn's last
    // response" marked all of them — a nine-turn run showed nine spinners.
    const html = render({
      turns: [
        turn({ responses: [{ content: "one", responseId: "a", settled: true, truncated: false }], turn: 1 }),
        turn({ responses: [{ content: "two", responseId: "b", settled: true, truncated: false }], turn: 2 }),
        turn({ responses: [{ content: "three", responseId: "c", settled: false, truncated: false }], turn: 3 }),
      ],
    });
    assert.equal(spinners(html), 1);
  });

  it("stops spinning everywhere once the run is over", () => {
    const html = render({
      terminal: true,
      turns: [turn({ responses: [{ content: "cut off", responseId: "a", settled: false, truncated: false }] })],
    });
    assert.equal(spinners(html), 0);
  });
});

describe("a run folds into one line", () => {
  const answered = {
    responses: [{ content: "the answer", responseId: "a", settled: true, truncated: false }],
    thinking: "a thought",
    turn: 1,
  };

  it("says 正在规划下一步 while it is still going, and keeps the answer in view", () => {
    const html = render({ turns: [turn(answered)] });
    assert.match(html, /正在规划下一步/);
    // The line stands in for the run; the answer it produced is beside it, not
    // inside it. Both matter: one is the summary, the other is the point.
    assert.ok(html.indexOf("正在规划下一步") < html.indexOf("the answer"));
    assert.equal(html.match(/class="msg-collapse run-fold"/gu)?.length, 1);
  });

  it("turns a ring while the model is working, and only then", () => {
    // The line's icon is the one place the transcript moves: a still glyph
    // says nothing about whether anything is happening, and a ring that keeps
    // turning after the run stops says the opposite of what the line says.
    const working = render({ turns: [turn(answered)] });
    assert.match(working, /class="spinner run-spinner"/);
    const queued = render({ status: "queued", turns: [turn({ thinking: "queued thought" })] });
    assert.doesNotMatch(queued, /run-spinner/);
    const over = render({ finishedAt: 2, startedAt: 1, terminal: true, turns: [turn(answered)] });
    assert.doesNotMatch(over, /run-spinner/);
  });

  it("reports the elapsed time once the run is over", () => {
    const html = render({
      finishedAt: Date.parse("2026-01-01T00:46:06.303Z"),
      startedAt: Date.parse("2026-01-01T00:13:33.993Z"),
      terminal: true,
      turns: [turn(answered)],
    });
    assert.match(html, /用时 32 分 32 秒/);
    assert.doesNotMatch(html, /正在规划下一步/);
  });

  it("falls back to the status word when the run has no measured span", () => {
    // A record written before the times existed still has to say something.
    const html = render({ status: "completed", terminal: true, turns: [turn(answered)] });
    assert.match(html, /已完成/);
  });

  it("hides the thinking and the tool calls inside the fold", () => {
    const html = render({
      terminal: true,
      turns: [turn({ ...answered, tools: [{ after: 0, id: "c1", trace: { id: "c1", name: "read_skill", status: "completed" } }] })],
    });
    const opens = html.indexOf('class="msg-collapse run-fold"');
    assert.ok(opens !== -1);
    // Both are still rendered — folding is a `<details>`, not a deletion — but
    // they come after the summary that hides them and before the answer.
    assert.ok(opens < html.indexOf("a thought"));
    assert.ok(opens < html.indexOf("read_skill"));
    assert.ok(html.indexOf("read_skill") < html.indexOf("the answer"));
  });

  it("leaves a plain question and answer unfolded", () => {
    // Nothing happened between the question and the answer, so a fold line
    // would be a line about nothing.
    const html = render({
      terminal: true,
      turns: [turn({ responses: [{ content: "just the answer", responseId: "a", settled: true, truncated: false }] })],
    });
    assert.doesNotMatch(html, /run-fold/);
    assert.match(html, /just the answer/);
  });

  it("folds a run that only thought, with no answer to show", () => {
    const html = render({ terminal: true, turns: [turn({ thinking: "only a thought" })] });
    assert.match(html, /run-fold/);
    assert.match(html, /only a thought/);
  });

  it("leaves no bare model name behind when a turn streamed no prose", () => {
    // A run that opened a turn and then failed has a turn but nothing in it.
    // The status line under it already names the failure, and a second avatar
    // over an empty body is furniture — the same reason a turn-less run has no
    // fold line above its status.
    const html = render({
      error: { message: "gateway died" },
      status: "failed",
      terminal: true,
      turns: [turn({ responses: [{ content: "", responseId: "a", settled: true, truncated: false }] })],
    });
    assert.doesNotMatch(html, /<div class="role">/u);
    assert.doesNotMatch(html, /run-fold/u);
    assert.match(html, /gateway died/u);
  });

  it("says what it is waiting for rather than that it is thinking", () => {
    // Waiting and working are different things to the person watching: one of
    // them is about them.
    const queued = render({ status: "queued", turns: [turn({ thinking: "queued thought" })] });
    assert.match(queued, /排队中/);
    assert.doesNotMatch(queued, /正在规划下一步/);
    const blocked = render({ status: "blocked", turns: [turn({ thinking: "blocked thought" })] });
    assert.match(blocked, /等待授权/);
    assert.doesNotMatch(blocked, /正在规划下一步/);
  });

  it("folds the previous turn's sentence away while the next turn is only thinking", () => {
    // The model opens a turn with its reasoning, and the turn before it may
    // still hold the sentence that introduced a tool call. Showing that as the
    // run's answer for as long as the tool runs — and then pulling it back into
    // the fold — is a transcript that changes its mind in front of the reader.
    const html = render({
      turns: [
        turn({
          responses: [{ content: "let me check the file", responseId: "a", settled: true, truncated: false }],
          turn: 1,
        }),
        turn({ thinking: "reading the file", turn: 2 }),
      ],
    });
    const fold = html.indexOf('<details class="msg-collapse run-fold"');
    const sentence = html.indexOf("let me check the file");
    assert.ok(fold !== -1 && sentence !== -1);
    assert.ok(fold < sentence && sentence < closesAt(html, fold), "the sentence is inside the fold");
    assert.equal(html.match(/let me check the file/gu)?.length, 1, "and not also outside it");
    assert.match(html, /正在规划下一步/);
  });

  it("leaves an outstanding authorization outside the fold", () => {
    // A run waiting on an answer is waiting on the person reading. A question
    // folded shut behind a summary is a run that looks stopped for no reason.
    const html = render({
      permissions: [{
        request: {
          action: "shell",
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "perm-1",
          resource: "shell:ls",
          state: "pending",
          summary: "PERMISSION-SUMMARY",
        },
      }],
      turns: [turn({ thinking: "stopped here", turn: 1 })],
    });
    const fold = html.indexOf('<details class="msg-collapse run-fold"');
    assert.ok(fold !== -1);
    assert.equal(html.match(/PERMISSION-SUMMARY/gu)?.length, 1);
    assert.ok(html.indexOf("PERMISSION-SUMMARY") > closesAt(html, fold));
  });
});

describe("tool calls sit between the answers they were made from", () => {
  const trace = (id: string) => ({
    id,
    name: "read_skill",
    status: "completed" as const,
  });

  it("places a call at its recorded index rather than collecting them at the end", () => {
    const html = render({
      turns: [
        turn({
          responses: [
            { content: "before the call", responseId: "a", settled: true, truncated: false },
            { content: "after the call", responseId: "b", settled: true, truncated: false },
          ],
          tools: [{ after: 0, id: "c1", trace: trace("c1") }],
        }),
      ],
    });
    assert.ok(html.indexOf("before the call") < html.indexOf("read_skill"));
    assert.ok(html.indexOf("read_skill") < html.indexOf("after the call"));
  });

  it("puts a call recorded before the first answer ahead of it", () => {
    const html = render({
      turns: [
        turn({
          responses: [{ content: "the answer", responseId: "a", settled: true, truncated: false }],
          tools: [{ after: -1, id: "c1", trace: trace("c1") }],
        }),
      ],
    });
    assert.ok(html.indexOf("read_skill") < html.indexOf("the answer"));
  });
});

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
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself is built with the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "../src/Markdown.js";
import { TEXT } from "../src/text.js";
import {
  CheckpointAnsweredProvider,
  CheckpointReplyProvider,
  type CheckpointReply,
} from "../src/views/CheckpointCard.js";

const values: CheckpointReply = {
  busy: false,
  reply: () => {},
};

function card(over: Record<string, string | number> = {}): string {
  const fields = {
    pace: "confirm",
    step: 1,
    title: "什么算“更好”",
    total: 4,
    ...over,
  };
  const header = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return [
    "说明文字。",
    "",
    "```evolve-checkpoint",
    ...header,
    "---",
    "**度量：** 压缩比",
    "",
    "**冻结：** 不许用现成库",
    "```",
  ].join("\n");
}

/** `null` is the card in a renderer with no composer behind it; a default
 *  parameter would turn an omitted argument back into the live context. */
function render(
  answer: string,
  reply: CheckpointReply | null = values,
  answered = false,
): string {
  const markdown = <Markdown>{answer}</Markdown>;
  return renderToStaticMarkup(
    <CheckpointAnsweredProvider value={answered}>
      {reply === null ? markdown : <CheckpointReplyProvider value={reply}>{markdown}</CheckpointReplyProvider>}
    </CheckpointAnsweredProvider>,
  );
}

test("a checkpoint is drawn as a card between the prose, not as a code block", () => {
  const html = render(card());
  assert.match(html, /class="evolve-checkpoint is-confirm"/);
  // Four steps, but the last one is a record and asks nothing: the band
  // counts the three checkpoints the reader actually answers.
  assert.match(html, /class="evolve-checkpoint-count">1\/3</);
  assert.match(html, /检查点 1\/3/);
  assert.match(html, /等待确认/);
  assert.match(html, /什么算“更好”/);
  // The body is prose inside the card, not the JSON the model wrote.
  assert.match(html, /<strong>度量：<\/strong>/);
  assert.doesNotMatch(html, /step: 1|title: /);
  // The sentence before it is still an ordinary paragraph.
  assert.match(html, /^<p>说明文字。<\/p>/);
});

test("a waiting checkpoint offers the two answers the flow expects", () => {
  const html = render(card());
  assert.match(html, /确认，继续/);
  assert.match(html, /需要调整/);
});

test("a record is a step, not a checkpoint: no badge, nothing to press", () => {
  const html = render(card({ pace: "auto", step: 3 }));
  assert.match(html, /class="evolve-checkpoint is-auto is-folded is-record"/);
  assert.match(html, /class="evolve-checkpoint-step">步骤</);
  // A step nobody answers carries no counter: there is no "which question of
  // how many" to report.
  assert.doesNotMatch(html, /evolve-checkpoint-count/);
  assert.doesNotMatch(html, /检查点 3/);
  assert.doesNotMatch(html, /自动/);
  assert.doesNotMatch(html, /确认，继续/);
  assert.doesNotMatch(html, /evolve-checkpoint-actions/);
});

test("a record folds to its header like an answered card", () => {
  // The record is the longest thing in the transcript and asks for nothing, so
  // it is closed by default: the header says which step it is and what it was
  // about, and the body is one click away.
  const html = render(card({ pace: "auto", step: 3, title: "搜索已启动" }));
  assert.match(html, /<details aria-label="步骤 3" class="evolve-checkpoint is-auto is-folded is-record"/);
  assert.match(html, /<summary class="evolve-checkpoint-head"/);
  assert.match(html, /搜索已启动/);
  assert.match(html, /collapse-chev/);
  assert.doesNotMatch(html, /evolve-checkpoint-main/);
});

test("the last step is a record: the run already started", () => {
  // A live run labelled step 4 `confirm` and offered 「确认，继续」 eight
  // seconds after the search started. There is nothing to confirm at that
  // point, so the card is drawn as a record whatever pace the model wrote.
  const html = render(card({ step: 4, title: "探针结果" }));
  assert.match(html, /class="evolve-checkpoint is-auto is-folded is-record"/);
  assert.match(html, /data-pace="confirm"/);
  assert.match(html, /class="evolve-checkpoint-step">步骤</);
  assert.doesNotMatch(html, /evolve-checkpoint-count/);
  assert.doesNotMatch(html, /已启动|自动|等待确认/);
  assert.doesNotMatch(html, /evolve-checkpoint-actions/);
  assert.doesNotMatch(html, /确认，继续/);
});

test("a confirmation names the step it answers", () => {
  // Six identical 「确认，继续。」 left the model unable to tell which card it
  // was answering, and it re-opened step 3. The step number travels with the
  // reply now.
  assert.equal(TEXT.evolve.checkpoint.confirmReply(3, 4), "确认检查点 3/4，继续。");
  assert.equal(TEXT.evolve.checkpoint.confirmReply(2), "确认检查点 2，继续。");
});

test("a card with no one to answer it still shows its content", () => {
  const html = render(card(), null);
  assert.match(html, /检查点 1\/3/);
  assert.match(html, /什么算“更好”/);
  assert.doesNotMatch(html, /evolve-checkpoint-actions/);
});

test("a card whose reply is still streaming disables its buttons", () => {
  const html = render(card(), { ...values, busy: true });
  assert.match(html, /class="evolve-checkpoint-confirm" disabled=""/);
  assert.match(html, /这条回复还没结束/);
});

test("a checkpoint the conversation has moved past folds to its header", () => {
  const html = render(card(), values, true);
  assert.match(html, /class="evolve-checkpoint is-confirm is-folded is-answered"/);
  assert.match(html, /已回答/);
  // The question it asked stays on the folded line; the step's words are
  // behind it, and the buttons are gone — the reply is already in the
  // transcript, so there is nothing left to press.
  assert.match(html, /什么算“更好”/);
  assert.match(html, /<strong>度量：<\/strong>/);
  assert.doesNotMatch(html, /<details[^>]*\sopen/);
  assert.doesNotMatch(html, /确认，继续/);
  assert.doesNotMatch(html, /需要调整/);
});

test("an answered record folds too, and does not claim a pace", () => {
  const html = render(card({ pace: "auto" }), values, true);
  assert.match(html, /class="evolve-checkpoint is-auto is-folded is-answered"/);
  assert.match(html, /class="evolve-checkpoint-step">步骤</);
  assert.doesNotMatch(html, /evolve-checkpoint-count/);
  assert.doesNotMatch(html, /自动|已回答/);
  assert.doesNotMatch(html, /<button/);
});

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


import type { ChatMessage, RunStreamEvent } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { formatMessageTime, MessageTime } from "../src/MessageTime.js";
import { reduceRunTimeline, RunTimeline, type RunTimelineEntry } from "../src/RunTimeline.js";

/** A local wall-clock instant, so the expected digits hold in any timezone. */
const sentAt = new Date(2026, 9, 9, 15, 32, 43).toISOString();

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { content: "Report ready", createdAt: sentAt, id: "message-1", role: "assistant", ...overrides };
}

const completed = (overrides: Partial<ChatMessage> = {}): RunStreamEvent =>
  ({ files: [], message: message(overrides), type: "run.completed" });

test("a message time reads as a padded local YYYY-MM-DD HH:MM:SS stamp", () => {
  // Jan 9th, single-digit hour/minute/second: every part has to be padded.
  assert.equal(formatMessageTime(new Date(2026, 0, 9, 5, 4, 3).toISOString()), "2026-01-09 05:04:03");
  assert.equal(formatMessageTime(sentAt), "2026-10-09 15:32:43");
});

test("a missing or unparseable message time renders nothing instead of a blank stamp", () => {
  assert.equal(formatMessageTime(undefined), "");
  assert.equal(formatMessageTime(""), "");
  assert.equal(formatMessageTime("   "), "");
  assert.equal(formatMessageTime("not a date"), "");
  assert.equal(renderToStaticMarkup(createElement(MessageTime, { value: undefined })), "");
  assert.equal(renderToStaticMarkup(createElement(MessageTime, { value: "not a date" })), "");
});

test("a message time carries the machine-readable instant alongside the digits", () => {
  const html = renderToStaticMarkup(createElement(MessageTime, { value: sentAt }));

  // React DOM serializes the attribute as `dateTime`; HTML attribute names are
  // case-insensitive, so the check reads it that way.
  assert.match(html, /^<time class="message-time" datetime="2026-10-09T[^"]*">2026-10-09 15:32:43<\/time>$/i);
});

test("the terminal message stamps its send time on the answer it closes", () => {
  let entries: RunTimelineEntry[] = [];
  entries = reduceRunTimeline(entries, { type: "assistant.delta", delta: "Report ready" });
  entries = reduceRunTimeline(entries, completed());

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.type === "assistant" && entries[0].createdAt, sentAt);
});

test("an answer the run never streamed still arrives stamped", () => {
  const entries = reduceRunTimeline([], completed());

  assert.equal(entries[0]?.type === "assistant" && entries[0].createdAt, sentAt);
});

test("only the reply the terminal message closes is stamped, not earlier prose in the run", () => {
  const entries = reduceRunTimeline([
    { content: "Before tool", id: "intro", type: "assistant" },
    { expanded: false, id: "tool", trace: { id: "one", name: "task", status: "completed" }, type: "tool" },
    { content: "After tool", id: "conclusion", type: "assistant" },
  ], completed());

  const intro = entries.find((entry) => entry.id === "intro");
  const conclusion = entries.find((entry) => entry.id === "conclusion");
  assert.equal(intro?.type === "assistant" && intro.createdAt, undefined,
    "an earlier answer streamed at its own moment and must not be dated by the run's end");
  assert.equal(conclusion?.type === "assistant" && conclusion.createdAt, sentAt);
});

test("the run's label row carries the send time beside the sender", () => {
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries: reduceRunTimeline([], completed()),
    isRunning: false,
    onToggle: () => undefined,
  }));

  // Beside "ScienceDiscovery", like every other message, rather than in the
  // answer body where it would sit on a line of its own. React's server
  // renderer writes the attribute as `dateTime`, hence the case-insensitive
  // match — HTML attribute names are case-insensitive anyway.
  assert.match(html, /<span class="message-meta"><span class="message-role">ScienceDiscovery<\/span><time class="message-time" datetime="[^"]+">2026-10-09 15:32:43<\/time><\/span>/i);
  assert.doesNotMatch(html, /message-body"><time/);
});

test("a run whose answer has no clock yet shows no stamp in its label row", () => {
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries: [{ content: "Still streaming", id: "answer", streaming: true, type: "assistant" }],
    isRunning: true,
    onToggle: () => undefined,
  }));

  assert.match(html, /<span class="message-role">ScienceDiscovery<\/span>/);
  assert.doesNotMatch(html, /message-time/);
});

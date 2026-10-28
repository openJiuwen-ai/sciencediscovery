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
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { isEmptyTranscript, landingKey } from "../src/app/landing.js";
import { emptyRunStream, type RunStreamState } from "../src/run-stream/model.js";
import type { ChatMessage, SessionDetail } from "../src/api/types.js";
import { Landing } from "../src/views/Landing.js";

function detail(messages: ChatMessage[]): SessionDetail {
  return { id: "session-1", messages } as never;
}

function message(id: string, role: ChatMessage["role"], content: string): ChatMessage {
  return { content, createdAt: "2026-01-01T00:00:00.000Z", id, role };
}

/** The page only reads these through the composer, so they are the minimum
 *  the prop type asks for rather than a realistic session. */
function landing(): string {
  return renderToStaticMarkup(
    <Landing
      composer={{
        attachLimit: "1 GiB",
        models: [{ id: "m1", name: "测试模型" } as never],
        onApprovalMode: () => {},
        onCreateProject: () => {},
        onOpenSettings: () => {},
        onSelectModel: () => {},
        onSelectProject: () => {},
        onSend: () => {},
        onStop: () => {},
        onUpload: () => {},
        projects: [],
        running: false,
        selectedModelId: "m1",
        uploading: false,
      }}
    />,
  );
}

test("the welcome page leads with the wordmark and the three ways in", () => {
  const markup = landing();
  assert.match(markup, /class="landing-wordmark">ScienceDiscovery/u);
  assert.match(markup, /class="landing-tagline"/u);
  // Each category is a pill with its own glyph, in the handoff's order.
  const categories = [...markup.matchAll(/class="landing-icon" data-kind="(\w+)"/gu)].map((match) => match[1]);
  assert.deepEqual(categories, ["research", "experiment", "analysis"]);
  assert.match(markup, /文献调研/u);
  assert.match(markup, /实验设计/u);
  assert.match(markup, /数据分析/u);
});

test("the welcome page's composer is the landing arrangement, with its strip", () => {
  const markup = landing();
  assert.match(markup, /class="composer is-landing"/u);
  assert.match(markup, /有什么需要我帮忙的/u);
  // The strip carries the project picker. With no Project chosen it shows the
  // invitation rather than a name. The approval mode is not a second control
  // there: it lives in 会话设置, the one place a mode can be changed.
  assert.match(markup, /class="composer-strip-project is-placeholder"/u);
  assert.match(markup, /选择项目/u);
  assert.doesNotMatch(markup, /composer-strip-permission/u);
});

test("a transcript is empty only while nothing at all has happened in it", () => {
  const empty = { replays: [], run: emptyRunStream() };
  assert.equal(isEmptyTranscript({ ...empty, detail: detail([]) }), true);
  // Still loading: the page has not decided what it is yet.
  assert.equal(isEmptyTranscript({ ...empty, detail: undefined }), true);
  assert.equal(
    isEmptyTranscript({ ...empty, detail: detail([message("m1", "user", "HI")]) }),
    false,
  );
  assert.equal(
    isEmptyTranscript({ ...empty, detail: detail([]), pending: { content: "HI" } as never }),
    false,
  );
  assert.equal(
    isEmptyTranscript({ ...empty, detail: detail([]), replays: [{ runId: "r1" } as never] }),
    false,
  );
  const run: RunStreamState = {
    ...emptyRunStream(),
    turns: [{ responses: [], subagents: [], thinking: "", thinkingTruncated: false, tools: [], turn: 1 }],
  };
  assert.equal(isEmptyTranscript({ detail: detail([]), replays: [], run }), false);
});

test("the welcome page is a different page for every session and every draft", () => {
  // The page holds the category until it is unmounted, and React's key is what
  // unmounts it. 新增会话 goes from an open session straight to a draft without
  // a blank page in between, so both halves of the identity have to count.
  assert.equal(landingKey({ draftEpoch: 0, sessionId: "session-1" }), "session-1");
  assert.notEqual(
    landingKey({ draftEpoch: 0, sessionId: "session-1" }),
    landingKey({ draftEpoch: 0, sessionId: "session-2" }),
  );
  // A draft has no id: two drafts are two pages, and the same draft is one.
  assert.notEqual(landingKey({ draftEpoch: 1 }), landingKey({ draftEpoch: 2 }));
  assert.equal(landingKey({ draftEpoch: 2 }), landingKey({ draftEpoch: 2 }));
});

test("an answer streaming with no turn yet still keeps the transcript", () => {
  // A run that has written a final answer but has not opened a turn is not a
  // blank page: leaving the welcome page up would hide what it is saying.
  const run: RunStreamState = { ...emptyRunStream(), finalContent: "ANSWER" };
  assert.equal(isEmptyTranscript({ detail: detail([]), replays: [], run }), false);
});

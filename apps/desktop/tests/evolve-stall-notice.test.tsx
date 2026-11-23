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

import { TEXT } from "../src/text.js";
import { EvolveStallNotice } from "../src/views/EvolveStallNotice.js";

import { act, create } from "./support/dom-renderer.js";

function render(notice?: { reason: "stopped" | "unstarted" }, busy = false): string {
  return renderToStaticMarkup(
    <EvolveStallNotice busy={busy} notice={notice} onSend={() => {}} />,
  );
}

test("a stall with no card says the search has not started", () => {
  // #1328: a design whose checkpoint arrived as prose (or whose
  // create_evolve_run created nothing) has no card to carry 「已停止自动续跑」.
  // The conversation has to say it instead, in words, at the place the design
  // stopped.
  const html = render({ reason: "stopped" });
  assert.match(html, /role="status"/);
  assert.match(html, /class="evolve-stall" data-reason="stopped"/);
  assert.match(html, /搜索还没开始/);
  assert.match(html, /同一步已经自动推过一次/);
  // The sentence is written out, not left to the reader to invent.
  assert.match(html, /发送下面这句话继续/);
  assert.ok(html.includes(TEXT.evolve.checkpoint.autoResume));
  assert.match(html, /class="evolve-stall-action"/);
});

test("a refused create_evolve_run is described as such", () => {
  // The call ran and no search exists: the answer holds the reason, so the
  // block must not claim the step was carried twice.
  const html = render({ reason: "unstarted" });
  assert.match(html, /data-reason="unstarted"/);
  assert.match(html, /调用过 create_evolve_run/);
  assert.doesNotMatch(html, /同一步已经自动推过一次/);
  assert.ok(html.includes(TEXT.evolve.checkpoint.autoResume));
});

test("a design that is not stalled draws nothing", () => {
  assert.equal(render(), "");
});

test("a running turn disables the sentence's button", () => {
  // The same rule the checkpoint card follows: pressing while the assistant is
  // answering would send a message into a live run.
  const html = render({ reason: "stopped" }, true);
  assert.match(html, /class="evolve-stall-action" disabled=""/);
  assert.ok(html.includes(TEXT.evolve.checkpoint.busy));
});

test("pressing Send sends exactly the sentence the client would send", async () => {
  // The button replaces the client's automatic push; it has to send the same
  // text, or the model reads two different instructions for the same step.
  const sent: string[] = [];
  let view: ReturnType<typeof create> | undefined;
  await act(async () => {
    view = create(
      <EvolveStallNotice busy={false} notice={{ reason: "stopped" }} onSend={(text) => sent.push(text)} />,
    );
  });
  if (view === undefined) throw new Error("the stall notice did not mount");
  try {
    const button = view.root.findByProps({ className: "evolve-stall-action" });
    const onClick = button.props.onClick;
    if (typeof onClick !== "function") throw new Error("the send button has no handler");
    await act(async () => { onClick(); });
    assert.deepEqual(sent, [TEXT.evolve.checkpoint.autoResume]);
  } finally {
    view.unmount();
  }
});

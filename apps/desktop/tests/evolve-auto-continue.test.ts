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
import { createElement } from "react";

import { act, create } from "./support/dom-renderer.js";
import {
  autoContinueKey,
  designAnchorAfterSending,
  lastAnswer,
  startedDesign,
  useAutoContinue,
  type AutoContinueInput,
} from "../src/evolve/use-auto-continue.js";
import { emptyRunStream } from "../src/run-stream/model.js";

function streamed(content: string) {
  return {
    responses: [{ content, responseId: "response-1", settled: true, truncated: false }],
    subagents: [],
    thinking: "",
    thinkingTruncated: false,
    tools: [],
    turn: 1,
  };
}

test("the completed answer is read, not the deltas that assembled it", () => {
  // `run.completed` carries the persisted message; a stream whose early frames
  // were dropped can hold half of it in `turns`. The decision to continue must
  // read the whole answer, because the card is at its end.
  const run = { ...emptyRunStream(), finalContent: "完整回答", status: "completed" as const, turns: [streamed("完整回")] };
  assert.equal(lastAnswer(run), "完整回答");
});

test("a stream with no completion falls back to its last non-empty response", () => {
  const run = {
    ...emptyRunStream(),
    turns: [streamed("第一段"), { ...streamed("第二段"), turn: 2 }],
  };
  assert.equal(lastAnswer(run), "第二段");
  // Empty turns are skipped rather than returned as "".
  assert.equal(lastAnswer({ ...emptyRunStream(), turns: [streamed("有"), { ...streamed(" "), turn: 2 }] }), "有");
  assert.equal(lastAnswer(emptyRunStream()), undefined);
});

function Harness(props: AutoContinueInput) {
  useAutoContinue(props);
  return null;
}

function card(title: string, step = 1): string {
  return [
    "```evolve-checkpoint",
    `step: ${step}`,
    "total: 4",
    "pace: auto",
    `title: ${title}`,
    "---",
    "body",
    "```",
  ].join("\n");
}

function ended(answer: string) {
  return { ...emptyRunStream(), finalContent: answer, status: "completed" as const };
}

async function mount(
  update: ReturnType<typeof create>,
  props: AutoContinueInput,
): Promise<void> {
  await act(async () => {
    update.update(createElement(Harness, props));
  });
}

test("a second design ending on the same step is carried forward too", async () => {
  const sent: string[] = [];
  const send = (text: string) => sent.push(text);
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(createElement(Harness, {
      design: "design-1",
      running: false,
      run: emptyRunStream(),
      send,
      sessionId: "s",
    }));
  });

  await mount(renderer!, { design: "design-1", running: true, run: emptyRunStream(), send, sessionId: "s" });
  await mount(renderer!, { design: "design-1", running: false, run: ended(card("度量")), send, sessionId: "s" });
  assert.equal(sent.length, 1);

  // A new design in the same conversation stops on the same step number, even
  // with the same words. The step was already carried once, but this ending
  // belongs to a different design.
  await mount(renderer!, { design: "design-2", running: true, run: emptyRunStream(), send, sessionId: "s" });
  await mount(renderer!, { design: "design-2", running: false, run: ended(card("度量")), send, sessionId: "s" });
  assert.equal(sent.length, 2);
  renderer!.unmount();
});

test("the same ending is carried forward once", async () => {
  const sent: string[] = [];
  const send = (text: string) => sent.push(text);
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(createElement(Harness, {
      design: "design-1",
      running: false,
      run: emptyRunStream(),
      send,
      sessionId: "s",
    }));
  });

  await mount(renderer!, { design: "design-1", running: true, run: emptyRunStream(), send, sessionId: "s" });
  await mount(renderer!, { design: "design-1", running: false, run: ended(card("度量")), send, sessionId: "s" });
  // The same words again would be another paid call answering a card that has
  // already been answered.
  await mount(renderer!, { design: "design-1", running: true, run: emptyRunStream(), send, sessionId: "s" });
  await mount(renderer!, { design: "design-1", running: false, run: ended(card("度量")), send, sessionId: "s" });
  assert.equal(sent.length, 1);
  renderer!.unmount();
});

test("a reworded repeat of the same step is the same step", async () => {
  // Keying the watermark on the answer made two designs distinguishable, and
  // also made every rewording of one step a new ending: the model writes the
  // card again with a different number in it, is answered again, and the
  // design turns into an unattended loop of paid turns that never advances.
  const sent: string[] = [];
  const send = (text: string) => sent.push(text);
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(createElement(Harness, {
      design: "design-1",
      running: false,
      run: emptyRunStream(),
      send,
      sessionId: "s",
    }));
  });

  await mount(renderer!, { design: "design-1", running: true, run: emptyRunStream(), send, sessionId: "s" });
  await mount(renderer!, { design: "design-1", running: false, run: ended(card("度量：压缩比")), send, sessionId: "s" });
  assert.equal(sent.length, 1);

  await mount(renderer!, { design: "design-1", running: true, run: emptyRunStream(), send, sessionId: "s" });
  await mount(renderer!, { design: "design-1", running: false, run: ended(card("度量：压缩比 0.8")), send, sessionId: "s" });
  assert.equal(sent.length, 1);
  renderer!.unmount();
});

test("a new design's first ending is not refused by the previous design's step", async () => {
  // The anchor has to be the new design's before the server has persisted its
  // command: a design's first turn can end while its command is still only the
  // pending message. Reading the anchor from the transcript would leave it at
  // the previous design's id, and a first turn that stops on a step the
  // previous design already carried would be refused — an auto card with
  // nothing to press, unattended.
  const sent: string[] = [];
  const send = (text: string) => sent.push(text);
  const props = (design: string, running: boolean, run = emptyRunStream()) => ({
    design, running, run, send, sessionId: "s",
  });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(createElement(Harness, props("design-1", false)));
  });

  await mount(renderer!, props("design-1", true));
  await mount(renderer!, props("design-1", false, ended(card("度量", 1))));
  await mount(renderer!, props("design-1", true));
  await mount(renderer!, props("design-1", false, ended(card("冻结", 2))));
  assert.equal(sent.length, 2);

  // Design 2 starts, its command still pending, and stops on step 2 — the step
  // design 1 last carried.
  await mount(renderer!, props("design-2", true));
  await mount(renderer!, props("design-2", false, ended(card("冻结", 2))));
  assert.equal(sent.length, 3);
  renderer!.unmount();
});

test("the anchor a command starts with never repeats the one before it", () => {
  // `App` bumps this the moment a command leaves the window, so the anchor is
  // already the new design's during its first turn.
  assert.equal(startedDesign(undefined), "design-1");
  assert.equal(startedDesign("design-1"), "design-2");
  // A reload restores the anchor from the transcript, where it is a message
  // id; the first design started afterwards cannot collide with it.
  assert.notEqual(startedDesign("2f1c8a9e-0b7d-4c1a-9f0e-1a2b3c4d5e6f"),
    "2f1c8a9e-0b7d-4c1a-9f0e-1a2b3c4d5e6f");
});

test("only a design command starts a design", () => {
  // What `App` runs as each message leaves the window. The carried messages
  // are ordinary ones: bumping the anchor for them would make every carried
  // turn a new design, and the next ending would always be answered.
  assert.equal(designAnchorAfterSending(undefined, "/evolve-design --algorithm puct --no-confirm 压缩"), "design-1");
  assert.equal(designAnchorAfterSending("design-1", "/evolve-design --algorithm puct 第二个"), "design-2");
  assert.equal(designAnchorAfterSending("design-1", "继续步骤 1/4"), "design-1");
  assert.equal(designAnchorAfterSending(undefined, "普通问题"), undefined);
});

test("the watermark names the session, the design and the step", () => {
  assert.equal(autoContinueKey("s", "d", 1), autoContinueKey("s", "d", 1));
  assert.notEqual(autoContinueKey("s", "d", 1), autoContinueKey("s", "d", 2));
  assert.notEqual(autoContinueKey("s", "d", 1), autoContinueKey("s", "e", 1));
  assert.notEqual(autoContinueKey("s", "d", 1), autoContinueKey("t", "d", 1));
  // An anchor that has not been persisted yet still separates designs from a
  // session and a step.
  assert.notEqual(autoContinueKey("s", undefined, 1), autoContinueKey("s", "d", 1));
});

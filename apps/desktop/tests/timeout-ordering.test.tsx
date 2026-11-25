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

// 设置 › 超时 has one cross-field rule: with both gateway limits finite, the
// turn limit cannot be shorter than the idle limit (the rule
// `normalizeTimeoutSettings` enforces in services/api/src/store/settings.ts).
// These cases mount the real page and press its fields, because the defect was
// in what the blur handler sent and in what the failure handler did with the
// answer — neither of which a static render can show.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { afterEach, describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import React from "react";

import type { ApiClient } from "../src/api/client.js";
import { setLanguage, TEXT } from "../src/text.js";
import { TimeoutSettings } from "../src/views/settings/system/Timeouts.js";
import { json, StubClient } from "./api-stub.js";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "./support/dom-renderer.js";

afterEach(() => setLanguage("zh-CN"));

const LIMITED = {
  gatewayIdleTimeoutMs: 240_000,
  gatewayTurnTimeoutMs: 60_000,
  kernelIdleTimeoutMs: 60_000,
  permissionWaitTimeoutMs: 60_000,
  runnerExecTimeoutMs: 60_000,
};

/** The store's own sentence, the one the page must not print in a zh-CN UI. */
const SERVER_SENTENCE = "gatewayTurnTimeoutMs must be greater than or equal to "
  + "gatewayIdleTimeoutMs when both timeouts are finite";

const IDLE = "网关空闲超时";
const TURN = "单轮超时";

async function mount(client: ApiClient): Promise<ReactTestRenderer> {
  let created: ReactTestRenderer | undefined;
  await act(async () => { created = create(<TimeoutSettings client={client} />); });
  assert.ok(created, "the timeout page did not render");
  return created;
}

function field(view: ReactTestRenderer, label: string): ReactTestInstance {
  const input = view.root.findAllByType("input").find((entry) => entry.props["aria-label"] === label);
  assert.ok(input, `${label} is not rendered`);
  return input;
}

function notes(view: ReactTestRenderer): string[] {
  return view.root
    .findAll((node) => typeof node.props?.className === "string"
      && node.props.className.split(" ").includes("row-note"))
    .map((node) => String(node.props.children));
}

function failureNote(view: ReactTestRenderer): string | undefined {
  return view.root
    .findAll((node) => typeof node.props?.className === "string"
      && node.props.className.split(" ").includes("is-error"))
    .map((node) => String(node.props.children))
    .at(-1);
}

/** Type into a number field the way the browser does: one `onChange` per edit. */
async function type(view: ReactTestRenderer, label: string, value: string) {
  const input = field(view, label);
  await act(async () => { input.props.onChange({ target: { value } }); });
}

/** Leave the field, which is what commits it (there is no 保存 button). */
async function blur(view: ReactTestRenderer, label: string) {
  const input = field(view, label);
  await act(async () => { input.props.onBlur(); });
}

function writes(stub: StubClient) {
  return stub.calls.filter((call) => call.init.method === "PUT");
}

/** One recorded write by position, narrowed for the body assertions. */
function writeAt(stub: StubClient, index: number) {
  const call = writes(stub)[index];
  assert.ok(call, `no write at index ${index}`);
  return call;
}

describe("超时 ordering rule", () => {
  it("states the rule on 一轮对话, and says unlimited lifts it", async () => {
    const view = await mount(new StubClient().reply(LIMITED).asClient());
    try {
      const hints = view.root.findAllByType("small")
        .map((node) => node.props.children)
        .filter((children): children is string => typeof children === "string");
      const hint = hints.find((text) => text.includes("一轮对话允许的最长时间"));
      assert.ok(hint, "the turn hint is gone");
      assert.match(hint, /不短于/u);
      assert.match(hint, /网关空闲/u);
      assert.match(hint, /不限/u);

      setLanguage("en");
      const english = await mount(new StubClient().reply(LIMITED).asClient());
      try {
        const markup = JSON.stringify(english.toJSON());
        // The wording the service catalogue already uses for this field.
        assert.ok(markup.includes("When both are set, the turn limit is at least the idle limit"),
          "the English hint does not state the ordering rule");
        assert.ok(markup.includes("setting either one to unlimited removes the rule"),
          "the English hint does not mention the unlimited exception");
      } finally {
        await act(async () => { english.unmount(); });
      }
    } finally {
      await act(async () => { view.unmount(); });
    }
  });

  it("refuses a turn limit below the idle limit at the field, without a write", async () => {
    const stub = new StubClient().reply(LIMITED);
    const view = await mount(stub.asClient());
    try {
      const requests = stub.calls.length;
      await type(view, TURN, "30");
      await blur(view, TURN);

      assert.equal(writes(stub).length, 0, "the invalid pair was sent to the service");
      assert.equal(stub.calls.length, requests, "the page made a request it should have refused");
      const turn = field(view, TURN);
      assert.equal(turn.props["aria-invalid"], true, "the refused field is not marked");
      assert.equal(turn.props.value, "30", "the draft was thrown away instead of kept");
      assert.deepEqual(notes(view), [TEXT.settings.system.timeouts.orderError]);

      // The draft is still the reader's: correcting it writes the whole pair.
      await type(view, TURN, "300");
      await blur(view, TURN);
      assert.equal(writes(stub).length, 1);
      assert.deepEqual(json(writeAt(stub, 0)), { ...LIMITED, gatewayTurnTimeoutMs: 300_000 });
      assert.equal(field(view, TURN).props["aria-invalid"], false, "the mark survived the correction");
      assert.deepEqual(notes(view), []);
    } finally {
      await act(async () => { view.unmount(); });
    }
  });

  it("keeps 不限 on either side valid, and seeds a value the pair accepts", async () => {
    // The shipped defaults: idle 240 s, turn unlimited. Turning 不限 off used
    // to seed 60 s, so the very first press on this page was refused.
    const stub = new StubClient().reply({ ...LIMITED, gatewayTurnTimeoutMs: 0 });
    const view = await mount(stub.asClient());
    try {
      // 0 is not a finite limit, so an idle limit larger than a finite turn
      // limit is fine while the turn limit is unlimited.
      await type(view, IDLE, "600");
      await blur(view, IDLE);
      assert.equal(writes(stub).length, 1);
      assert.deepEqual(json(writeAt(stub, 0)), { ...LIMITED, gatewayIdleTimeoutMs: 600_000, gatewayTurnTimeoutMs: 0 });
      assert.equal(field(view, IDLE).props["aria-invalid"], false);
      assert.deepEqual(notes(view), []);

      const unlimited = view.root.findAllByType("button")
        .find((node) => node.props["aria-label"] === `${TURN} · ${TEXT.settings.system.timeouts.unlimited}`);
      assert.ok(unlimited, "the turn unlimited switch is gone");
      await act(async () => { unlimited.props.onClick(); });

      // The restored value is one the pair still accepts: the idle limit here,
      // not a fixed 60 s the service would refuse against it.
      assert.equal(writes(stub).length, 2, "the seeded value was not written");
      assert.deepEqual(json(writeAt(stub, 1)), { ...LIMITED, gatewayIdleTimeoutMs: 600_000, gatewayTurnTimeoutMs: 600_000 });
      assert.equal(field(view, TURN).props.value, "600");
      assert.equal(field(view, TURN).props["aria-invalid"], false);
      assert.deepEqual(notes(view), []);
    } finally {
      await act(async () => { view.unmount(); });
    }
  });

  it("keeps an unrelated edit when the service refuses the write, and localizes why", async () => {
    const stub = new StubClient().reply(LIMITED).fail(new Error(SERVER_SENTENCE));
    const view = await mount(stub.asClient());
    try {
      // A valid pair from the page's point of view; the service disagrees.
      await type(view, IDLE, "30");
      await blur(view, IDLE);
      assert.equal(writes(stub).length, 1, "the edit never reached the service");

      const failure = failureNote(view);
      assert.equal(failure, TEXT.settings.system.timeouts.orderError);
      assert.ok(!failure?.includes("gatewayTurnTimeoutMs"), "the raw server sentence is on screen");
      // The unrelated edit the reader made is still theirs, and only the
      // field the refusal names is marked.
      assert.equal(field(view, IDLE).props.value, "30", "the idle edit was reverted");
      assert.equal(field(view, TURN).props["aria-invalid"], true);

      // Correcting the named field re-sends both edits together.
      stub.reply({ ...LIMITED, gatewayIdleTimeoutMs: 30_000, gatewayTurnTimeoutMs: 240_000 });
      await type(view, TURN, "240");
      await blur(view, TURN);
      assert.equal(writes(stub).length, 2);
      assert.deepEqual(json(writeAt(stub, 1)), {
        ...LIMITED,
        gatewayIdleTimeoutMs: 30_000,
        gatewayTurnTimeoutMs: 240_000,
      });
      assert.equal(failureNote(view), undefined, "the refusal stayed on screen after a success");
    } finally {
      await act(async () => { view.unmount(); });
    }
  });

  it("does not show a saved timestamp when an earlier write resolves after a refusal", async () => {
    // The first write is held on the wire while the reader produces an
    // invalid pair, so the refusal has already cleared the timestamp when
    // that write finally resolves. Its success must not bring it back.
    let release: () => void = () => {
      throw new Error("the deferred write was released before the test made it wait");
    };
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: { init: RequestInit; path: string }[] = [];
    const client = {
      request: async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
        calls.push({ init, path });
        if (init.method === "PUT") await gate;
        return LIMITED as T;
      },
    } as unknown as ApiClient;
    const view = await mount(client);
    try {
      const saved = () => JSON.stringify(view.toJSON()).includes(TEXT.settings.system.timeouts.saved);
      // A valid edit starts the write, which stays in flight.
      await type(view, IDLE, "30");
      await blur(view, IDLE);
      assert.equal(calls.filter((call) => call.init.method === "PUT").length, 1);

      // While that write is on the wire, a pair outside the rule is refused
      // at the field.
      await type(view, TURN, "20");
      await blur(view, TURN);
      assert.equal(field(view, TURN).props["aria-invalid"], true);
      assert.ok(!saved(), "the refused draft was reported as saved");

      // The earlier write resolves last: it describes the old draft, not the
      // refused one the reader is looking at.
      await act(async () => { release(); await gate; });
      assert.ok(!saved(), "the resolved write put 已保存 back next to an unsaved draft");
      assert.equal(field(view, TURN).props["aria-invalid"], true);
    } finally {
      await act(async () => { view.unmount(); });
    }
  });

  it("clears the saved timestamp when a later draft is refused", async () => {
    const stub = new StubClient().reply(LIMITED);
    const view = await mount(stub.asClient());
    try {
      const saved = () => JSON.stringify(view.toJSON()).includes(TEXT.settings.system.timeouts.saved);
      // A valid write is acknowledged, so the page says so.
      await type(view, IDLE, "30");
      await blur(view, IDLE);
      assert.equal(writes(stub).length, 1);
      assert.ok(saved(), "the page did not acknowledge the write it made");

      // Then the pair is refused: the old timestamp no longer describes what
      // is on screen, so it must not sit next to the unsaved value.
      await type(view, TURN, "20");
      await blur(view, TURN);
      assert.equal(writes(stub).length, 1, "the refused pair was written");
      assert.ok(!saved(), "the saved timestamp still claims the refused draft was saved");
    } finally {
      await act(async () => { view.unmount(); });
    }
  });

  it("sends a correction that arrived while the refused write was in flight", async () => {
    const stub = new StubClient().reply(LIMITED)
      .fail(new Error(SERVER_SENTENCE))
      .reply({ ...LIMITED, gatewayIdleTimeoutMs: 20_000 });
    const view = await mount(stub.asClient());
    try {
      // Two blurs in one task: the second draft is queued while the first PUT
      // is still on the wire, so the refusal must not discard it.
      await act(async () => {
        field(view, IDLE).props.onChange({ target: { value: "30" } });
        field(view, IDLE).props.onBlur();
        field(view, IDLE).props.onChange({ target: { value: "20" } });
        field(view, IDLE).props.onBlur();
      });

      assert.equal(writes(stub).length, 2, "the corrected draft was dropped with the refused one");
      assert.deepEqual(json(writeAt(stub, 1)), { ...LIMITED, gatewayIdleTimeoutMs: 20_000 });
      assert.equal(field(view, IDLE).props.value, "20");
      assert.equal(failureNote(view), undefined);
    } finally {
      await act(async () => { view.unmount(); });
    }
  });
});

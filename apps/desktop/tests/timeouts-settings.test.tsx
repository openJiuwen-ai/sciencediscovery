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

import React from "react";
import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { ApiClient } from "../src/api/client.js";
import type { SystemTimeoutSettings } from "../src/api/types.js";
import { TEXT } from "../src/text.js";
import { TimeoutSettings } from "../src/views/settings/system/Timeouts.js";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "./support/dom-renderer.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { addEventListener() {}, removeEventListener() {} } });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

type Call = { path: string; method: string; body: unknown };
class Client extends ApiClient {
  calls: Call[] = [];
  constructor(readonly handle: (call: Call) => unknown | Promise<unknown>) { super(""); }
  override async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const call = { path, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) as unknown : undefined };
    this.calls.push(call);
    return await this.handle(call) as T;
  }
}
const writes = (client: Client) => client.calls.filter(call => call.method !== "GET");
const markup = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());
function handler(node: ReactTestInstance, event: string, ...args: unknown[]) {
  const fn = node.props[event]; assert.ok(typeof fn === "function"); return fn(...args);
}
async function mount(element: React.ReactElement): Promise<ReactTestRenderer> {
  let view: ReactTestRenderer | undefined;
  await act(async () => { view = create(element); }); assert.ok(view); return view;
}
async function close(view: ReactTestRenderer) { await act(async () => view.unmount()); }

/** 超时 with every limit set to a real duration, so no switch starts on, and
 *  with the gateway pair inside its ordering rule (turn not shorter than idle),
 *  so a commit here is refused only by what a case is actually typing. */
const settings: SystemTimeoutSettings = {
  gatewayIdleTimeoutMs: 240_000,
  gatewayTurnTimeoutMs: 300_000,
  kernelIdleTimeoutMs: 60_000,
  permissionWaitTimeoutMs: 60_000,
  runnerExecTimeoutMs: 60_000,
};

function timeoutClient(initial: SystemTimeoutSettings = settings) {
  let current = { ...initial };
  const client = new Client(call => { if (call.method === "PUT") current = call.body as SystemTimeoutSettings; return current; });
  return { client, current: () => current };
}

const field = (view: ReactTestRenderer, label: string) => view.root.findByProps({ "aria-label": label });
const toggle = (view: ReactTestRenderer, label: string) => view.root.findByProps({
  role: "switch", "aria-label": `${label} · ${TEXT.settings.system.timeouts.unlimited}`,
});

test("typing 0 on the way to 0.5 keeps the field editable and stores the typed value", async () => {
  const { client } = timeoutClient();
  const view = await mount(<TimeoutSettings client={client} />);
  const label = TEXT.settings.system.timeouts.gatewayIdle;
  try {
    assert.equal(field(view, label).props.value, "240");
    await act(async () => { handler(field(view, label), "onChange", { target: { value: "0" } }); });
    // The intermediate zero is text in the box. Written to the draft it would
    // be 不限, which disables the box that is being typed in.
    assert.equal(field(view, label).props.disabled, false);
    assert.equal(field(view, label).props.value, "0");
    assert.equal(writes(client).length, 0, "a keystroke is not a write");

    await act(async () => { handler(field(view, label), "onChange", { target: { value: "0.5" } }); });
    assert.equal(field(view, label).props.disabled, false);
    assert.equal(field(view, label).props.value, "0.5");
    assert.equal(writes(client).length, 0);

    await act(async () => { handler(field(view, label), "onBlur"); });
    assert.deepEqual(writes(client)[0]?.body, { ...settings, gatewayIdleTimeoutMs: 500 });
    assert.equal(field(view, label).props.value, "0.5");
    assert.equal(toggle(view, label).props["aria-checked"], false);
  } finally { await close(view); }
});

test("one millisecond is stored as 1 ms rather than being rounded away", async () => {
  const { client, current } = timeoutClient();
  const view = await mount(<TimeoutSettings client={client} />);
  const label = TEXT.settings.system.timeouts.runnerExec;
  try {
    await act(async () => { handler(field(view, label), "onChange", { target: { value: "0.001" } }); });
    assert.equal(field(view, label).props.disabled, false);
    await act(async () => { handler(field(view, label), "onBlur"); });
    assert.deepEqual(writes(client)[0]?.body, { ...settings, runnerExecTimeoutMs: 1 });
    assert.equal(current().runnerExecTimeoutMs, 1);
    assert.equal(field(view, label).props.value, "0.001");
  } finally { await close(view); }
});

test("a typed 0 is refused with a message and never becomes unlimited", async () => {
  const { client, current } = timeoutClient();
  const view = await mount(<TimeoutSettings client={client} />);
  const label = TEXT.settings.system.timeouts.kernelIdle;
  try {
    await act(async () => { handler(field(view, label), "onChange", { target: { value: "0" } }); });
    await act(async () => { handler(field(view, label), "onBlur"); });
    assert.equal(writes(client).length, 0, "0 is not a value the box may write");
    assert.equal(current().kernelIdleTimeoutMs, 60_000, "the stored meaning of 0 is untouched");
    assert.equal(field(view, label).props.disabled, false);
    assert.equal(field(view, label).props["aria-invalid"], true);
    assert.ok(markup(view).includes(TEXT.settings.system.migrated.common.invalidNumber));
    // Correcting the box clears the message and saves the new number.
    await act(async () => { handler(field(view, label), "onChange", { target: { value: "0.5" } }); });
    assert.equal(markup(view).includes(TEXT.settings.system.migrated.common.invalidNumber), false);
    await act(async () => { handler(field(view, label), "onBlur"); });
    assert.deepEqual(writes(client)[0]?.body, { ...settings, kernelIdleTimeoutMs: 500 });
  } finally { await close(view); }
});

test("the unlimited switch is the only path to 0 and restores the previous limit", async () => {
  const { client, current } = timeoutClient();
  const view = await mount(<TimeoutSettings client={client} />);
  // An execution limit is outside the gateway ordering pair, so what the switch
  // restores here is the field's own previous value.
  const label = TEXT.settings.system.timeouts.runnerExec;
  try {
    assert.equal(field(view, label).props.value, "60");
    await act(async () => { handler(toggle(view, label), "onClick"); });
    assert.deepEqual(writes(client)[0]?.body, { ...settings, runnerExecTimeoutMs: 0 });
    assert.equal(current().runnerExecTimeoutMs, 0);
    assert.equal(field(view, label).props.disabled, true);
    assert.equal(field(view, label).props.value, "");

    await act(async () => { handler(toggle(view, label), "onClick"); });
    assert.deepEqual(writes(client)[1]?.body, { ...settings, runnerExecTimeoutMs: 60_000 });
    assert.equal(field(view, label).props.disabled, false);
    assert.equal(field(view, label).props.value, "60");
  } finally { await close(view); }
});

test("a half-typed number does not come back after the unlimited switch", async () => {
  const { client } = timeoutClient();
  const view = await mount(<TimeoutSettings client={client} />);
  const label = TEXT.settings.system.timeouts.permissionWait;
  try {
    await act(async () => { handler(field(view, label), "onChange", { target: { value: "0.5" } }); });
    await act(async () => { handler(toggle(view, label), "onClick"); });
    assert.equal(writes(client).length, 1);
    assert.equal(field(view, label).props.value, "");
    await act(async () => { handler(toggle(view, label), "onClick"); });
    assert.deepEqual(writes(client)[1]?.body, { ...settings, permissionWaitTimeoutMs: 60_000 });
    assert.equal(field(view, label).props.value, "60");
    assert.equal(field(view, label).props.disabled, false);
  } finally { await close(view); }
});

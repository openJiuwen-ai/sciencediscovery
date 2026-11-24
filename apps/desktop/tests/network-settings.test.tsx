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

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { ApiClient } from "../src/api/client.js";
import type { SandboxNetworkSettings } from "../src/api/types.js";
import type { ConfirmRequest } from "../src/app/use-workspace.js";
import { TEXT } from "../src/text.js";
import { NetworkSettings } from "../src/views/settings/NetworkSettings.js";

// react-test-renderer's act() is used directly here, outside a test renderer
// environment that would set this itself; without it React warns on every
// mount and update in this file.
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

const t = TEXT.settings.network.sandbox;

const POLICY: SandboxNetworkSettings = {
  allowPrivateNetwork: false,
  allowedDomains: [],
  egressProxyPolicy: "inherit",
  mode: "none",
};

type Call = { body?: unknown; method: string; path: string };

/**
 * The pane reads the policy, writes it with a PUT, and reads it again. The
 * mock is stateful so the reload after a write shows what the server now
 * holds, a held PUT lets a test look at the screen while a save is still in
 * flight, and `failNextGet` makes the reload after a successful write fail so
 * the pane is left showing a value it can no longer vouch for.
 */
function client(
  initial: SandboxNetworkSettings,
  options: { failNextGet?: boolean; holdWrite?: boolean } = {},
) {
  let value = { ...initial, allowedDomains: [...initial.allowedDomains] };
  let failGet = false;
  const calls: Call[] = [];
  const releases: Array<() => void> = [];
  const api = {
    calls,
    release: () => releases.shift()?.(),
    request: async (path: string, init?: { body?: string; method?: string }) => {
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ body, method, path });
      if (path !== "/api/sandbox-network-settings") throw new Error(`unmocked ${method} ${path}`);
      if (method === "GET") {
        // The first read is what mounts the pane; only the reload that follows
        // a write is the one this option breaks.
        if (failGet) {
          failGet = false;
          throw new Error("sandbox network settings are unavailable");
        }
        return { ...value, allowedDomains: [...value.allowedDomains] };
      }
      if (method === "PUT") {
        if (options.holdWrite) await new Promise<void>((resolve) => releases.push(resolve));
        value = { ...(body as SandboxNetworkSettings) };
        failGet = options.failNextGet === true;
        return { ...value, allowedDomains: [...value.allowedDomains] };
      }
      throw new Error(`unmocked ${method} ${path}`);
    },
  };
  return api as unknown as ApiClient & { calls: Call[]; release: () => void };
}

async function flush(times = 12): Promise<void> {
  for (let tick = 0; tick < times; tick += 1) await Promise.resolve();
}

interface Mounted {
  confirms: ConfirmRequest[];
  toasts: string[];
  view: ReactTestRenderer;
}

async function mount(api: ApiClient): Promise<Mounted> {
  const confirms: ConfirmRequest[] = [];
  const toasts: string[] = [];
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(React.createElement(NetworkSettings, {
      client: api,
      onConfirm: (request: ConfirmRequest) => confirms.push(request),
      toast: (message: string) => toasts.push(message),
    }));
  });
  await act(async () => { await flush(); });
  return { confirms, toasts, view };
}

async function close(view: ReactTestRenderer): Promise<void> {
  await act(async () => { view.unmount(); });
}

function label(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : label(child)).join("");
}

function pill(root: ReactTestInstance, text: string): ReactTestInstance {
  const found = root.findAll((node) => node.type === "button" && label(node).trim() === text);
  assert.equal(found.length, 1, `expected one button labelled ${text}`);
  return found[0]!;
}

function puts(api: ApiClient & { calls: Call[] }): Call[] {
  return api.calls.filter((call) => call.method === "PUT");
}

test("pressing the already active 开放网络 asks nothing, writes nothing, and does not fail silently", async () => {
  const api = client({ ...POLICY, mode: "open" });
  const { confirms, toasts, view } = await mount(api);
  assert.equal(pill(view.root, t.modeOpen).props["aria-pressed"], true);

  await act(async () => {
    pill(view.root, t.modeOpen).props.onClick();
    await flush();
  });

  // The mode is already what the press asked for. Before the fix this raised
  // the confirmation anyway; accepting it then wrote nothing and said nothing.
  assert.equal(confirms.length, 0, "no confirmation for the mode that is already active");
  assert.equal(puts(api).length, 0, "no write for a press that changes nothing");
  assert.equal(toasts.length, 0, "no toast for a press that changes nothing");
  assert.equal(pill(view.root, t.modeOpen).props["aria-pressed"], true);
  await close(view);
});

test("开放网络 confirms, cancel keeps 无网络, and accept writes open exactly once", async () => {
  const api = client(POLICY);
  const { confirms, toasts, view } = await mount(api);
  assert.equal(pill(view.root, t.modeNone).props["aria-pressed"], true);

  await act(async () => {
    pill(view.root, t.modeOpen).props.onClick();
    await flush();
  });

  assert.equal(confirms.length, 1, "the press raises one confirmation");
  assert.equal(confirms[0]!.title, t.modeOpen);
  assert.equal(confirms[0]!.body, t.modeOpenWarning);
  // Cancel is the dialog dismissing without accepting: nothing is written and
  // the mode stays where it was.
  assert.equal(puts(api).length, 0, "the question is asked before any write");
  assert.equal(pill(view.root, t.modeNone).props["aria-pressed"], true);

  await act(async () => {
    await confirms[0]!.onAccept();
    await flush();
  });

  const writes = puts(api);
  assert.equal(writes.length, 1, "accept writes the mode once");
  assert.equal(writes[0]!.path, "/api/sandbox-network-settings");
  assert.deepEqual(writes[0]!.body, { ...POLICY, mode: "open" });
  assert.deepEqual((writes[0]!.body as SandboxNetworkSettings).allowedDomains, [], "open carries no allowlist");
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0], t.saved);
  assert.equal(pill(view.root, t.modeOpen).props["aria-pressed"], true);
  assert.equal(pill(view.root, t.modeNone).props["aria-pressed"], false);
  await close(view);
});

test("the modes are disabled with a visible reason while a save is in flight", async () => {
  const api = client(POLICY, { holdWrite: true });
  const { confirms, view } = await mount(api);

  await act(async () => {
    pill(view.root, t.modeOpen).props.onClick();
    await flush();
  });
  let accepted!: Promise<void>;
  await act(async () => {
    accepted = Promise.resolve(confirms[0]!.onAccept());
    await flush();
  });

  for (const text of [t.modeNone, t.modeAllowlist, t.modeOpen]) {
    const button = pill(view.root, text);
    assert.equal(button.props.disabled, true, `${text} is disabled while saving`);
    assert.equal(button.props.title, t.switching, `${text} says why it is disabled`);
    const describedBy = button.props["aria-describedby"];
    assert.ok(describedBy, `${text} points at the visible reason`);
    const note = view.root.findAll((node) => node.type === "small" && node.props.id === describedBy);
    assert.equal(note.length, 1, `${text}'s reason is in the document`);
    assert.equal(label(note[0]!), t.switching);
  }
  // A press that cannot run still does not open a second confirmation.
  await act(async () => {
    pill(view.root, t.modeNone).props.onClick();
    await flush();
  });
  assert.equal(confirms.length, 1);
  assert.equal(puts(api).length, 1, "the held write is the only write");

  await act(async () => {
    api.release();
    await accepted;
    await flush();
  });
  assert.equal(pill(view.root, t.modeOpen).props.disabled, false, "the pills come back after the save");
  assert.ok(!JSON.stringify(view.toJSON()).includes(t.switching), "the reason goes with the disabled state");
  await close(view);
});

test("a failed reload disables the modes with the stale-value reason", async () => {
  const api = client(POLICY, { failNextGet: true });
  const { confirms, view } = await mount(api);
  assert.equal(pill(view.root, t.modeNone).props.disabled, false);

  await act(async () => {
    pill(view.root, t.modeOpen).props.onClick();
    await flush();
  });
  await act(async () => {
    await confirms[0]!.onAccept();
    await flush(20);
  });

  // The write landed, but the page could not read the policy back. It keeps
  // the value it had and must not write from it again.
  assert.equal(puts(api).length, 1);
  for (const text of [t.modeNone, t.modeAllowlist, t.modeOpen]) {
    const button = pill(view.root, text);
    assert.equal(button.props.disabled, true, `${text} is disabled while the value is stale`);
    assert.equal(button.props.title, t.staleMode, `${text} says the value is stale`);
    const describedBy = button.props["aria-describedby"];
    assert.ok(describedBy, `${text} points at the visible reason`);
    const note = view.root.findAll((node) => node.type === "small" && node.props.id === describedBy);
    assert.equal(note.length, 1, `${text}'s reason is in the document`);
    assert.equal(label(note[0]!), t.staleMode);
  }
  await act(async () => {
    pill(view.root, t.modeNone).props.onClick();
    pill(view.root, t.modeOpen).props.onClick();
    await flush();
  });
  assert.equal(confirms.length, 1, "no confirmation is raised from a stale page");
  assert.equal(puts(api).length, 1, "a stale page writes nothing");
  await close(view);
});

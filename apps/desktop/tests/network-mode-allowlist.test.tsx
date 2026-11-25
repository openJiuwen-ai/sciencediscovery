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

/**
 * Issue #1399: picking 无网络 used to send `allowedDomains: []` and blank the
 * box, so a hand-written allowlist was erased by a mode the service accepts
 * with domains attached (`services/api/src/store/sandbox-network.ts` forbids
 * them only for `open`). These cases press the real pills and assert on the
 * bodies the page sends, because the defect was in what it wrote, not in what
 * it rendered.
 */

import React from "react";
import assert from "node:assert/strict";

import { createTest } from "../../../test/support/tagged/compat.mjs";
import { ApiClient } from "../src/api/client.js";
import type { SandboxNetworkMode, SandboxNetworkSettings } from "../src/api/types.js";
import type { ConfirmRequest } from "../src/app/use-workspace.js";
import { TEXT } from "../src/text.js";
import { NetworkSettings } from "../src/views/settings/NetworkSettings.js";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "./support/dom-renderer.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

const sandbox = TEXT.settings.network.sandbox;
const savedDomains = ["example.org", "*.example.org:443"];

type Call = { body: unknown; method: string; path: string };

/** The page reads on mount and after every write, so the stub has to answer
 *  GET with whatever the last PUT stored — the same round trip the service
 *  performs, including the part where it keeps `none` with its domains. */
class Client extends ApiClient {
  calls: Call[] = [];
  /** How many of the next GETs fail. The page keeps the value it already had,
   *  which is what leaves a refetch unable to answer a press. */
  failGets = 0;
  /** A message makes the next PUT fail with it. */
  rejectNextPut?: string;
  constructor(public settings: SandboxNetworkSettings) {
    super("");
  }
  override async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const call: Call = {
      body: init.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
      method: init.method ?? "GET",
      path,
    };
    this.calls.push(call);
    if (call.method === "PUT") {
      const rejection = this.rejectNextPut;
      if (rejection !== undefined) {
        this.rejectNextPut = undefined;
        throw new Error(rejection);
      }
      this.settings = call.body as SandboxNetworkSettings;
    }
    if (call.method === "GET" && this.failGets > 0) {
      this.failGets -= 1;
      throw new Error("settings read failed");
    }
    return this.settings as T;
  }
}

function settings(mode: SandboxNetworkMode = "domain-allowlist"): SandboxNetworkSettings {
  return {
    allowPrivateNetwork: false,
    allowedDomains: [...savedDomains],
    egressProxyPolicy: "inherit",
    mode,
  };
}

function openSettings(): SandboxNetworkSettings {
  return { ...settings("open"), allowedDomains: [] };
}

const puts = (client: Client) =>
  client.calls.filter((call) => call.method === "PUT").map((call) => call.body as SandboxNetworkSettings);

async function flush(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

async function mount(client: Client, onConfirm: (request: ConfirmRequest) => void = () => {}) {
  let view: ReactTestRenderer | undefined;
  await act(async () => {
    view = create(<NetworkSettings client={client} onConfirm={onConfirm} toast={() => {}} />);
  });
  assert.ok(view, "NetworkSettings did not mount");
  return view;
}

function pill(view: ReactTestRenderer, label: string): ReactTestInstance {
  const node = view.root
    .findAllByType("button")
    .find((item) => typeof item.props["aria-pressed"] === "boolean" && item.children.includes(label));
  assert.ok(node, `Missing pill: ${label}`);
  return node;
}

function button(view: ReactTestRenderer, label: string): ReactTestInstance {
  const node = view.root.findAllByType("button").find((item) => item.children.includes(label));
  assert.ok(node, `Missing button: ${label}`);
  return node;
}

async function press(node: ReactTestInstance): Promise<void> {
  await act(async () => {
    (node.props.onClick as () => void)();
    await flush();
  });
}

const domainsBox = (view: ReactTestRenderer) => view.root.findByProps({ "aria-label": sandbox.domains });

/** Typing into the box is the draft and nothing else: no request leaves the page. */
async function typeDomains(view: ReactTestRenderer, text: string): Promise<void> {
  await act(async () => {
    (domainsBox(view).props.onChange as (event: { target: { value: string } }) => void)({ target: { value: text } });
    await flush();
  });
}

test("无网络 keeps the saved allowlist on the wire and in the draft (#1399)", async () => {
  const client = new Client(settings());
  const view = await mount(client);
  try {
    assert.equal(domainsBox(view).props.value, savedDomains.join("\n"));

    await press(pill(view, sandbox.modeNone));

    // The regression: `none` used to be sent as `{ mode: "none", allowedDomains: [] }`.
    assert.equal(puts(client).length, 1);
    assert.deepEqual(puts(client)[0], { ...settings(), mode: "none" });

    // A toggle is not the save button: it must not raise the empty-list hint.
    assert.ok(!JSON.stringify(view.toJSON()).includes(sandbox.emptyDomains));

    // Back to 域名白名单: the draft still carries the same hosts, and 保存 is
    // the only thing that writes them.
    await press(pill(view, sandbox.modeAllowlist));
    assert.equal(puts(client).length, 1, "picking 域名白名单 stages the mode instead of writing");
    assert.equal(domainsBox(view).props.value, savedDomains.join("\n"));

    await press(button(view, sandbox.saveDomains));
    assert.equal(puts(client).length, 2);
    assert.deepEqual(puts(client)[1], { ...settings(), mode: "domain-allowlist" });
  } finally {
    await act(async () => view.unmount());
  }
});

test("开放网络 still clears the allowlist behind its confirmation (#1399)", async () => {
  const client = new Client(settings());
  const confirms: ConfirmRequest[] = [];
  const view = await mount(client, (request) => confirms.push(request));
  try {
    await press(pill(view, sandbox.modeOpen));

    // 开放网络 keeps its confirmation, and nothing is written until it is accepted.
    assert.equal(confirms.length, 1);
    assert.equal(puts(client).length, 0);

    await act(async () => {
      await confirms[0]!.onAccept();
      await flush();
    });

    assert.deepEqual(puts(client)[0], { ...settings(), allowedDomains: [], mode: "open" });
    assert.equal(domainsBox(view).props.value, "");
  } finally {
    await act(async () => view.unmount());
  }
});

test("无网络 keeps domains the service already stores while the box stays inert (#1399)", async () => {
  // A catalog that already holds `none` with domains: the page must show the
  // saved hosts once 域名白名单 is picked, without a write in between.
  const client = new Client({ ...settings("none") });
  const view = await mount(client);
  try {
    assert.equal(domainsBox(view).props.value, "", "the box is disabled outside the allowlist mode");

    await press(pill(view, sandbox.modeAllowlist));

    assert.equal(puts(client).length, 0);
    assert.equal(domainsBox(view).props.value, savedDomains.join("\n"));
  } finally {
    await act(async () => view.unmount());
  }
});

test("a 无网络 press keeps allowlist text that was typed but not saved (#1399)", async () => {
  // The refetch a successful 无网络 write triggers must not replace the box
  // with the server's (unchanged) list: the text is the user's.
  const client = new Client(settings());
  const view = await mount(client);
  const typed = `${savedDomains.join("\n")}\ntyped-but-unsaved.example`;
  try {
    await typeDomains(view, typed);
    assert.equal(puts(client).length, 0, "typing is a draft, not a write");

    await press(pill(view, sandbox.modeNone));
    assert.deepEqual(puts(client)[0], { ...settings(), mode: "none" });

    await press(pill(view, sandbox.modeAllowlist));
    assert.equal(domainsBox(view).props.value, typed, "the unsaved entry came back with the rest");

    await press(button(view, sandbox.saveDomains));
    assert.equal(puts(client).length, 2);
    assert.deepEqual(puts(client)[1], {
      ...settings(),
      allowedDomains: [...savedDomains, "typed-but-unsaved.example"],
      mode: "domain-allowlist",
    });
  } finally {
    await act(async () => view.unmount());
  }
});

test("a half-typed list survives 无网络 from 开放网络 and 保存 writes it (#1399)", async () => {
  // The state the desktop E2E fixture starts from — 开放网络 with no domains —
  // plus one entry typed into the box and never saved. 无网络 must not turn
  // that into the empty-list hint.
  const client = new Client(openSettings());
  const view = await mount(client);
  try {
    await press(pill(view, sandbox.modeAllowlist));
    assert.equal(puts(client).length, 0, "opening the box is a stage, not a write");
    assert.equal(domainsBox(view).props.value, "");

    await typeDomains(view, "pypi.org");
    await press(pill(view, sandbox.modeNone));
    assert.deepEqual(puts(client)[0], { ...openSettings(), mode: "none" });

    await press(pill(view, sandbox.modeAllowlist));
    assert.equal(domainsBox(view).props.value, "pypi.org", "the half-typed list came back");
    assert.ok(!JSON.stringify(view.toJSON()).includes(sandbox.emptyDomains));

    await press(button(view, sandbox.saveDomains));
    assert.equal(puts(client).length, 2);
    assert.deepEqual(puts(client)[1], {
      ...openSettings(),
      allowedDomains: ["pypi.org"],
      mode: "domain-allowlist",
    });
    assert.ok(!JSON.stringify(view.toJSON()).includes(sandbox.emptyDomains), "保存 accepted the typed host");
  } finally {
    await act(async () => view.unmount());
  }
});

test("a failed refetch after 无网络 cannot leak stale text into a later 保存 (#1399)", async () => {
  // The read that follows the 无网络 write fails, so the parked text never meets
  // the answer it was parked for. The next successful read — the one 保存 asks
  // for — is a newer policy and must replace it.
  const client = new Client(settings());
  const view = await mount(client);
  const stale = `${savedDomains.join("\n")}\nTYPED-OLD.example`;
  try {
    await typeDomains(view, stale);
    client.failGets = 1;
    await press(pill(view, sandbox.modeNone));
    assert.deepEqual(puts(client)[0], { ...settings(), mode: "none" });

    await press(pill(view, sandbox.modeAllowlist));
    await typeDomains(view, "NEW-SAVED.example");
    await press(button(view, sandbox.saveDomains));

    assert.deepEqual(puts(client)[1]?.allowedDomains, ["NEW-SAVED.example"]);
    assert.equal(domainsBox(view).props.value, "NEW-SAVED.example", "the box shows the list that was saved");
    assert.ok(!String(domainsBox(view).props.value).includes("TYPED-OLD"), "no stale text survived the failed read");

    // A second press cannot silently write the abandoned list back either.
    await press(button(view, sandbox.saveDomains));
    assert.deepEqual(puts(client)[2]?.allowedDomains, ["NEW-SAVED.example"]);
  } finally {
    await act(async () => view.unmount());
  }
});

test("a refused 无网络 write keeps the typed list and can still be saved (#1399)", async () => {
  const client = new Client(settings());
  const view = await mount(client);
  const typed = `${savedDomains.join("\n")}\ntyped-but-unsaved.example`;
  try {
    await typeDomains(view, typed);
    client.rejectNextPut = "sandbox policy is locked";
    await press(pill(view, sandbox.modeNone));

    // The pill is back on the policy the server still holds, the reason is on
    // screen, and the text is the user's — the press was refused, not the entry.
    assert.equal(pill(view, sandbox.modeAllowlist).props["aria-pressed"], true);
    assert.ok(JSON.stringify(view.toJSON()).includes("sandbox policy is locked"));
    assert.equal(domainsBox(view).props.value, typed);

    await press(button(view, sandbox.saveDomains));
    assert.deepEqual(puts(client)[1], {
      ...settings(),
      allowedDomains: [...savedDomains, "typed-but-unsaved.example"],
      mode: "domain-allowlist",
    });
    assert.ok(!JSON.stringify(view.toJSON()).includes("sandbox policy is locked"));
  } finally {
    await act(async () => view.unmount());
  }
});

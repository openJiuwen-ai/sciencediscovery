// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ComputeNotice, ComputeStatus, useComputeReadiness } from "../src/ComputeReadiness.js";
import { ApiRequestError } from "../src/api/auth.js";
import { LocaleProvider } from "../src/i18n/index.js";

type Client = Parameters<typeof useComputeReadiness>[0];
type Probe = Awaited<ReturnType<Client["getRunnerExecutionCapability"]>>;
const unavailable: Probe = { runnerId: "local", connected: true, capability: {
  instanceId: "runner-1", checkedAt: "2026-10-25T00:00:00Z", sandbox: "bubblewrap", dependencyAvailable: true,
  sandboxUsable: false, ready: false, reason: "sandbox-unusable", detail: "bwrap: user namespaces are disabled",
} };
const ready: Probe = { ...unavailable, capability: { ...unavailable.capability!, ready: true, sandboxUsable: true, reason: "ready", detail: undefined } };

async function harness(client: Client) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let state!: ReturnType<typeof useComputeReadiness>;
  function Harness({ client }: { client: Client }) { state = useComputeReadiness(client); return null; }
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(Harness, { client })); });
  return { state: () => state, update: async (client: Client) => act(async () => view.update(createElement(Harness, { client }))),
    close: async () => act(async () => view.unmount()) };
}

test("API connectivity remains healthy when the local sandbox or Runner is unavailable", async () => {
  let value = unavailable;
  const view = await harness({ getRunnerExecutionCapability: async () => value });
  try {
    assert.equal(view.state().connection, "connected");
    assert.equal(view.state().compute, "unavailable");
    value = { runnerId: "local", connected: false, reason: "Runner connection refused" };
    await act(async () => view.state().recheck());
    assert.equal(view.state().connection, "connected");
    assert.equal(view.state().compute, "unavailable");
  } finally { await view.close(); }
});

test("repair requests a fresh probe and replaces the unavailable notice with ready status", async () => {
  const calls: Array<[string, boolean | undefined]> = [];
  const view = await harness({ getRunnerExecutionCapability: async (id, refresh) => { calls.push([id, refresh]); return refresh ? ready : unavailable; } });
  try {
    assert.equal(view.state().compute, "unavailable");
    await act(async () => view.state().recheck());
    assert.deepEqual(calls, [["local", false], ["local", true]]);
    assert.equal(view.state().compute, "ready");
    assert.equal(renderToStaticMarkup(createElement(ComputeNotice, { readiness: view.state() })), "");
  } finally { await view.close(); }
});

test("a failed API read clears a previous ready status and distinguishes rejected credentials", async () => {
  let failure: unknown;
  const view = await harness({ getRunnerExecutionCapability: async () => { if (failure) throw failure; return ready; } });
  try {
    assert.equal(view.state().compute, "ready");
    failure = new Error("API offline");
    await act(async () => view.state().recheck());
    assert.equal(view.state().connection, "unavailable");
    assert.equal(view.state().compute, "unknown");
    failure = new ApiRequestError("Invalid access token", 401);
    await act(async () => view.state().recheck());
    assert.equal(view.state().connection, "unauthorized");
    assert.equal(view.state().compute, "unknown");
    assert.equal(renderToStaticMarkup(createElement(ComputeNotice, { readiness: view.state() })), "", "Connection settings alone report rejected credentials");
  } finally { await view.close(); }
});

test("an older Runner without capability data cannot produce a ready badge", async () => {
  const view = await harness({ getRunnerExecutionCapability: async () => ({ runnerId: "local", connected: true }) });
  try {
    assert.equal(view.state().connection, "connected");
    assert.equal(view.state().compute, "unknown");
    const html = renderToStaticMarkup(createElement(ComputeNotice, { readiness: view.state() }));
    assert.match(html, /did not report sandbox readiness/);
  } finally { await view.close(); }
});

test("late results from previous credentials cannot overwrite the current failure", async () => {
  let resolve!: (probe: Probe) => void;
  const view = await harness({ getRunnerExecutionCapability: () => new Promise(done => { resolve = done; }) });
  try {
    assert.equal(view.state().connection, "checking");
    assert.equal(view.state().compute, "unknown");
    await view.update({ getRunnerExecutionCapability: async () => unavailable });
    await act(async () => resolve(ready));
    assert.equal(view.state().compute, "unavailable");
    assert.equal(view.state().value?.capability?.detail, unavailable.capability!.detail);
  } finally { await view.close(); }
});

test("background polling detects a Runner outage and later recovery", async (t) => {
  let poll!: () => void;
  t.mock.method(globalThis, "setTimeout", (callback: () => void) => { poll = callback; return 1; });
  t.mock.method(globalThis, "clearTimeout", () => {});
  let value = ready;
  const view = await harness({ getRunnerExecutionCapability: async () => value });
  try {
    value = { runnerId: "local", connected: false, reason: "Runner stopped" };
    await act(async () => poll());
    assert.equal(view.state().compute, "unavailable");
    value = ready;
    await act(async () => poll());
    assert.equal(view.state().compute, "ready");
  } finally { await view.close(); }
});

test("the notice exposes the actual reason safely and labels both signals in English and Chinese", async () => {
  const view = await harness({ getRunnerExecutionCapability: async () => ({ ...unavailable, capability: { ...unavailable.capability!, detail: "bwrap: <host> denied" } }) });
  try {
    for (const locale of ["en", "zh-CN"] as const) {
      const html = renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: locale, children: [
        createElement(ComputeStatus, { key: "status", readiness: view.state() }), createElement(ComputeNotice, { key: "notice", readiness: view.state() }),
      ] }));
      assert.match(html, /class="compute-notice" role="status"/);
      assert.doesNotMatch(html, /role="alert"/);
      assert.match(html, /bwrap: &lt;host&gt; denied/);
      assert.match(html, locale === "en" ? /API · Connected/ : /API · 已连接/);
      assert.match(html, locale === "en" ? /Local sandbox · Unavailable/ : /本地沙箱 · 不可用/);
      assert.match(html, locale === "en" ? /The local sandbox is unavailable/ : /本地沙箱不可用/);
      assert.match(html, locale === "en" ? /without sandbox isolation/ : /没有沙箱隔离/);
      assert.match(html, locale === "en" ? /scientific environments, model availability and remote Runners/ : /科学环境、模型可用性和远程 Runner/);
    }
  } finally { await view.close(); }
});

test("an unreachable Runner is not offered the direct execution path", async () => {
  const view = await harness({ getRunnerExecutionCapability: async () => ({ runnerId: "local", connected: false, reason: "Runner connection refused" }) });
  try {
    for (const locale of ["en", "zh-CN"] as const) {
      const html = renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: locale, children: createElement(ComputeNotice, { readiness: view.state() }) }));
      assert.match(html, /Runner connection refused/);
      assert.match(html, locale === "en" ? /The local Runner cannot be reached/ : /无法连接本地 Runner/);
      assert.doesNotMatch(html, locale === "en" ? /sandbox isolation/ : /沙箱隔离/);
    }
  } finally { await view.close(); }
});

test("sandbox and API failures do not claim the runtime error chip; gateway errors retain their detail", async () => {
  let fail = false;
  const view = await harness({ getRunnerExecutionCapability: async () => { if (fail) throw new Error("API unavailable"); return unavailable; } });
  try {
    let html = renderToStaticMarkup(createElement(ComputeStatus, { readiness: view.state() }));
    assert.match(html, /class="compute bad"/);
    assert.doesNotMatch(html, /class="connection bad"/);
    fail = true;
    await act(async () => view.state().recheck());
    html = renderToStaticMarkup(createElement(ComputeStatus, { readiness: view.state() }));
    assert.match(html, /class="api-connection bad"/);
    assert.doesNotMatch(html, /class="connection bad"/);
    const error = "503: No available channel for model inline-cards-regression";
    html = renderToStaticMarkup(createElement(ComputeStatus, { readiness: view.state(), error }));
    assert.match(html, /class="connection bad" title="Needs attention: 503: No available channel for model inline-cards-regression"/);
    assert.match(html, /Needs attention<\/span>/);
  } finally { await view.close(); }
});

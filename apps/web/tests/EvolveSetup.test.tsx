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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { EvolveSetup, useEvolveStatus } from "../src/evolve/EvolveSetup.js";
import { EvolveApiClient, type EvolveStatus } from "../src/api/evolve.js";
import { LocaleProvider } from "../src/i18n/LocaleProvider.js";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("bilingual setup explains initialization and keeps unavailable/initializing actions disabled", () => {
  const client = new EvolveApiClient("fixture");
  for (const locale of ["en", "zh-CN"] as const) {
    for (const state of ["not_initialized", "installing", "error", "ready"] as const) {
      const html = renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: locale,
        children: createElement(EvolveSetup, { client, status: { state, canInitialize: true }, onStatus: () => {} }) }));
      assert.match(html, /role="status"/);
      if (state === "installing") assert.match(html, /disabled=""/);
      if (state === "ready") assert.doesNotMatch(html, /<button/);
      if (state === "not_initialized") { assert.match(html, /1 GiB/); assert.match(html, locale === "en" ? /Not initialized/ : /尚未初始化/); }
    }
  }
  const html = renderToStaticMarkup(createElement(EvolveSetup, { client, status: { state: "not_initialized", canInitialize: false }, onStatus: () => {} }));
  assert.match(html, /disabled=""/); assert.match(html, /operator/);
});
test("Init is explicit, reports progress, adopts readiness and allows retry after failure", async () => {
  const client = new EvolveApiClient("fixture");
  let calls = 0; let complete: ((value: EvolveStatus) => void) | undefined;
  client.initEvolve = () => { calls++; return new Promise(resolve => { complete = resolve; }); };
  const updates: EvolveStatus[] = []; let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(EvolveSetup, { client, status: { state: "not_initialized", canInitialize: true }, onStatus: value => updates.push(value) })); });
  try {
    assert.equal(calls, 0);
    await act(async () => renderer!.root.findByType("button").props.onClick());
    assert.equal(calls, 1); assert.equal(renderer!.root.findByType("button").props.disabled, true);
    await act(async () => complete!({ state: "ready", canInitialize: true }));
    assert.deepEqual(updates, [{ state: "ready", canInitialize: true }]);
    client.initEvolve = async () => { throw new Error("synthetic internal failure"); };
    await act(async () => renderer!.root.findByType("button").props.onClick());
    assert.deepEqual(updates[1], { state: "error", canInitialize: true });
    assert.equal(renderer!.root.findByType("button").props.disabled, false);
    assert(!JSON.stringify(renderer!.toJSON()).includes("synthetic internal"));
  } finally { await act(async () => renderer!.unmount()); }
});
test("status hook polls without initialization and tears down before adopting stale results", async () => {
  const client = new EvolveApiClient("fixture");
  let latest: EvolveStatus | undefined; let calls = 0;
  client.getEvolveStatus = async () => { calls++; return { state: "ready", canInitialize: true }; };
  client.initEvolve = async () => { throw new Error("must not initialize implicitly"); };
  function Status() { latest = useEvolveStatus(client).status; return null; }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(Status)); });
  try { assert.equal(calls, 1); assert.equal(latest!.state, "ready"); }
  finally { await act(async () => renderer!.unmount()); }
});
test("API client exposes authenticated status and explicit POST init", async () => {
  const original = globalThis.fetch; const seen: string[] = [];
  globalThis.fetch = async (url, init) => { seen.push(`${init?.method ?? "GET"} ${url}`); assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture"); return Response.json({ state: "not_initialized", canInitialize: true }); };
  try { const client = new EvolveApiClient("fixture"); await client.getEvolveStatus(); await client.initEvolve();
    assert.deepEqual(seen, ["GET /api/evolve/status", "POST /api/evolve/init"]);
  } finally { globalThis.fetch = original; }
});
test("a late status poll cannot overwrite an explicit Init result", async () => {
  const client = new EvolveApiClient('fixture'); let finish: (status: EvolveStatus) => void;
  client.getEvolveStatus = () => new Promise(done => { finish = done; });
  let hook: ReturnType<typeof useEvolveStatus>; let renderer: ReactTestRenderer;
  function Status() { hook = useEvolveStatus(client); return null; }
  await act(async () => { renderer = create(createElement(Status)); });
  try {
    await act(async () => hook!.setStatus({ state: 'ready', canInitialize: true }));
    await act(async () => finish!({ state: 'not_initialized', canInitialize: true }));
    assert.equal(hook!.status.state, 'ready');
  } finally { await act(async () => renderer!.unmount()); }
});
test("status failures are fail-closed but a stale failure after Init or unmount cannot overwrite status", async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const client = new EvolveApiClient('fixture'); const failures: ((error: Error) => void)[] = [];
  client.getEvolveStatus = () => new Promise((_done, fail) => failures.push(fail));
  let hook: ReturnType<typeof useEvolveStatus>; let renderer: ReactTestRenderer;
  function Status() { hook = useEvolveStatus(client); return null; }
  await act(async () => { renderer = create(createElement(Status)); });
  try {
    await act(async () => hook!.setStatus({ state: 'ready', canInitialize: true }));
    await act(async () => failures[0]!(new Error('late fixture failure')));
    assert.equal(hook!.status.state, 'ready');
    await act(async () => t.mock.timers.tick(5_000));
    await act(async () => failures[1]!(new Error('current fixture failure')));
    assert.deepEqual(hook!.status, { state: 'error', canInitialize: false });
    await act(async () => t.mock.timers.tick(5_000));
    await act(async () => renderer!.unmount());
    await act(async () => failures[2]!(new Error('unmounted fixture failure')));
    assert.deepEqual(hook!.status, { state: 'error', canInitialize: false });
  } finally { await act(async () => renderer!.unmount()); }
});

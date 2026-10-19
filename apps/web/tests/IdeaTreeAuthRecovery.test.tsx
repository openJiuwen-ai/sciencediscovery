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
import { createElement, Fragment, useEffect, useMemo, useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ApiClient } from "../src/api.js";
import { createAuthTokenPromptGate } from "../src/auth-token-prompt.js";
import { watchLocalAccessToken } from "../src/local-access-token.js";
import { IdeaTreeView } from "../src/IdeaTreeView.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("mounted fragment credential rejection has one recovery prompt, while research service failures remain visible", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousFetch = globalThis.fetch;
  const location = { href: "http://localhost/" };
  const browser = Object.assign(new EventTarget(), { location,
    localStorage: { getItem: () => "valid", setItem() {} },
    history: { state: null, replaceState(_state: unknown, _title: string, path: string) { location.href = new URL(path, location.href).href; } },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  const pending: Array<() => void> = [];
  const report = () => {};
  globalThis.fetch = (async (input, init) => {
    const token = new Headers(init?.headers).get("authorization");
    if (token?.startsWith("Bearer invalid")) return new Promise<Response>(resolve => pending.push(() => resolve(Response.json({ error: "Unauthorized" }, { status: 401 }))));
    if (token === "Bearer offline") throw "transport disconnected";
    if (token === "Bearer unavailable") return Response.json({ error: "Research service unavailable" }, { status: 503 });
    return Response.json(String(input).includes("research") ? { items: [] } : { graph: null, hasIdeaTreeRun: false, treeIds: [] });
  }) as typeof fetch;
  function Mounted() {
    const [token, setToken] = useState("valid");
    const [rejected, setRejected] = useState(false);
    const gate = useRef(createAuthTokenPromptGate());
    useEffect(() => watchLocalAccessToken(browser, token => { setRejected(false); setToken(token); }), []);
    const client = useMemo(() => new ApiClient(token, () => { if (gate.current.shouldPrompt(token)) setRejected(true); }), [token]);
    return createElement(Fragment, null, rejected && createElement("p", { role: "alert" }, "Local token rejected: recover connection"), createElement(IdeaTreeView, { client, sessionId: "session", refreshKey: "stable", onError: report }));
  }
  let renderer: ReactTestRenderer | undefined;
  const navigate = async (token: string) => {
    await act(async () => { location.href = `http://localhost/#token=${token}`; browser.dispatchEvent(new Event("hashchange")); });
  };
  try {
    await act(async () => { renderer = create(createElement(Mounted)); });
    assert.equal(renderer!.root.findAllByProps({ role: "alert" }).length, 0);
    await navigate("invalid");
    assert.equal(pending.length, 2, "both mounted research loaders issue requests with the replacement token");
    await act(async () => { pending.splice(0).forEach(resolve => resolve()); });
    const alerts = renderer!.root.findAllByProps({ role: "alert" });
    console.log("concurrent rejection alerts:", alerts.map(a => a.children.filter(c => typeof c === "string").join(" ")));
    assert.equal(alerts.length, 1, "authentication feedback belongs only to connection recovery");
    await navigate("valid");
    assert.equal(renderer!.root.findAllByProps({ role: "alert" }).length, 0);
    await navigate("unavailable");
    const failures = renderer!.root.findAllByProps({ role: "alert" });
    assert.equal(failures.length, 2, "non-authentication failures retain both retry actions");
    for (const failure of failures) assert.match(failure.children.join(" "), /Research service unavailable/);
    await navigate("invalid-after-service-error");
    assert.equal(pending.length, 2);
    await act(async () => { pending.splice(0).forEach(resolve => resolve()); });
    assert.equal(renderer!.root.findAllByProps({ role: "alert" }).length, 1, "a new auth failure clears stale loader errors");
    await navigate("valid");
    await navigate("offline");
    assert.equal(renderer!.root.findAllByProps({ role: "alert" }).length, 2, "untyped transport failures are not mistaken for token rejection");
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

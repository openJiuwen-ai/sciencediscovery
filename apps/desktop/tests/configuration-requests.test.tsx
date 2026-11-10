// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import React, { useState } from "react";
import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";
import type { DesktopConfigurationRequest } from "../src/api/configuration.js";
import type { ApiClient } from "../src/api/client.js";
import type { ConfigurationRequestView, ConnectorConfigurationRequest } from "@sciencediscovery/schema";
import { useConfigurationRequests } from "../src/app/use-configuration-requests.js";
const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function request(over: Partial<ConfigurationRequestView> = {}): ConfigurationRequestView {
  return { id: "request", sessionId: "a", capabilityId: "model.connect", revision: 1, stateVersion: 1,
    state: "awaiting_confirmation", activation: { state: "active" }, resumption: { state: "not_required" },
    ...over } as ConfigurationRequestView;
}
function legacy(overrides: Partial<ConnectorConfigurationRequest> = {}): ConnectorConfigurationRequest {
  return { id: "legacy", sessionId: "a", projectId: "p", runId: "user-request:old", connectorId: "pubmed", connectorName: "PubMed", reason: "USER_REQUESTED_CONNECTOR",
    baselineConnectorIds: [], state: "awaiting_confirmation", createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z", ...overrides };
}
function pendingClient() {
  const calls: { signal?: AbortSignal | null; resolve: (value: { items: unknown[] }) => void; reject: (reason: Error) => void }[] = [];
  const client = { request: (_path: string, init: RequestInit) => new Promise((resolve, reject) => {
    calls.push({ signal: init.signal, resolve, reject });
  }) } as unknown as ApiClient;
  return { client, calls };
}
async function mount(client: ApiClient, active = false) {
  let result!: ReturnType<typeof useConfigurationRequests>;
  let navigate!: (id: string) => void;
  let trigger!: (key: string) => void;
  const changes: DesktopConfigurationRequest[] = [];
  function Probe() {
    const [id, setId] = useState("a"); navigate = setId;
    const [refreshKey, setRefreshKey] = useState(""); trigger = setRefreshKey;
    result = useConfigurationRequests({ client, sessionId: id, active, refreshKey, onChange: value => changes.push(value) });
    return null;
  }
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<Probe />); });
  return { get result() { return result; }, navigate: (id: string) => navigate(id), trigger: (key: string) => trigger(key), changes,
    close: () => act(async () => tree.unmount()) };
}
describe("desktop configuration request lifecycle", () => {
  it("aborts and ignores late reads and mutations across A → B → A navigation", async () => {
    const { client, calls } = pendingClient(); const view = await mount(client);
    const oldUpdate = view.result.update;
    const oldRemove = view.result.remove;
    await act(async () => view.navigate("b"));
    assert.equal(calls[0]!.signal!.aborted, true);
    await act(async () => view.navigate("a"));
    await act(async () => calls[2]!.resolve({ items: [request({ stateVersion: 3 })] }));
    await act(async () => { calls[0]!.resolve({ items: [request({ stateVersion: 8 })] }); oldUpdate(request({ stateVersion: 9 })); oldRemove("request"); });
    assert.equal(view.result.requests[0]!.stateVersion, 3);
    assert.equal(view.changes.length, 1);
    await view.close();
  });
  it("merges monotonically, keeps equal object identity and filters malformed/foreign records", async () => {
    const { client, calls } = pendingClient(); const view = await mount(client);
    await act(async () => calls[0]!.resolve({ items: [request(), { id: "legacy" }, request({ id: "foreign", sessionId: "b" })] }));
    const original = view.result.requests[0];
    await act(async () => view.result.update(request()));
    assert.equal(view.result.requests[0], original);
    await act(async () => view.result.update(request({ revision: 2, stateVersion: 4 })));
    await act(async () => view.result.update(request({ revision: 1, stateVersion: 20 })));
    await act(async () => view.result.update(request({ revision: 2, stateVersion: 3 })));
    assert.equal(view.result.requests.length, 1);
    assert.equal(view.result.requests[0]!.stateVersion, 4);
    assert.equal(view.changes.length, 2);
    await view.close();
  });
  it("keeps cards and safe error state on failure, then clears the error on retry", async () => {
    const { client, calls } = pendingClient(); const view = await mount(client);
    await act(async () => calls[0]!.resolve({ items: [request()] }));
    let retry!: Promise<void>;
    await act(async () => { retry = view.result.refresh(); });
    await act(async () => { calls[1]!.reject(new Error("private backend details")); await retry; });
    assert.equal(view.result.error, true); assert.equal(view.result.requests.length, 1);
    await act(async () => { retry = view.result.refresh(); });
    await act(async () => { calls[2]!.resolve({ items: [request({ stateVersion: 2 })] }); await retry; });
    assert.equal(view.result.error, false); assert.equal(view.result.loading, false);
    await view.close();
  });
  it("shows initial read failure and retries when the transcript refresh key changes", async () => {
    const { client, calls } = pendingClient(); const view = await mount(client);
    assert.equal(view.result.loading, true);
    await act(async () => calls[0]!.reject(new Error("private failure")));
    assert.equal(view.result.error, true); assert.equal(view.result.loading, false);
    assert.deepEqual(view.result.requests, []);
    await act(async () => view.trigger("new-run-event"));
    assert.equal(calls.length, 2);
    await act(async () => calls[1]!.resolve({ items: [request()] }));
    assert.equal(view.result.error, false); assert.equal(view.result.requests.length, 1);
    await view.close();
  });
  it("ignores a superseded same-session read", async () => {
    const { client, calls } = pendingClient(); const view = await mount(client);
    let retry!: Promise<void>;
    await act(async () => { retry = view.result.refresh(); });
    await act(async () => { calls[1]!.resolve({ items: [request({ stateVersion: 2 })] }); await retry; });
    await act(async () => calls[0]!.resolve({ items: [request({ stateVersion: 9 })] }));
    assert.equal(view.result.requests[0]!.stateVersion, 2);
    await view.close();
  });
  it("keeps legacy records monotonic and lets generic records supersede same-ID companions", async () => {
    const { client, calls } = pendingClient(); const view = await mount(client);
    await act(async () => calls[0]!.resolve({ items: [legacy(), legacy({ id: "foreign", sessionId: "b" })] }));
    assert.equal(view.result.legacyRequests.length, 1);
    const original = view.result.legacyRequests[0];
    await act(async () => view.result.update(legacy()));
    assert.equal(view.result.legacyRequests[0], original);
    await act(async () => view.result.update(legacy({ state: "applied" })));
    await act(async () => view.result.update(legacy({ updatedAt: "2026-11-09T00:00:01Z" })));
    assert.equal(view.result.legacyRequests[0]!.state, "applied");
    await act(async () => view.result.update(request({ id: "legacy" })));
    await act(async () => view.result.update(legacy()));
    assert.equal(view.result.legacyRequests.length, 0); assert.equal(view.result.requests.length, 1);
    await view.close();
  });
  it("rejects late legacy decisions after navigation and preserves records on read failure", async () => {
    const { client, calls } = pendingClient(); const view = await mount(client);
    await act(async () => calls[0]!.resolve({ items: [legacy()] }));
    const oldUpdate = view.result.update;
    let read!: Promise<void>;
    await act(async () => { read = view.result.refresh(); });
    await act(async () => { calls[1]!.reject(new Error("network")); await read; });
    assert.equal(view.result.error, true); assert.equal(view.result.legacyRequests.length, 1);
    await act(async () => view.navigate("b"));
    await act(async () => oldUpdate(legacy({ state: "applied" })));
    assert.equal(view.result.legacyRequests.length, 0);
    await view.close();
  });
  it("polls active runs and unsettled receipts every two seconds, then stops when settled", async () => {
    const original = globalThis.setInterval; const originalClear = globalThis.clearInterval;
    const ticks = new Map<number, () => void>(); let next = 0;
    globalThis.setInterval = ((callback: () => void, ms: number) => { assert.equal(ms, 2_000); ticks.set(++next, callback); return next; }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((id: number) => { ticks.delete(id); }) as unknown as typeof clearInterval;
    try {
      const { client, calls } = pendingClient(); const view = await mount(client);
      assert.equal(ticks.size, 0);
      await act(async () => calls[0]!.resolve({ items: [request({ state: "applied", resumption: { state: "started" } as ConfigurationRequestView["resumption"] })] }));
      assert.equal(ticks.size, 1);
      await act(async () => [...ticks.values()][0]!());
      assert.equal(calls.length, 2);
      await act(async () => calls[1]!.resolve({ items: [request({ state: "applied", stateVersion: 2 })] }));
      assert.equal(ticks.size, 0);
      await act(async () => view.result.update(legacy()));
      assert.equal(ticks.size, 1, "legacy pending records keep polling without a generic card");
      await act(async () => view.result.update(legacy({ state: "dismissed" })));
      assert.equal(ticks.size, 0, "terminal legacy records stop polling");
      await view.close();
      const running = pendingClient(); const activeView = await mount(running.client, true);
      assert.equal(ticks.size, 1);
      await activeView.close(); assert.equal(ticks.size, 0);
    } finally { globalThis.setInterval = original; globalThis.clearInterval = originalClear; }
  });
});

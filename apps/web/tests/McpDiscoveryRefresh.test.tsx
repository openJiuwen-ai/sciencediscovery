// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { CustomMcpServerDetails } from "@sciencediscovery/schema";
import { useMcpDiscoveryRefresh } from "@sciencediscovery/configuration-ui";
import { McpServerSettings } from "../src/McpServerSettings.js";
import { LocaleProvider } from "../src/i18n/index.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const server: CustomMcpServerDetails = {
  args: [], command: "", cwd: "", description: "Local tools", enabled: true, env: {}, headers: {},
  id: "custom-local", name: "Local tools", sourceId: "custom-local", status: "untested",
  timeoutSeconds: 60, tools: [], transport: "http", url: "http://localhost/mcp",
};

/** 挂载共享轮询，保留调用者控制的状态和客户端身份。 */
function Poller(props: { client: object; status?: CustomMcpServerDetails["status"]; refresh: (current: () => boolean) => Promise<void> }) {
  useMcpDiscoveryRefresh(props.client, [{ ...server, status: props.status ?? "untested", enabled: props.status !== "disabled" }], props.refresh);
  return null;
}

test("discovery polling is serial and drops results after client changes or unmount", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const checks: Array<() => boolean> = [];
  let release!: () => void;
  const refresh = async (current: () => boolean) => { checks.push(current); await new Promise<void>((resolve) => { release = resolve; }); };
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(Poller, { client: {}, refresh })); });
  try {
    await act(async () => context.mock.timers.tick(1_000));
    assert.equal(checks.length, 1);
    await act(async () => context.mock.timers.tick(30_000));
    assert.equal(checks.length, 1, "a slow request cannot start another poll");
    await act(async () => view.update(createElement(Poller, { client: {}, refresh })));
    assert.equal(checks[0]!(), false);
    await act(async () => { release(); context.mock.timers.tick(1_000); });
    assert.equal(checks.length, 2);
    await act(async () => view.unmount());
    assert.equal(checks[1]!(), false);
    await act(async () => { release(); context.mock.timers.tick(5_000); });
    assert.equal(checks.length, 2);
  } finally { await act(async () => view.unmount()); }
});

for (const status of ["ready", "error", "disabled"] as const) {
  test(`discovery polling stops at ${status}`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const client = {};
    let calls = 0;
    const refresh = async () => { calls += 1; };
    let view!: ReactTestRenderer;
    await act(async () => { view = create(createElement(Poller, { client, refresh })); });
    try {
      await act(async () => context.mock.timers.tick(1_000));
      await act(async () => view.update(createElement(Poller, { client, refresh, status })));
      await act(async () => context.mock.timers.tick(5_000));
      assert.equal(calls, 1);
    } finally { await act(async () => view.unmount()); }
  });
}

test("discovery polling expires after 120 seconds and rejects an in-flight answer", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let current!: () => boolean;
  let release!: () => void;
  let calls = 0;
  const refresh = async (isCurrent: () => boolean) => {
    calls += 1; current = isCurrent;
    await new Promise<void>((resolve) => { release = resolve; });
  };
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(Poller, { client: {}, refresh })); });
  try {
    await act(async () => context.mock.timers.tick(1_000));
    assert.equal(current(), true);
    await act(async () => context.mock.timers.tick(119_000));
    assert.equal(current(), false);
    await act(async () => { release(); context.mock.timers.tick(5_000); });
    assert.equal(calls, 1);
  } finally { await act(async () => view.unmount()); }
});

test("Web discovery updates tools without closing expanded rows or replacing an edit draft", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const client = { listMcpServers: async () => {
    calls += 1;
    return [{ ...server, status: calls === 1 ? "untested" : "ready", tools: calls === 1 ? [] : [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] }];
  } } as unknown as Parameters<typeof McpServerSettings>[0]["client"];
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(LocaleProvider, null,
    createElement(McpServerSettings, { client, sources: [], onChanged: async () => {} }))); });
  try {
    const toggle = () => view.root.findAllByType("button").find((node) => node.props["aria-expanded"] !== undefined)!;
    await act(async () => toggle().props.onClick());
    await act(async () => view.root.findAllByType("button").find((node) => String(node.props["aria-label"]).includes("Local tools") && node.props.className === "icon-button")!.props.onClick());
    const name = () => view.root.findAllByType("input").find((node) => node.props.maxLength === 100)!;
    await act(async () => name().props.onChange({ target: { value: "Unsaved draft" } }));
    await act(async () => context.mock.timers.tick(1_000));
    assert.equal(name().props.value, "Unsaved draft");
    await act(async () => view.root.findAllByType("button").find((node) => node.props.className === "icon-button")!.props.onClick());
    assert.equal(toggle().props["aria-expanded"], true);
    assert.match(JSON.stringify(view.toJSON()), /echo/);
    await act(async () => context.mock.timers.tick(3_000));
    assert.equal(calls, 2, "terminal discovery stops polling");
  } finally { await act(async () => view.unmount()); }
});

test("Web save releases controls while background discovery remains pending", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const client = {
    listMcpServers: async () => { reads += 1; return [{ ...server }]; },
    saveMcpServer: async () => server,
  } as unknown as Parameters<typeof McpServerSettings>[0]["client"];
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(LocaleProvider, null,
    createElement(McpServerSettings, { client, sources: [], onChanged: async () => {} }))); });
  try {
    await act(async () => view.root.findAllByType("button").find((node) => node.props.className === "icon-button" && String(node.props["aria-label"]).includes("Local tools"))!.props.onClick());
    await act(async () => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    assert.equal(view.root.findAllByType("form").length, 0);
    assert.equal(view.root.findByProps({ role: "switch" }).props.disabled, false);
    assert.equal(reads, 2);
    await act(async () => context.mock.timers.tick(1_000));
    assert.equal(reads, 3, "pending discovery continues after save has returned");
  } finally { await act(async () => view.unmount()); }
});

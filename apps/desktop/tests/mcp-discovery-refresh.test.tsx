// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import React from "react";
import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import type { ApiClient } from "../src/api/client.js";
import type { CustomMcpServerDetails } from "../src/api/types.js";
import { McpServers } from "../src/views/settings/system/McpServers.js";
import { TEXT } from "../src/text.js";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { addEventListener() {}, removeEventListener() {} } });

test("desktop discovers tools while preserving the open editor and its unsaved draft", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const server: CustomMcpServerDetails = {
    args: [], command: "", cwd: "", description: "Local tools", enabled: true, env: {}, headers: {},
    id: "custom-local", name: "Local tools", sourceId: "custom-local", status: "untested",
    timeoutSeconds: 60, tools: [], transport: "http", url: "http://localhost/mcp",
  };
  const client = { request: async (path: string) => {
    if (path === "/api/mcp/servers") { reads += 1; return [{ ...server, status: reads === 1 ? "untested" : "ready", tools: reads === 1 ? [] : [{ name: "echo" }] }]; }
    if (path === "/api/mcp/sources") return [];
    if (path === "/api/settings") return { effective: { enabledConnectorIds: [] }, overrides: {}, sources: {} };
    throw new Error(`Unexpected request: ${path}`);
  } } as unknown as ApiClient;
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<McpServers client={client} onConfirm={() => {}} onToast={() => {}} />); });
  try {
    await act(async () => view.root.findAllByType("button").find((node) => node.props["aria-label"] === TEXT.settings.system.mcp.more("Local tools"))!.props.onClick());
    await act(async () => view.root.findAllByType("button").find((node) => node.children.includes(TEXT.settings.edit))!.props.onClick());
    const name = () => view.root.findAllByType("input").find((node) => node.props.value === "Local tools" || node.props.value === "Unsaved draft")!;
    await act(async () => name().props.onChange({ target: { value: "Unsaved draft" } }));
    await act(async () => context.mock.timers.tick(1_000));
    assert.equal(name().props.value, "Unsaved draft");
    assert.match(JSON.stringify(view.toJSON()), new RegExp(TEXT.settings.system.mcp.statusReady));
    assert.match(JSON.stringify(view.toJSON()), new RegExp(TEXT.settings.system.mcp.toolCount(1)));
    await act(async () => context.mock.timers.tick(3_000));
    assert.equal(reads, 2);
  } finally { await act(async () => view.unmount()); }
});

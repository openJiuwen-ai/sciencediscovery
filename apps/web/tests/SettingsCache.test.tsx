// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { CustomMcpServerDetails } from "@sciencediscovery/schema";
import { McpServerSettings } from "../src/McpServerSettings.js";
import { LocaleProvider } from "../src/i18n/index.js";
import { readSettingsCache, writeSettingsCache } from "../src/settings-cache.js";
import type { ApiClient } from "../src/api/client.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("a cached settings answer belongs to the client that produced it", () => {
  const first = {};
  const second = {};
  writeSettingsCache(first, "mcp-servers", [{ id: "one" }]);
  assert.deepEqual(readSettingsCache(first, "mcp-servers"), [{ id: "one" }]);
  assert.equal(readSettingsCache(second, "mcp-servers"), undefined, "a fresh connection never reads another one's list");
});

test("a reopened MCP settings pane paints the list instead of a spinner", async () => {
  const server: CustomMcpServerDetails = {
    args: [], description: "Local tool server", enabled: true, env: {}, headers: {},
    id: "custom-local", name: "Local tools", sourceId: "custom-local", status: "ready",
    timeoutSeconds: 60, tools: [], transport: "stdio", url: "",
  } as CustomMcpServerDetails;
  const client = { listMcpServers: async () => [server] } as unknown as ApiClient;
  const element = () => createElement(LocaleProvider, null,
    createElement(McpServerSettings, { client: client as never, onChanged: async () => undefined, sources: [] }));
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(element()); });
  try {
    assert.match(JSON.stringify(renderer.toJSON()), /Local tools/);
  } finally { await act(async () => renderer.unmount()); }

  // A reopening has the list on screen before the refresh has answered.
  const markup = renderToStaticMarkup(element());
  assert.match(markup, /Local tools/);
  assert.doesNotMatch(markup, /mcp-empty/);
});

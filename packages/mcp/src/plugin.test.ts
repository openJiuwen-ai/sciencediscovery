// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createPluginScope } from "@sciencediscovery/plugin-sdk";
import { mcpPlugin } from "./plugin.js";
test("MCP contribution preserves source identity, deferral and tool policy", async () => {
  const ports = { mcpTools: [{ name: "fixture_lookup", displayName: "Lookup", description: "lookup", sourceId: "fixture", toolId: "lookup",
    inputSchema: { type: "object" }, routing: { keywords: ["lookup"], mode: "prefer" as const, priority: 1 },
    execute: async () => ({ answer: 42 }) }] };
  const scope = await createPluginScope([mcpPlugin(ports)]);
  const tool = scope.contributions[0]!.tools[0]!;
  assert.equal(tool.deferred, true);
  assert.deepEqual(tool.mcp, { sourceId: "fixture", toolId: "lookup" });
  assert.equal((await tool.execute("id", {}, new AbortController().signal)).content[0]!.type, "text");
  await scope.dispose();
  assert.equal((await createPluginScope([mcpPlugin({ ...ports, toolPolicy: { disallowed: ["fixture_lookup"] } })])).contributions[0]!.tools.length, 0);
  assert.equal((await createPluginScope([mcpPlugin(ports)], ["mcp"])).contributions.length, 0);
});

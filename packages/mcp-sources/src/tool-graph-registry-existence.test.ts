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
import { readFile } from "node:fs/promises";

import { fileURLToPath } from "node:url";

import { createBuiltinMcpSourceRegistry } from "./builtins.js";
import { TOOL_GRAPH_REGISTRY } from "@sciencediscovery/schema";

// Workspace 工具没有 MCP manifest，直接对照 workspace 包源码里的工具定义。
const WORKSPACE_TOOLS = ["run_shell", "run_npu_job", "web_search", "web_fetch"] as const;

test("every registry key resolves to a real workspace tool or MCP manifest tool", async () => {
  const mcpKeys = new Set<string>();
  for (const source of createBuiltinMcpSourceRegistry().list()) {
    for (const toolId of Object.keys(source.manifest.tools)) {
      mcpKeys.add(`mcp__${source.manifest.id}__${toolId}`);
    }
  }

  const workspaceSource = await readFile(
    fileURLToPath(new URL("../../workspace/src/workspace.ts", import.meta.url)),
    "utf8",
  );
  const workspaceKeys = new Set<string>();
  for (const tool of WORKSPACE_TOOLS) {
    assert.match(
      workspaceSource,
      new RegExp(`name: "${tool}"`),
      `missing workspace tool: ${tool}`,
    );
    workspaceKeys.add(tool);
  }

  const allReal = new Set([...workspaceKeys, ...mcpKeys]);
  for (const key of Object.keys(TOOL_GRAPH_REGISTRY)) {
    assert.ok(allReal.has(key), `registry key "${key}" is not in any real tool manifest`);
  }
});

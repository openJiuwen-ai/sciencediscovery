// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createElement, type ComponentProps } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { CustomMcpServerDetails, McpSourceDetails, McpSourceManifest, McpSourceStatus } from "@sciencediscovery/schema";
import { McpServerSettings } from "../src/McpServerSettings.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function source(id: string, displayName: string, status: McpSourceStatus["status"], connectionError?: string): McpSourceDetails {
  return {
    ...(connectionError ? { connectionError: { checkedAt: "2026-01-01T00:00:00Z", message: connectionError } } : {}),
    manifest: { description: displayName, displayName, id, tools: {}, transport: { mcpServerId: "server", type: "mcp" } } as unknown as McpSourceManifest,
    status: { availableTools: [], lastCheckedAt: "2026-01-01T00:00:00Z", missingTools: [], sourceId: id, status },
  };
}

const offServer: CustomMcpServerDetails = {
  id: "custom-000000000001", sourceId: "custom-000000000001", name: "Lab MCP", description: "",
  transport: "http", enabled: false, command: "", args: [], cwd: "", url: "http://127.0.0.1/mcp", timeoutSeconds: 60,
  env: {}, headers: {}, status: "disabled", tools: [],
};

const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");

test("the MCP page keeps off servers listed with their switch and shows each built-in source's state", async (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget() as Document;
  let renderer: ReactTestRenderer;
  t.after(async () => {
    await act(async () => renderer?.unmount());
    globalThis.document = previousDocument;
  });
  const client = { listMcpServers: async () => [offServer] } as unknown as ComponentProps<typeof McpServerSettings>["client"];
  await act(async () => {
    renderer = create(createElement(McpServerSettings, {
      client,
      onChanged: async () => undefined,
      sources: [
        source("arxiv", "arXiv", "disabled"),
        source("pubmed", "PubMed", "unavailable", "MCP connection timeout"),
        source("uniprot", "UniProt", "ready"),
        // A catalog that was never refreshed is neither off nor a failed connection.
        source("llm-wiki", "LLM Wiki", "unavailable"),
      ],
    }));
  });

  // The switch is the only way back from the UI, so the off server keeps it.
  const toggle = renderer!.root.findByProps({ "aria-label": "Enabled Lab MCP" });
  assert.equal(toggle.props.role, "switch");
  assert.equal(toggle.props.checked, false);

  await act(async () => renderer!.root.findAll((node) => node.type === "button" && node.props.role === "tab")[1]!.props.onClick());
  const rows = new Map(renderer!.root.findAllByProps({ className: "mcp-builtin" })
    .map((row) => [text(row.findByType("strong")), row]));
  assert.deepEqual([...rows.keys()], ["arXiv", "PubMed", "UniProt", "LLM Wiki"]);
  const state = (name: string) => rows.get(name)!.findAll((node) => typeof node.props.className === "string" && node.props.className.startsWith("mcp-status "))
    .map((node) => `${node.props.className}: ${text(node)}`);
  assert.deepEqual(state("arXiv"), ["mcp-status disabled: Disabled"]);
  assert.deepEqual(state("PubMed"), ["mcp-status error: Connection failed"]);
  assert.equal(text(rows.get("PubMed")!.findByProps({ className: "mcp-server-error" })), "MCP connection timeout");
  assert.deepEqual(state("UniProt"), []);
  assert.deepEqual(state("LLM Wiki"), []);
  assert.equal(rows.get("LLM Wiki")!.findAllByProps({ className: "mcp-server-error" }).length, 0);
});

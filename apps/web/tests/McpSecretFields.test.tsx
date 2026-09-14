// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createElement, type ComponentProps } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { CustomMcpServerDetails, CustomMcpServerInput } from "@sciencediscovery/schema";
import { McpServerSettings } from "../src/McpServerSettings.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function editor(t: TestContext, field: "env" | "headers") {
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget() as Document;
  let renderer: ReactTestRenderer;
  t.after(async () => {
    await act(async () => renderer?.unmount());
    globalThis.document = previousDocument;
  });
  const server: CustomMcpServerDetails = {
    id: "custom-000000000001", sourceId: "custom-000000000001", name: "Secret test",
    description: "", transport: field === "env" ? "stdio" : "http", enabled: false,
    command: "node", args: [], cwd: "", url: "http://127.0.0.1/mcp", timeoutSeconds: 60,
    env: {}, headers: {}, [field]: { ORIGINAL_KEY: null, OTHER_KEY: null }, status: "disabled", tools: [],
  };
  const saves: CustomMcpServerInput[] = [];
  const client = {
    listMcpServers: async () => [server],
    saveMcpServer: async (input: CustomMcpServerInput) => { saves.push(input); return server; },
  } as ComponentProps<typeof McpServerSettings>["client"];
  await act(async () => { renderer = create(createElement(McpServerSettings, { client, sources: [], onChanged: async () => undefined })); });
  await act(async () => renderer!.root.findByProps({ "aria-label": "Edit server Secret test" }).props.onClick());
  const label = field === "env" ? "Environment variables" : "Request headers";
  const input = (kind: "Key" | "Value", index = 1) => renderer!.root.findByProps({ "aria-label": `${label} ${kind} ${index}` });
  const change = async (kind: "Key" | "Value", value: string, index = 1) => {
    await act(async () => input(kind, index).props.onChange({ target: { value } }));
  };
  const submit = async () => { await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} })); };
  return { renderer: renderer!, saves, input, change, submit };
}

for (const field of ["env", "headers"] as const) {
  test(`${field}: renaming a retained secret requires a value and blocks submit`, async (t) => {
    const f = await editor(t, field);
    await f.change("Key", "RENAMED_KEY");
    assert.equal(f.input("Value").props.required, true);
    assert.equal(f.input("Value").props["aria-invalid"], true);
    assert.notEqual(f.input("Value").props.placeholder, "Saved value");
    assert.match(JSON.stringify(f.renderer.toJSON()), /Re-enter its secret value/);
    await f.submit();
    assert.equal(f.saves.length, 0);
    await f.change("Value", "synthetic-new-value");
    await f.change("Value", "");
    await f.submit();
    assert.equal(f.saves.length, 0);
    await f.change("Value", "synthetic-new-value");
    await f.submit();
    assert.deepEqual(f.saves[0]![field], { RENAMED_KEY: "synthetic-new-value", OTHER_KEY: null });
    assert.equal("originalKey" in f.saves[0]!, false);
  });

  test(`${field}: rename back or whitespace-only changes retain the original secret`, async (t) => {
    const f = await editor(t, field);
    await f.change("Key", "RENAMED_KEY");
    await f.change("Key", " ORIGINAL_KEY ");
    assert.equal(f.input("Value").props.required, false);
    assert.equal(f.input("Value").props.placeholder, "Saved value");
    await f.submit();
    assert.deepEqual(f.saves[0]![field], { ORIGINAL_KEY: null, OTHER_KEY: null });
  });

  test(`${field}: swapping existing keys cannot silently reuse another row's secret`, async (t) => {
    const f = await editor(t, field);
    await f.change("Key", "OTHER_KEY");
    await f.change("Key", "ORIGINAL_KEY", 2);
    await f.submit();
    assert.equal(f.saves.length, 0);
    assert.equal(f.input("Value", 2).props.required, true);
  });

  test(`${field}: explicit empty values without renaming remain supported`, async (t) => {
    const f = await editor(t, field);
    await f.change("Value", "");
    await f.submit();
    assert.deepEqual(f.saves[0]![field], { ORIGINAL_KEY: "", OTHER_KEY: null });
  });
}

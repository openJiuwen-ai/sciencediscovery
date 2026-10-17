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


import type { ConnectorManifest, RuntimeSettingsDetails } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ConnectorPicker as McpPicker, McpSettingsSection } from "@sciencediscovery/mcp/web";
import type { ApiClient } from "../src/api.js";
import { PluginWebHost } from "../src/plugins/host.js";

import { ConnectorPicker, connectorName } from "../src/composer/ConnectorPicker.js";

const connectors = [
  { id: "pubmed", publisher: "NCBI", termsUrl: "https://www.ncbi.nlm.nih.gov/home/about/policies/" } as ConnectorManifest,
  { id: "uniprot", publisher: "UniProt Consortium", termsUrl: "https://www.uniprot.org/help/license" } as ConnectorManifest,
];

test("scoped connector overrides filter every source and refresh through the host subscription", async (context) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setInterval, clearInterval } });
  context.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  let plugins: Record<string, { enabled: boolean }> = { "connector.pubmed": { enabled: false } };
  let notify: () => void = () => undefined;
  const client = {
    getPluginComposition: async () => ({ settings: { effective: { plugins } } }),
    subscribePlugins: async (_scope: unknown, listener: () => void) => { notify = listener; },
  } as unknown as ApiClient;
  let view: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(PluginWebHost, { client, projectId: "project", children:
      createElement(ConnectorPicker, { connectors, enabledIds: ["pubmed", "uniprot"], onToggle: () => undefined }) }));
  });
  try {
    const visibleIds = () => view.root.findByType(McpPicker).props.connectors.map((item: ConnectorManifest) => item.id);
    assert.deepEqual(visibleIds(), ["uniprot"]);
    assert.equal(view.root.findByType("button").props["aria-label"], "Data connectors: 1 of 1 enabled");
    plugins = { "connector.uniprot": { enabled: false } };
    await act(async () => notify());
    assert.deepEqual(visibleIds(), ["pubmed"]);
    plugins = {};
    await act(async () => notify());
    assert.deepEqual(visibleIds(), ["pubmed", "uniprot"]);
    plugins = { mcp: { enabled: false } };
    await act(async () => notify());
    assert.equal(view.root.findAllByType(McpPicker).length, 0);
  } finally { await act(async () => view.unmount()); }
});

test("maps connector ids to display names", () => {
  assert.equal(connectorName("pubmed"), "PubMed");
  assert.equal(connectorName("europe-pmc"), "Europe PMC");
});

test("shows the enabled count on the trigger with a hover summary", () => {
  const markup = renderToStaticMarkup(createElement(ConnectorPicker, {
    connectors,
    enabledIds: ["pubmed"],
    onToggle: () => undefined,
  }));
  assert.match(markup, /aria-label="Data connectors: 1 of 2 enabled"/);
  assert.match(markup, /title="Data connectors: 1 of 2 enabled"/);
  assert.match(markup, /connector-picker-trigger has-enabled/);
  assert.match(markup, /<span class="connector-picker-count">1<\/span>/);
  assert.doesNotMatch(markup, /connector-picker-popover/);
});

test("lists every connector with its checked state and policy link when open", () => {
  const markup = renderToStaticMarkup(createElement(ConnectorPicker, {
    connectors,
    defaultOpen: true,
    enabledIds: ["pubmed"],
    onToggle: () => undefined,
  }));
  assert.match(markup, /connector-picker-popover/);
  assert.match(markup, /<strong>PubMed<\/strong>/);
  assert.match(markup, /<strong>UniProt<\/strong>/);
  const checked = markup.match(/checked/g) ?? [];
  assert.equal(checked.length, 1);
  assert.match(markup, /href="https:\/\/www\.uniprot\.org\/help\/license"/);
  assert.match(markup, /aria-label="UniProt provider policy"/);
});

test("disables the checkboxes but keeps the list readable while a run is active", () => {
  const markup = renderToStaticMarkup(createElement(ConnectorPicker, {
    connectors,
    defaultOpen: true,
    disabled: true,
    enabledIds: [],
    onToggle: () => undefined,
  }));
  assert.match(markup, /connector-picker-popover/);
  const disabled = markup.match(/disabled/g) ?? [];
  assert.equal(disabled.length, 2);
});

const failedPubmed = {
  ...connectors[0],
  connectionError: { checkedAt: "2026-01-01T00:00:00Z", message: "MCP connection timeout" },
} as ConnectorManifest;

test("a connector whose MCP server failed to connect shows the failure and stays selectable", () => {
  const markup = renderToStaticMarkup(createElement(ConnectorPicker, {
    connectors: [failedPubmed, connectors[1]!],
    defaultOpen: true,
    enabledIds: ["pubmed"],
    onToggle: () => undefined,
  }));
  assert.match(markup, /<small class="connector-picker-error" title="MCP connection timeout">Connection failed: MCP connection timeout<\/small>/);
  assert.equal((markup.match(/connector-picker-error/g) ?? []).length, 1, "only the failed server's connector is flagged");
  assert.equal((markup.match(/type="checkbox"/g) ?? []).length, 2);
  assert.doesNotMatch(markup, /disabled=""/);
});

test("the closed trigger flags a failed connector only when the Session enables it", () => {
  const enabled = renderToStaticMarkup(createElement(ConnectorPicker, {
    connectors: [failedPubmed, connectors[1]!],
    enabledIds: ["pubmed", "uniprot"],
    onToggle: () => undefined,
  }));
  assert.match(enabled, /connector-picker-trigger has-enabled has-error/);
  assert.match(enabled, /aria-label="Data connectors: 2 of 2 enabled · 1 failed to connect"/);

  const notEnabled = renderToStaticMarkup(createElement(ConnectorPicker, {
    connectors: [failedPubmed, connectors[1]!],
    enabledIds: ["uniprot"],
    onToggle: () => undefined,
  }));
  assert.doesNotMatch(notEnabled, /has-error/);
  assert.match(notEnabled, /aria-label="Data connectors: 1 of 2 enabled"/);
});

test("connector settings show the failure next to the failed connector", () => {
  const markup = renderToStaticMarkup(createElement(McpSettingsSection, {
    allowInheritance: false,
    connectors: [failedPubmed, connectors[1]!],
    details: { effective: { enabledConnectorIds: [] } } as unknown as RuntimeSettingsDetails,
    disabled: false,
    draft: { enabledConnectorIds: ["pubmed"] },
    renderSource: () => null,
    setDraft: () => undefined,
    t: (key, variables) => key === "connectors.connectionFailed" ? `Connection failed: ${variables?.message}` : key,
  }));
  assert.match(markup, /<small class="connector-connection-error" title="MCP connection timeout">Connection failed: MCP connection timeout<\/small>/);
  assert.equal((markup.match(/connector-connection-error/g) ?? []).length, 1);
});

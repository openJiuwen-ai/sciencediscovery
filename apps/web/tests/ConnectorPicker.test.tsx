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


import type { ConnectorManifest, McpSourceStatus } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ConnectorPicker as McpPicker } from "@sciencediscovery/mcp/web";
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
      createElement(ConnectorPicker, { connectors, enabledIds: ["pubmed", "uniprot"], specialistIds: ["pubmed"], sourceStatuses: { pubmed: sourceStatus() }, onToggle: () => undefined }) }));
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
  const checked = markup.match(/checked=""/g) ?? [];
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

const sourceStatus = (overrides: Partial<McpSourceStatus> = {}): McpSourceStatus => ({
  availableTools: [], error: "biomed disconnected", lastCheckedAt: "now",
  missingTools: ["search", "download"], sourceId: "pubmed", status: "unavailable", ...overrides,
});

for (const state of ["unavailable", "degraded"] as const) {
  test(`selected ${state} connector explains catalog errors and omitted tools`, () => {
    const markup = renderToStaticMarkup(createElement(ConnectorPicker, {
      connectors, defaultOpen: true, enabledIds: ["pubmed"], onToggle: () => undefined,
      sourceStatuses: { pubmed: sourceStatus({ status: state, availableTools: state === "degraded" ? ["search"] : [], missingTools: ["download"] }) },
    }));
    assert.match(markup, state === "degraded" ? /Some MCP tools unavailable/ : /MCP unavailable/);
    assert.match(markup, /biomed disconnected/);
    assert.match(markup, /Omitted tools: download/);
    assert.equal((markup.match(/checked=""/g) ?? []).length, 1);
  });
}

for (const state of ["ready", "unselected", "web"] as const) {
  test(`${state} connector has no catalog warning`, () => {
    const markup = renderToStaticMarkup(createElement(ConnectorPicker, {
      connectors: state === "web" ? [{ id: "web", publisher: "Web" } as ConnectorManifest] : connectors,
      defaultOpen: true, enabledIds: state === "unselected" ? [] : [state === "web" ? "web" : "pubmed"],
      onToggle: () => undefined,
      sourceStatuses: { pubmed: state === "unselected" ? sourceStatus() : sourceStatus({ status: "ready", availableTools: ["search"], missingTools: [], error: undefined }) },
    }));
    assert.doesNotMatch(markup, /connector-picker-status/);
  });
}

test("Specialist sources are checked with readiness, explained and cannot be deselected independently", () => {
  const markup = renderToStaticMarkup(createElement(ConnectorPicker, {
    connectors, defaultOpen: true, enabledIds: [], specialistIds: ["pubmed"], onToggle: () => undefined,
    sourceStatuses: { pubmed: sourceStatus() },
  }));
  assert.match(markup, /Included by the selected Specialist/);
  assert.match(markup, /biomed disconnected/);
  assert.match(markup, /disabled=""[^>]*checked=""/);
  assert.match(markup, /1 of 2 enabled/);
});

test("missing discovery data is visible rather than implying ready", () => {
  const markup = renderToStaticMarkup(createElement(ConnectorPicker, {
    connectors, defaultOpen: true, enabledIds: ["pubmed"], onToggle: () => undefined,
  }));
  assert.match(markup, /MCP readiness not checked/);
  assert.doesNotMatch(markup, /No tools injected/);
});

test("catalog reload stays available during a run and refresh failures are visible", () => {
  const markup = renderToStaticMarkup(createElement(ConnectorPicker, {
    connectors, defaultOpen: true, disabled: true, enabledIds: ["pubmed"], onToggle: () => undefined,
    sourceStatuses: { pubmed: sourceStatus() }, onReload: () => undefined, refreshError: "catalog offline",
  }));
  assert.match(markup, /MCP unavailable/);
  assert.match(markup, /role="alert">Could not check MCP readiness: catalog offline/);
  assert.match(markup, /<button type="button">Reload MCP catalog<\/button>/);
});

test("ready source without discovered tools reports no tools without claiming server unavailability", () => {
  const markup = renderToStaticMarkup(createElement(ConnectorPicker, {
    connectors, defaultOpen: true, enabledIds: ["pubmed"], onToggle: () => undefined,
    sourceStatuses: { pubmed: sourceStatus({ status: "ready", availableTools: [], missingTools: [], error: undefined }) },
  }));
  assert.match(markup, /No MCP tools discovered/);
  assert.doesNotMatch(markup, /MCP unavailable|tool list unavailable until discovery succeeds/);
});

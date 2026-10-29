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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { ApiClient } from "../src/api.js";
import { ConnectorPicker } from "../src/composer/ConnectorPicker.js";
import { McpServerSettings } from "../src/McpServerSettings.js";
import type { RunStreamEvent, SessionRun } from "@sciencediscovery/schema";
import { App } from "../src/App.js";
import { LocaleProvider } from "../src/i18n/index.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installBrowserStubs(): { location: { pathname: string; search: string; hash: string } } {
  const location = { pathname: "/", search: "", hash: "" };
  const applyUrl = (url: string) => {
    const parsed = new URL(url, "http://localhost");
    location.pathname = parsed.pathname;
    location.search = parsed.search;
    location.hash = parsed.hash;
  };
  Object.assign(globalThis, {
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    },
    document: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      querySelector: () => null,
      documentElement: { style: {} },
    },
    window: {
      location,
      history: {
        replaceState: (_state: unknown, _title: string, url?: string | URL | null) => { if (url) applyUrl(String(url)); },
        pushState: (_state: unknown, _title: string, url?: string | URL | null) => { if (url) applyUrl(String(url)); },
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
  });
  return { location };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

async function waitForMounted(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Mounted App did not become ready: ${description}`);
    await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
  }
}

function startupBody(path: string): unknown {
  const url = path.split("?")[0] ?? path;
  if (url === "/api/projects") return [{ id: "project-1", name: "Alpha Project" }];
  if (url === "/api/providers") return { presets: [], providers: [] };
  if (url === "/api/quota-settings") return { uploadMaxFileBytes: 1, uploadMaxRequestBytes: 2, runnerMaxWorkspaceBytes: 3 };
  if (url === "/api/model-catalog") return {};
  if (url === "/api/mcp/proxy-policies") return { policies: {} };
  if (url === "/api/search") return { results: [], hasMore: false, total: 0 };
  if (/^\/api\/sessions\/[^/]+\/configuration-requests$/.test(url)) return { items: [] };
  if (url.endsWith("/settings")) return { overrides: {}, effective: {} };
  return [];
}

test("a hung memory settings read does not keep the project sidebar or the address bar waiting", async () => {
  const browser = installBrowserStubs();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.split("?")[0] === "/api/memory/settings") return new Promise<Response>(() => undefined);
    return jsonResponse(startupBody(path));
  }) as typeof fetch;

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(App, { initialToken: "test-token" })));
    });
    await waitForMounted(() => browser.location.pathname === "/projects/project-1", "project navigation despite the hung memory read");

    const projects = renderer!.root.findByProps({ id: "projects-panel-content" });
    assert.match(extractText(projects), /Alpha Project/);
    assert.equal(projects.findAllByProps({ className: "nav-skeleton" }).length, 0);
    assert.equal(browser.location.pathname, "/projects/project-1");
  } finally {
    await act(async () => { renderer?.unmount(); });
    globalThis.fetch = previousFetch;
  }
});

function extractText(node: { children?: unknown[] } | null | undefined): string {
  if (!node || !node.children) return "";
  return node.children.map((child) => typeof child === "string" ? child : extractText(child as { children?: unknown[] })).join("");
}

test("mounted Session composer refreshes effective MCP status on terminal events and settings changes", async (context) => {
  const browser = installBrowserStubs();
  browser.location.pathname = "/settings/mcp";
  const previousFetch = globalThis.fetch;
  const session = {id: "session-1", projectId: "project-1", title: "MCP Session", messages: [], enabledConnectorIds: ["pubmed"], enabledSkillIds: [], specialistId: "specialist", settingsOverrides: {}};
  const run = {id: "run", prompt: "Inspect MCP", references: [], annotationIds: [], sessionId: session.id, status: "running", queueOrder: 0, createdAt: "now", settingsSnapshot: {enabledConnectorIds: [], enabledSkillIds: []}} as unknown as SessionRun;
  const manifest = {id: "pubmed", displayName: "PubMed", publisher: "NCBI", termsUrl: "https://example.test/policy"};
  let status = "unavailable", reads = 0, fail = false;
  let onEvent!: (event: RunStreamEvent, sequence?: number) => void;
  const subscriptions: Array<{ sessionId: string; runId: string }> = [];
  context.mock.method(ApiClient.prototype, "subscribeRunEvents", async (_session, _run, _after, listener, signal) => {
    subscriptions.push({ sessionId: _session, runId: _run });
    onEvent = listener;
    await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), {once: true}));
  });
  globalThis.fetch = (async input => {
    const path = String(input).split("?")[0];
    if (path === "/api/settings") return jsonResponse({overrides: {}, effective: {enabledConnectorIds: [], enabledSkillIds: [], enabledSkillLibraries: [], plugins: {}}, sources: {}});
    if (path === "/api/memory/settings") return jsonResponse({enabled: false});
    if (path === "/api/memory/subgraph") return jsonResponse({nodes: [], edges: [], reason: "memory_graph_disabled"});
    if (path === "/api/projects") return jsonResponse([{id: "project-1", name: "Alpha", remoteRunnerHostIds: [], localRunnerEnabled: true}]);
    if (path === "/api/projects/project-1/sessions") return jsonResponse([session]);
    if (path === "/api/sessions/session-1") return jsonResponse(session);
    if (path === "/api/specialists") return jsonResponse([{id: "specialist", name: "Literature", connectorIds: ["arxiv"]}]);
    if (path === "/api/connectors") return jsonResponse([manifest, {...manifest, id: "arxiv", displayName: "arXiv"}]);
    if (path === "/api/mcp/sources") {
      reads++;
      if (fail) return Response.json({error: "discovery offline"}, {status: 503});
      return jsonResponse([{manifest, status: {sourceId: "pubmed", status, availableTools: status === "ready" ? ["search"] : [], missingTools: status === "ready" ? [] : ["search"], error: status === "ready" ? undefined : "offline"}}]);
    }
    if (path?.endsWith("/idea-tree/graph")) return jsonResponse({graph: null, hasIdeaTreeRun: false, treeIds: []});
    if (path?.endsWith("/research")) return jsonResponse({items: []});
    if (path === "/api/sessions/session-1/agent-activity") return jsonResponse({executions: [], timers: [], transfers: [], agents: []});
    if (path === "/api/sessions/session-1/usage") return jsonResponse({totals: {}, byRun: [], byModel: [], bySession: []});
    if (path === "/api/sessions/session-1/runs") return jsonResponse([run]);
    if (path === "/api/projects/project-1/plugins") return jsonResponse({settings: {effective: {plugins: {}}}});
    return jsonResponse(startupBody(String(input)));
  }) as typeof fetch;
  let view!: ReactTestRenderer;
  try {
    await act(async () => {view = create(createElement(LocaleProvider, {initialLocale: "en"}, createElement(App, {initialToken: "test-token"})));});
    await waitForMounted(() => typeof onEvent === "function", "the current Session's active Run event subscription");
    assert.equal(typeof onEvent, "function", "Session hydration must finish and install its run listener before events are emitted");
    assert.deepEqual(subscriptions, [{ sessionId: session.id, runId: run.id }]);
    const picker = () => view.root.findByType(ConnectorPicker);
    assert.deepEqual(picker().props.specialistIds, ["arxiv"]);
    assert.equal(picker().props.sourceStatuses.pubmed.status, "unavailable");
    const before = reads;
    await act(async () => onEvent({type: "run.status", status: "running", run}));
    assert.equal(reads, before, "nonterminal events must not trigger catalog traffic");
    status = "ready";
    await act(async () => onEvent({type: "run.status", status: "completed", run: {...run, status: "completed"}}));
    assert.equal(reads, before + 1, "terminal event must recheck without opening the picker");
    assert.equal(picker().props.sourceStatuses.pubmed.status, "ready");
    fail = true;
    await act(async () => picker().props.onOpen());
    assert.match(picker().props.refreshError, /discovery offline/);
    assert.deepEqual(picker().props.sourceStatuses, {}, "failed refresh cannot retain a ready badge");
    fail = false;
    await act(async () => picker().props.onReload());
    assert.equal(picker().props.sourceStatuses.pubmed.status, "ready");
    const serverSettings = view.root.findByType(McpServerSettings);
    status = "degraded";
    const settingsBefore = reads;
    await act(async () => {await serverSettings.props.onChanged();});
    assert.equal(reads, settingsBefore + 1);
    assert.equal(picker().props.sourceStatuses.pubmed.status, "degraded");
    await act(async () => onEvent({type: "session.updated", session: {...session, specialistId: undefined}} as unknown as RunStreamEvent));
    assert.deepEqual(picker().props.specialistIds, [], "removing the Specialist removes its inherited selection");
  } finally {await act(async () => view?.unmount()); globalThis.fetch = previousFetch;}
});

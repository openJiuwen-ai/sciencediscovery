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

import React from "react";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { ApiClient } from "../src/api/client.js";
import { runnerEnvironmentApi } from "../src/api/settings.js";
import type { Environment, ProxySettingsDetails, ScientificEnvironmentSetup, SystemQuotaSettings, RunnerTarget, UpdateWebSettingsRequest, WebSettingsDetails } from "../src/api/types.js";
import type { ConfirmRequest } from "../src/app/use-workspace.js";
import { TEXT } from "../src/text.js";
import { QuotaSettings } from "../src/views/settings/QuotaSettings.js";
import { WebSearchSettings } from "../src/views/settings/WebSearchSettings.js";
import { EnvironmentSources, RunnerEnvironmentPane } from "../src/views/settings/EnvironmentSettings.js";
import { RuntimeSettings } from "../src/views/settings/RuntimeSettings.js";
import { ProxySettings } from "../src/views/settings/ProxySettings.js";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "./support/dom-renderer.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { addEventListener() {}, removeEventListener() {} } });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

type Call = { path: string; method: string; body: unknown };
class Client extends ApiClient {
  calls: Call[] = [];
  constructor(readonly handle: (call: Call) => unknown | Promise<unknown>) { super(""); }
  override async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const call = { path, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) as unknown : undefined };
    this.calls.push(call);
    return await this.handle(call) as T;
  }
}
const markup = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());
const writes = (client: Client) => client.calls.filter(call => call.method !== "GET");
const noConfirm = () => {};
function handler(node: ReactTestInstance, event: string, ...args: unknown[]) {
  const fn = node.props[event]; assert.ok(typeof fn === "function"); return fn(...args);
}
function button(view: ReactTestRenderer, label: string) {
  const node = view.root.findAllByType("button").find(item => item.children.includes(label)
    || item.children.some(child => typeof child !== "string" && child.type === "strong" && child.children.includes(label)));
  assert.ok(node, `Missing button: ${label}`); return node;
}
async function mount(element: React.ReactElement): Promise<ReactTestRenderer> {
  let view: ReactTestRenderer | undefined;
  await act(async () => { view = create(element); }); assert.ok(view); return view;
}
async function close(view: ReactTestRenderer) { await act(async () => view.unmount()); }
const quotas: SystemQuotaSettings = { maxConcurrentSubagents: 4, runnerMaxOutputBytes: 1024 ** 3, runnerMaxWorkspaceBytes: 10 * 1024 ** 3, uploadMaxFileBytes: 1024 ** 3, uploadMaxRequestBytes: 10 * 1024 ** 3 };
function web(): WebSettingsDetails { return {
  backend: "jiuwenswarm", deepseekEnabled: false, fetchProvider: "jina", searchCacheTtlSeconds: 789, fetchCacheTtlSeconds: 456,
  freeSearchEngines: { bing: true, duckduckgo: true, "brave-html": false }, paidSearchProviders: ["exa", "deepseek"],
  proxyPolicy: "inherit", providers: [{ provider: "jina", hasApiKey: true }],
}; }
const setup: ScientificEnvironmentSetup = {
  state: "ready", phase: "complete", allowedChannels: [], completedAt: null, components: {
    conda: { action: null, completedAt: null, error: null, message: "Ready", phase: "complete", startedAt: null, state: "ready", updatedAt: "" },
    micromamba: { action: null, completedAt: null, error: null, message: "Ready", phase: "complete", startedAt: null, state: "ready", updatedAt: "" },
  }, error: null, managedProvisioner: true, message: "Ready", networkPolicy: "allowed-channels", provisioner: "micromamba",
  provisionerVersion: "2", startedAt: null, starterPackages: { python: ["numpy"], r: [] }, updatedAt: "",
};
function runner(id: string, name = id, connected = true): RunnerTarget {
  return { id, runnerName: name, alias: name, connectionKind: "ssh", location: id === "local" ? "local" : "remote",
    createdAt: "", updatedAt: "", runnerCommand: "runner", status: "ready", capabilities: { platform: "Linux", conda: false, containerRuntimes: [], cpuCores: 4,
      cuda: null, gpu: null, modules: false, memoryBytes: 1024, nodeVersion: null, probedAt: "",
      runnerCommandAvailable: true, scratchPaths: [], slurm: false },
    runnerStatus: { hostId: id, state: connected ? "ready" : "disconnected" } };
}
const environment = (name: string): Environment => ({ id: name, name, kind: "task", language: "python", currentRevisionId: "rev", createdAt: "", updatedAt: "" });
function proxy(): ProxySettingsDetails { return { defaultPolicy: "none", noProxy: "localhost", servers: [
  { id: "env", kind: "environment", name: "Environment", hasUrl: false, createdAt: "", updatedAt: "" },
  { id: "custom", kind: "custom_url", name: "Custom", hasUrl: true, url: `http://user:${randomUUID()}@proxy.example.test:8080`, createdAt: "", updatedAt: "" },
] }; }
function proxyClient(settings = proxy()) { return new Client(call => {
  if (call.path === "/api/proxy/settings") return settings;
  if (call.path === "/api/web/settings") return web();
  if (call.path === "/api/mcp/sources") return [];
  if (call.path === "/api/mcp/proxy-policies") return { policies: {} };
  return {};
}); }

test("quota edits keep empty input local, preserve other fields and notify upload preflight", async () => {
  let current = { ...quotas }; const saved: SystemQuotaSettings[] = [];
  const client = new Client(call => { if (call.method === "PUT") current = call.body as SystemQuotaSettings; return current; });
  const view = await mount(<QuotaSettings client={client} onSaved={value => saved.push(value)} />);
  try {
    const label = TEXT.settings.system.quotas.uploadFile;
    await act(async () => { handler(view.root.findByProps({ "aria-label": label }), "onChange", { target: { value: "" } }); });
    await act(async () => { handler(view.root.findByProps({ "aria-label": label }), "onBlur"); });
    assert.equal(writes(client).length, 0); assert.match(markup(view), new RegExp(TEXT.settings.system.migrated.common.invalidNumber));
    await act(async () => { handler(view.root.findByProps({ "aria-label": label }), "onChange", { target: { value: "1.5" } }); });
    await act(async () => { handler(view.root.findByProps({ "aria-label": label }), "onBlur"); });
    assert.deepEqual(writes(client)[0]?.body, { ...quotas, uploadMaxFileBytes: 1_500_000_000 });
    assert.equal(saved[0]?.uploadMaxFileBytes, 1_500_000_000);
    const unlimited = `${label} · ${TEXT.settings.system.timeouts.unlimited}`;
    await act(async () => { handler(view.root.findByProps({ role: "switch", "aria-label": unlimited }), "onClick"); });
    assert.equal(saved[1]?.uploadMaxFileBytes, 0);
  } finally { await close(view); }
});

test("quota GB values use two decimals without rounding stored bytes on an untouched blur", async () => {
  let current = { ...quotas };
  const client = new Client(call => { if (call.method === "PUT") current = call.body as SystemQuotaSettings; return current; });
  const view = await mount(<QuotaSettings client={client} onSaved={() => {}} />);
  try {
    const text = TEXT.settings.system.quotas;
    const input = () => view.root.findByProps({ "aria-label": text.uploadFile });
    assert.equal(input().props.value, "1.07");
    assert.equal(input().props.step, 0.01);
    assert.equal(view.root.findByProps({ "aria-label": text.workspace }).props.value, "10.74");
    assert.equal(view.root.findByProps({ "aria-label": text.subagents }).props.value, "4");
    await act(async () => { handler(input(), "onBlur"); });
    assert.equal(writes(client).length, 0);
    assert.equal(current.uploadMaxFileBytes, 1024 ** 3);
    await act(async () => { handler(input(), "onChange", { target: { value: "1.23456789" } }); });
    await act(async () => { handler(input(), "onBlur"); });
    assert.equal(current.uploadMaxFileBytes, 1_230_000_000);
    assert.equal(input().props.value, "1.23");
    await act(async () => { handler(input(), "onBlur"); });
    assert.equal(writes(client).length, 1);
  } finally { await close(view); }
});

test("quota failures keep the confirmed value and reject invalid concurrency", async () => {
  const client = new Client(call => { if (call.method === "PUT") throw new Error("quota write refused"); return quotas; });
  const view = await mount(<QuotaSettings client={client} onSaved={() => assert.fail("failed save must not update upload limits")} />);
  try {
    const label = TEXT.settings.system.quotas.subagents;
    await act(async () => { handler(view.root.findByProps({ "aria-label": label }), "onChange", { target: { value: "11" } }); });
    await act(async () => { handler(view.root.findByProps({ "aria-label": label }), "onBlur"); });
    assert.equal(writes(client).length, 0);
    await act(async () => { handler(view.root.findByProps({ "aria-label": label }), "onChange", { target: { value: "3" } }); });
    await act(async () => { handler(view.root.findByProps({ "aria-label": label }), "onBlur"); });
    assert.match(markup(view), /quota write refused/);
  } finally { await close(view); }
});

test("Swarm search hides native fields and patches only the selected engine", async () => {
  const settings = web();
  const client = new Client(call => { if (call.method === "PUT") return Object.assign(settings, call.body); return settings; });
  const view = await mount(<WebSearchSettings client={client} onConfirm={noConfirm} />);
  try {
    assert.doesNotMatch(markup(view), /Tavily|Brave|Exa|789|456/);
    assert.equal(view.root.findAllByProps({ role: "switch" }).length, 2, "paid services have no enable switches");
    await act(async () => { handler(view.root.findByProps({ "aria-label": "Bing", role: "switch" }), "onClick"); });
    assert.deepEqual(writes(client)[0]?.body, { freeSearchEngines: { bing: false, duckduckgo: true, "brave-html": false } });
  } finally { await close(view); }
});

test("Swarm credentials support keep, replace and explicit removal without exposing a saved secret", async () => {
  const client = new Client(() => web()); let confirmation: ConfirmRequest | undefined;
  const view = await mount(<WebSearchSettings client={client} onConfirm={request => { confirmation = request; }} />);
  try {
    await act(async () => { const buttons = view.root.findAllByType("button").filter(node => node.children.includes(TEXT.settings.system.migrated.web.configure)); assert.ok(buttons[3]); handler(buttons[3], "onClick"); });
    await act(async () => { handler(view.root.findByType("form"), "onSubmit", { preventDefault() {} }); });
    assert.equal(writes(client).length, 0);
    await act(async () => { const buttons = view.root.findAllByType("button").filter(node => node.children.includes(TEXT.settings.system.migrated.web.configure)); assert.ok(buttons[3]); handler(buttons[3], "onClick"); });
    const credential = randomUUID();
    await act(async () => { handler(view.root.findByProps({ "aria-label": TEXT.settings.system.migrated.web.key }), "onChange", { target: { value: ` ${credential} ` } }); });
    await act(async () => { await handler(view.root.findByType("form"), "onSubmit", { preventDefault() {} }); });
    assert.deepEqual(writes(client)[0]?.body, { providerApiKeys: { jina: credential } });
    assert.ok(!markup(view).includes(credential));
    await act(async () => { handler(view.root.findByProps({ "aria-label": `Jina · ${TEXT.settings.system.migrated.common.remove}` }), "onClick"); });
    assert.ok(confirmation); await act(async () => { await confirmation?.onAccept(); });
    assert.deepEqual(writes(client)[1]?.body, { providerApiKeys: { jina: null } });
  } finally { await close(view); }
});

test("a native backend does not offer Swarm-only controls", async () => {
  const client = new Client(() => ({ ...web(), backend: "native" }));
  const view = await mount(<WebSearchSettings client={client} onConfirm={noConfirm} />);
  try { assert.equal(view.root.findAllByProps({ role: "switch" }).length, 0); assert.ok(markup(view).includes(TEXT.settings.system.migrated.web.unsupported)); }
  finally { await close(view); }
});

test("Runner changes discard late local answers and keep source preferences global", async () => {
  let finishLocal: ((value: unknown) => void) | undefined;
  const local = new Promise(resolve => { finishLocal = resolve; });
  const client = new Client(call => {
    if (call.path === "/api/runners") return [runner("local"), runner("remote", "GPU")];
    if (call.path === "/api/runners/npu") return { selections: {} };
    if (call.path === "/api/environment-source-settings") return { condaSource: "upstream", pipSource: "upstream" };
    if (call.path === "/api/runners/local/environment-setup") return local;
    if (call.path.endsWith("environment-setup")) return setup;
    if (call.path.endsWith("environment-revisions")) return [];
    if (call.path.endsWith("environments")) return [environment(call.path.includes("remote") ? "remote-env" : "local-env")];
    throw new Error(`Unexpected ${call.path}`);
  });
  const view = await mount(<RuntimeSettings client={client} onConfirm={noConfirm} />);
  try {
    await act(async () => { handler(button(view, TEXT.settings.system.migrated.environments.local), "onClick"); });
    await act(async () => { handler(button(view, TEXT.settings.system.migrated.environments.back), "onClick"); });
    await act(async () => { handler(button(view, "GPU"), "onClick"); });
    assert.match(markup(view), /remote-env/);
    await act(async () => { finishLocal?.(setup); });
    assert.doesNotMatch(markup(view), /local-env/);
    assert.equal(client.calls.filter(call => call.path.includes("source-settings")).every(call => call.path === "/api/environment-source-settings"), true);
  } finally { await close(view); }
});

test("a disconnected Runner offers guidance without environment requests", async () => {
  const client = new Client(call => call.path === "/api/runners" ? [runner("remote", "GPU", false)]
    : call.path === "/api/environment-source-settings" ? { condaSource: "upstream", pipSource: "upstream" } : { selections: {} });
  const view = await mount(<RuntimeSettings client={client} onConfirm={noConfirm} />);
  try {
    await act(async () => { handler(button(view, "GPU"), "onClick"); });
    assert.ok(markup(view).includes(TEXT.settings.system.migrated.environments.unavailable)); assert.equal(client.calls.some(call => call.path.includes("/remote/")), false);
  }
  finally { await close(view); }
});

test("initialization exposes failure and retries only the selected Runner", async () => {
  const client = new Client(call => {
    if (call.path === "/api/runners") return [];
    if (call.path === "/api/environment-source-settings") return { condaSource: "upstream", pipSource: "upstream" };
    if (call.path.endsWith("environment-setup")) return { ...setup, state: "failed", error: "download failed" };
    throw new Error(`Unexpected ${call.path}`);
  });
  const view = await mount(<RunnerEnvironmentPane client={client} runnerId="local" onConfirm={noConfirm} />);
  try {
    assert.match(markup(view), /download failed/);
    await act(async () => { handler(button(view, TEXT.settings.system.migrated.environments.retry), "onClick"); });
    assert.deepEqual(writes(client), [{ path: "/api/runners/local/environment-setup", method: "POST", body: { confirmed: true } }]);
  } finally { await close(view); }
});

test("Runner APIs encode identifiers and preserve installation contracts", async () => {
  const client = new Client(() => ({})); const api = runnerEnvironmentApi(client, "remote/a");
  await api.install("env/a", { manager: "pip", packages: ["numpy==2"] });
  await api.remove("env/a");
  assert.deepEqual(writes(client), [
    { path: "/api/runners/remote%2Fa/environments/env%2Fa/install", method: "POST", body: { manager: "pip", packages: ["numpy==2"] } },
    { path: "/api/runners/remote%2Fa/environments/env%2Fa", method: "DELETE", body: undefined },
  ]);
});

test("proxy defaults preserve bypass settings and Swarm has no misleading Web proxy selector", async () => {
  const client = proxyClient(); const view = await mount(<ProxySettings client={client} onConfirm={noConfirm} />);
  try {
    assert.ok(markup(view).includes(TEXT.settings.system.migrated.proxy.swarmNote));
    assert.equal(view.root.findAllByProps({ "aria-label": TEXT.settings.system.migrated.proxy.web }).length, 0);
    await act(async () => { handler(view.root.findByProps({ "aria-label": TEXT.settings.system.proxies.default }), "onChange", { target: { value: "proxy:env" } }); });
    assert.deepEqual(writes(client)[0]?.body, { defaultPolicy: "proxy:env" });
  } finally { await close(view); }
});

test("proxy editing shows the saved URL, preserves unchanged credentials and displays deletion failures", async () => {
  const settings = proxy(); let confirmation: ConfirmRequest | undefined;
  const client = new Client(call => {
    if (call.method === "DELETE") throw new Error("PROXY_RESOURCE_IN_USE");
    if (call.path === "/api/proxy/settings") return settings;
    if (call.path === "/api/web/settings") return web();
    if (call.path === "/api/mcp/sources") return [];
    if (call.path === "/api/mcp/proxy-policies") return { policies: {} };
    return {};
  });
  const view = await mount(<ProxySettings client={client} onConfirm={request => { confirmation = request; }} />);
  try {
    assert.ok(settings.servers[1]?.url); assert.ok(!markup(view).includes(settings.servers[1].url));
    await act(async () => { const edits = view.root.findAllByType("button").filter(node => node.children.includes(TEXT.settings.system.migrated.common.edit)); assert.ok(edits[1]); handler(edits[1], "onClick"); });
    const urlInput = view.root.findByProps({ "aria-label": TEXT.settings.system.proxies.url });
    assert.equal(urlInput.props.value, settings.servers[1].url);
    assert.equal(urlInput.props.type, "text");
    await act(async () => { const form = view.root.findAllByType("form").at(-1); assert.ok(form); handler(form, "onSubmit", { preventDefault() {} }); });
    assert.deepEqual(writes(client)[0]?.body, { name: "Custom", kind: "custom_url" });
    await act(async () => { handler(view.root.findByProps({ "aria-label": `Custom · ${TEXT.settings.system.migrated.common.remove}` }), "onClick"); });
    assert.ok(confirmation); await act(async () => { await confirmation?.onAccept(); });
    assert.match(markup(view), /PROXY_RESOURCE_IN_USE/);
    assert.match(markup(view), /Custom/);
  } finally { await close(view); }
});

test("MCP proxy overrides deduplicate server IDs and preserve other policies", async () => {
  const settings = proxy();
  const client = new Client(call => {
    if (call.path === "/api/proxy/settings") return settings;
    if (call.path === "/api/web/settings") return web();
    if (call.path === "/api/mcp/sources") return ["A", "B"].map(name => ({ manifest: { id: name, displayName: name, transport: { mcpServerId: "shared" } } }));
    if (call.path === "/api/mcp/proxy-policies") return { policies: { other: "none", shared: "inherit" } };
    throw new Error(`Unexpected ${call.path}`);
  });
  const view = await mount(<ProxySettings client={client} onConfirm={noConfirm} />);
  try {
    const selectors = view.root.findAllByType("select").filter(node => String(node.props["aria-label"]).startsWith(TEXT.settings.system.migrated.proxy.mcp));
    assert.equal(selectors.length, 1); const selector = selectors[0]; assert.ok(selector);
    await act(async () => { handler(selector, "onChange", { target: { value: "proxy:env" } }); });
    assert.deepEqual(writes(client)[0]?.body, { policies: { other: "none", shared: "proxy:env" } });
  } finally { await close(view); }
});

test("custom environments create, install and delete on one Runner; base environments stay read-only", async () => {
  let environments: Environment[] = [{ ...environment("base"), kind: "starter" }];
  let confirmation: ConfirmRequest | undefined;
  let finishCreation: (() => void) | undefined;
  const client = new Client(call => {
    if (call.path === "/api/runners") return [];
    if (call.path === "/api/environment-source-settings") return { condaSource: "upstream", pipSource: "upstream" };
    if (call.path.endsWith("environment-setup")) return setup;
    if (call.path.endsWith("environment-revisions")) return [];
    if (call.method === "POST" && call.path.endsWith("/environments")) return new Promise(resolve => {
      finishCreation = () => { environments = [...environments, environment("analysis")]; resolve(environment("analysis")); };
    });
    if (call.method === "DELETE") { environments = environments.filter(item => item.id !== "analysis"); return {}; }
    if (call.path.endsWith("/install")) return { status: "ready" };
    if (call.path.endsWith("/environments")) return environments;
    throw new Error(`Unexpected ${call.path}`);
  });
  const view = await mount(<RunnerEnvironmentPane client={client} runnerId="local" onConfirm={request => { confirmation = request; }} />);
  const text = TEXT.settings.system.migrated.environments;
  try {
    await act(async () => { handler(button(view, "base"), "onClick"); });
    assert.equal(view.root.findAllByType("textarea").length, 0);
    assert.equal(view.root.findAllByType("button").some(node => node.children.includes(TEXT.settings.system.migrated.common.remove)), false);
    await act(async () => { const closeButton = view.root.findAllByType("button").find(node => node.props.className === "settings-modal-close"); assert.ok(closeButton); handler(closeButton, "onClick"); });
    await act(async () => { handler(button(view, text.create), "onClick"); });
    await act(async () => { handler(view.root.findByProps({ "aria-label": text.name }), "onChange", { target: { value: " analysis " } }); });
    await act(async () => { const form = view.root.findAllByType("form").at(-1); assert.ok(form); handler(form, "onSubmit", { preventDefault() {} }); });
    assert.ok(markup(view).includes(text.creating));
    assert.ok(!markup(view).includes(TEXT.settings.system.saving));
    await act(async () => { finishCreation?.(); });
    assert.ok(markup(view).includes(text.created));
    assert.ok(!markup(view).includes(TEXT.settings.system.migrated.common.saved));
    assert.deepEqual(writes(client)[0], { path: "/api/runners/local/environments", method: "POST", body: { name: "analysis", language: "python" } });
    await act(async () => { handler(button(view, "analysis"), "onClick"); });
    await act(async () => { handler(view.root.findByProps({ "aria-label": `analysis · ${text.packages}` }), "onChange", { target: { value: "numpy==2, pandas\nscipy" } }); });
    await act(async () => { const form = view.root.findAllByType("form").at(-1); assert.ok(form); await handler(form, "onSubmit", { preventDefault() {} }); });
    assert.deepEqual(writes(client)[1]?.body, { manager: "conda", packages: ["numpy==2", "pandas", "scipy"] });
    await act(async () => { handler(button(view, TEXT.settings.system.migrated.common.remove), "onClick"); });
    assert.ok(confirmation); await act(async () => { await confirmation?.onAccept(); });
    assert.deepEqual(writes(client)[2], { path: "/api/runners/local/environments/analysis", method: "DELETE", body: undefined });
    assert.equal(view.root.findAllByProps({ role: "dialog" }).length, 0);
  } finally { await close(view); }
});

test("package source selections save quietly, reject unsupported presets and report failures", async () => {
  let refuseWrite = false;
  const client = new Client(call => {
    if (call.method === "PUT" && refuseWrite) throw new Error("package source write refused");
    if (call.path === "/api/runners") return [{ id: "offline", runnerStatus: { state: "disconnected" } }];
    return { condaSource: "upstream", pipSource: "upstream" };
  });
  const view = await mount(<EnvironmentSources client={client} />);
  try {
    const text = TEXT.settings.system.migrated.environments;
    const conda = view.root.findByProps({ "aria-label": text.conda });
    assert.equal(conda.findAllByType("option").some(node => node.props.value === "huawei"), false);
    await act(async () => { handler(view.root.findByProps({ "aria-label": text.pip }), "onChange", { target: { value: "huawei" } }); });
    assert.equal(view.root.findAllByType("button").some(node => node.children.includes(TEXT.settings.system.migrated.common.save)), false);
    assert.deepEqual(writes(client), [{ path: "/api/environment-source-settings", method: "PUT", body: { pipSource: "huawei" } }]);
    assert.ok(!markup(view).includes(TEXT.settings.system.migrated.common.saved));
    refuseWrite = true;
    await act(async () => { handler(view.root.findByProps({ "aria-label": text.conda }), "onChange", { target: { value: "ustc" } }); });
    assert.match(markup(view), /package source write refused/);
  } finally { await close(view); }
});

test("proxy connectivity uses the selected route and bypass list without reporting a settings save", async () => {
  const settings = proxy(); settings.defaultPolicy = "proxy:custom";
  const client = new Client(call => {
    if (call.path === "/api/proxy/settings") return settings;
    if (call.path === "/api/web/settings") return web();
    if (call.path === "/api/mcp/sources") return [];
    if (call.path === "/api/mcp/proxy-policies") return { policies: {} };
    if (call.path === "/api/proxy/test") return { ok: false, message: "Download source unreachable", elapsedMs: 5, target: "https://example.test" };
    throw new Error(`Unexpected ${call.path}`);
  });
  const view = await mount(<ProxySettings client={client} onConfirm={noConfirm} />);
  try {
    await act(async () => { handler(button(view, TEXT.settings.system.migrated.proxy.test), "onClick"); });
    assert.deepEqual(writes(client)[0]?.body, { mode: "url", url: settings.servers[1]?.url, noProxy: "localhost" });
    assert.match(markup(view), /Download source unreachable/);
    assert.ok(!markup(view).includes(TEXT.settings.system.migrated.common.saved));
    assert.ok(!markup(view).includes(settings.servers[1]?.url ?? "missing"));
  } finally { await close(view); }
});

test("proxy bypass edits are explicit and keep the current default policy", async () => {
  const client = proxyClient(); const view = await mount(<ProxySettings client={client} onConfirm={noConfirm} />);
  try {
    await act(async () => { handler(view.root.findByProps({ "aria-label": TEXT.settings.system.migrated.proxy.noProxy }), "onChange", { target: { value: " .example.test " } }); });
    assert.equal(writes(client).length, 0);
    await act(async () => { handler(view.root.findByType("form"), "onSubmit", { preventDefault() {} }); });
    assert.deepEqual(writes(client)[0]?.body, { defaultPolicy: "none", noProxy: ".example.test" });
  } finally { await close(view); }
});

test("two immediate setting writes cannot race each other", async () => {
  let finish: ((value: unknown) => void) | undefined;
  const pending = new Promise(resolve => { finish = resolve; });
  const client = new Client(call => call.method === "PUT" ? pending : web());
  const view = await mount(<WebSearchSettings client={client} onConfirm={noConfirm} />);
  try {
    await act(async () => {
      handler(view.root.findByProps({ role: "switch", "aria-label": "Bing" }), "onClick");
      handler(view.root.findByProps({ role: "switch", "aria-label": "DuckDuckGo" }), "onClick");
    });
    assert.equal(writes(client).length, 1);
    assert.equal(view.root.findByProps({ role: "switch", "aria-label": "Bing" }).props.disabled, true);
    await act(async () => { finish?.(web()); });
  } finally { await close(view); }
});

function editableWebClient(settings: WebSettingsDetails) {
  return new Client(call => {
    if (call.method === "PUT") {
      const { providerApiKeys, ...values } = call.body as UpdateWebSettingsRequest;
      Object.assign(settings, values);
      for (const [provider, value] of Object.entries(providerApiKeys ?? {})) {
        const state = settings.providers.find(item => item.provider === provider);
        if (state) state.hasApiKey = value !== null;
        else if (provider === "deepseek") settings.providers.push({ provider, hasApiKey: value !== null });
      }
    }
    return settings;
  });
}
async function openDeepseekKey(view: ReactTestRenderer) {
  await act(async () => {
    const controls = view.root.findAllByType("button").filter(node => node.children.includes(TEXT.settings.system.migrated.web.configure));
    assert.equal(controls.length, 5, "DeepSeek belongs with the other four paid providers");
    assert.ok(controls[4]); handler(controls[4], "onClick");
  });
}

test("DeepSeek has no enable switches and legacy disabled credentials require an explicit save", async () => {
  const settings: WebSettingsDetails = { ...web(), fetchProvider: "deepseek", providers: [{ provider: "deepseek", hasApiKey: true }] };
  const client = editableWebClient(settings);
  const view = await mount(<WebSearchSettings client={client} onConfirm={noConfirm} />);
  const text = TEXT.settings.system.migrated.web;
  try {
    assert.equal(view.root.findAllByProps({ role: "switch" }).length, 2);
    assert.equal(view.root.findByProps({ "aria-label": text.fetchProvider }).props.value, "jina");
    assert.ok(markup(view).includes(text.searchInactive));
    assert.equal(writes(client).length, 0, "opening settings must not start paid operations");
    await openDeepseekKey(view);
    await act(async () => { await handler(view.root.findByType("form"), "onSubmit", { preventDefault() {} }); });
    assert.deepEqual(writes(client)[0]?.body, { deepseekEnabled: true, paidSearchProviders: ["exa", "deepseek"], fetchProvider: "jina" });
    assert.ok(!markup(view).includes(text.searchInactive));
  } finally { await close(view); }
});

test("saving a DeepSeek key enables paid search without selecting it for fetching", async () => {
  const settings = web(); const client = editableWebClient(settings);
  const view = await mount(<WebSearchSettings client={client} onConfirm={noConfirm} />);
  try {
    await openDeepseekKey(view);
    const credential = randomUUID();
    await act(async () => { handler(view.root.findByProps({ "aria-label": TEXT.settings.system.migrated.web.key }), "onChange", { target: { value: credential } }); });
    await act(async () => { await handler(view.root.findByType("form"), "onSubmit", { preventDefault() {} }); });
    assert.deepEqual(writes(client)[0]?.body, { providerApiKeys: { deepseek: credential }, deepseekEnabled: true, paidSearchProviders: ["exa", "deepseek"] });
    assert.equal(settings.fetchProvider, "jina");
    assert.equal(view.root.findByProps({ "aria-label": TEXT.settings.system.migrated.web.fetchProvider }).props.value, "jina");
    assert.ok(!markup(view).includes(credential));
  } finally { await close(view); }
});

test("removing the shared DeepSeek key disables search and restores default fetching", async () => {
  const settings: WebSettingsDetails = { ...web(), deepseekEnabled: true, fetchProvider: "deepseek", providers: [{ provider: "deepseek", hasApiKey: true }] };
  const client = editableWebClient(settings); let confirmation: ConfirmRequest | undefined;
  const view = await mount(<WebSearchSettings client={client} onConfirm={request => { confirmation = request; }} />);
  const text = TEXT.settings.system.migrated.web;
  try {
    assert.ok(markup(view).includes(text.fetchCost));
    await act(async () => { handler(view.root.findByProps({ "aria-label": `DeepSeek · ${TEXT.settings.system.migrated.common.remove}` }), "onClick"); });
    assert.ok(confirmation); await act(async () => { await confirmation?.onAccept(); });
    assert.deepEqual(writes(client)[0]?.body, { providerApiKeys: { deepseek: null }, deepseekEnabled: false, paidSearchProviders: ["exa"], fetchProvider: "jina" });
    assert.equal(view.root.findByProps({ "aria-label": text.fetchProvider }).props.value, "jina");
    assert.ok(!markup(view).includes(text.fetchCost));
  } finally { await close(view); }
});

test("fetch selection shares the saved key and switching back keeps paid search enabled", async () => {
  const settings: WebSettingsDetails = { ...web(), providers: [{ provider: "deepseek", hasApiKey: true }] };
  const client = editableWebClient(settings);
  const view = await mount(<WebSearchSettings client={client} onConfirm={noConfirm} />);
  const text = TEXT.settings.system.migrated.web;
  try {
    await act(async () => { handler(view.root.findByProps({ "aria-label": text.fetchProvider }), "onChange", { target: { value: "deepseek" } }); });
    assert.deepEqual(writes(client)[0]?.body, { fetchProvider: "deepseek", deepseekEnabled: true, paidSearchProviders: ["exa", "deepseek"] });
    assert.ok(markup(view).includes(text.fetchCost));
    await act(async () => { handler(view.root.findByProps({ "aria-label": text.fetchProvider }), "onChange", { target: { value: "jina" } }); });
    assert.deepEqual(writes(client)[1]?.body, { fetchProvider: "jina" });
    assert.ok(!markup(view).includes(text.fetchCost));
    assert.equal(settings.deepseekEnabled, true);
    assert.deepEqual(settings.paidSearchProviders, ["exa", "deepseek"]);
  } finally { await close(view); }
});

test("DeepSeek fetching requires the shared paid-provider key", async () => {
  const client = editableWebClient(web());
  const view = await mount(<WebSearchSettings client={client} onConfirm={noConfirm} />);
  const text = TEXT.settings.system.migrated.web;
  try {
    assert.ok(markup(view).includes(text.keyRequired));
    const selector = view.root.findByProps({ "aria-label": text.fetchProvider });
    const option = selector.findAllByType("option").find(node => node.props.value === "deepseek");
    assert.ok(option); assert.equal(option.props.disabled, true);
    await act(async () => { handler(selector, "onChange", { target: { value: "deepseek" } }); });
    assert.equal(writes(client).length, 0);
  } finally { await close(view); }
});

test("DeepSeek credential updates preserve native-only fetch settings", async () => {
  const settings: WebSettingsDetails = { ...web(), deepseekEnabled: true, fetchProvider: "exa", providers: [{ provider: "deepseek", hasApiKey: true }] };
  const client = editableWebClient(settings);
  const view = await mount(<WebSearchSettings client={client} onConfirm={noConfirm} />);
  try {
    await openDeepseekKey(view);
    await act(async () => { await handler(view.root.findByType("form"), "onSubmit", { preventDefault() {} }); });
    assert.deepEqual(writes(client)[0]?.body, { deepseekEnabled: true, paidSearchProviders: ["exa", "deepseek"] });
    assert.equal(settings.fetchProvider, "exa");
  } finally { await close(view); }
});

test("runtime overview owns shared sources while each Runner detail owns multiple environments", async () => {
  const client = new Client(call => {
    if (call.path === "/api/runners") return [runner("local"), runner("remote", "GPU")];
    if (call.path === "/api/runners/npu") return { selections: {} };
    if (call.path === "/api/environment-source-settings") return { condaSource: "upstream", pipSource: "upstream" };
    if (call.path.endsWith("environment-setup")) return setup;
    if (call.path.endsWith("environment-revisions")) return [];
    if (call.path.endsWith("environments")) return [environment(call.path.includes("remote") ? "GPU-analysis" : "local-analysis"), environment("second-environment")];
    throw new Error(`Unexpected ${call.path}`);
  });
  const text = TEXT.settings.system.migrated.environments;
  const view = await mount(<RuntimeSettings client={client} onConfirm={noConfirm} />);
  try {
    assert.ok(markup(view).includes(text.local)); assert.match(markup(view), /GPU/);
    assert.ok(markup(view).includes(text.sources));
    assert.equal(client.calls.some(call => call.path.includes("environment-setup") || call.path === "/api/runners/npu"), false);
    await act(async () => { handler(button(view, text.local), "onClick"); });
    assert.match(markup(view), /local-analysis/); assert.match(markup(view), /second-environment/);
    assert.ok(!markup(view).includes(text.setup), "ready environments need no separate initialization status row");
    assert.ok(!markup(view).includes(text.catalog), "the environment list needs no second heading");
    assert.ok(!markup(view).includes(text.sources));
    assert.ok(!markup(view).includes(TEXT.settings.runtime.runner.add));
    assert.ok(!markup(view).includes(TEXT.settings.runtime.runner.delete));
    assert.ok(!markup(view).includes(TEXT.settings.runtime.runner.disconnect));
    assert.equal(view.root.findAllByType("details").length, 0, "machine resources stay visible in detail");
    await act(async () => { handler(button(view, text.back), "onClick"); });
    assert.ok(markup(view).includes(text.sources));
    await act(async () => { handler(button(view, "GPU"), "onClick"); });
    assert.match(markup(view), /GPU-analysis/); assert.doesNotMatch(markup(view), /local-analysis/);
    assert.ok(markup(view).includes(TEXT.settings.runtime.runner.disconnect));
    assert.ok(markup(view).includes(TEXT.settings.runtime.runner.credentials.heading));
    assert.ok(!markup(view).includes(text.sources));
  } finally { await close(view); }
});

test("runtime system settings contain no project selection controls or project requests", async () => {
  const client = new Client(call => {
    if (call.path === "/api/runners") return [runner("local"), runner("remote", "GPU")];
    if (call.path === "/api/environment-source-settings") return { condaSource: "upstream", pipSource: "upstream" };
    throw new Error(`Unexpected ${call.path}`);
  });
  const view = await mount(<RuntimeSettings client={client} onConfirm={noConfirm} />);
  try {
    assert.equal(view.root.findAllByType("input").length, 0);
    assert.equal(client.calls.some(call => call.path.includes("/projects")), false);
    assert.equal(writes(client).length, 0);
  } finally { await close(view); }
});

test("remote connection actions stay scoped to the selected Runner", async () => {
  let connected = false;
  const client = new Client(call => {
    if (call.path === "/api/runners") return [runner("local"), runner("remote", "GPU", connected)];
    if (call.path === "/api/runners/npu") return { selections: {} };
    if (call.path === "/api/runners/remote/connect") { connected = true; return {}; }
    if (call.path === "/api/runners/remote/disconnect") { connected = false; return {}; }
    if (call.path === "/api/environment-source-settings") return { condaSource: "upstream", pipSource: "upstream" };
    if (call.path.endsWith("environment-setup")) return setup;
    if (call.path.endsWith("environments") || call.path.endsWith("environment-revisions")) return [];
    throw new Error(`Unexpected ${call.path}`);
  });
  const view = await mount(<RuntimeSettings client={client} onConfirm={noConfirm} />);
  try {
    await act(async () => { handler(button(view, "GPU"), "onClick"); });
    await act(async () => { await handler(button(view, TEXT.settings.runtime.runner.connect), "onClick"); });
    assert.equal(writes(client)[0]?.path, "/api/runners/remote/connect");
    assert.ok(markup(view).includes(TEXT.settings.system.migrated.environments.heading));
    await act(async () => { await handler(button(view, TEXT.settings.runtime.runner.disconnect), "onClick"); });
    assert.equal(writes(client)[1]?.path, "/api/runners/remote/disconnect");
    assert.ok(markup(view).includes(TEXT.settings.system.migrated.environments.unavailable));
  } finally { await close(view); }
});

test("deleting a remote Runner returns to the overview and leaves built-in environments untouched", async () => {
  let removed = false; let confirmation: ConfirmRequest | undefined;
  const client = new Client(call => {
    if (call.path === "/api/runners") return removed ? [runner("local")] : [runner("local"), runner("remote", "GPU")];
    if (call.path === "/api/runners/npu") return { selections: {} };
    if (call.method === "DELETE") { removed = true; return { deleted: "remote" }; }
    if (call.path === "/api/environment-source-settings") return { condaSource: "upstream", pipSource: "upstream" };
    if (call.path.endsWith("environment-setup")) return setup;
    if (call.path.endsWith("environments") || call.path.endsWith("environment-revisions")) return [];
    throw new Error(`Unexpected ${call.path}`);
  });
  const view = await mount(<RuntimeSettings client={client} onConfirm={request => { confirmation = request; }} />);
  try {
    await act(async () => { handler(button(view, "GPU"), "onClick"); });
    await act(async () => { handler(button(view, TEXT.settings.runtime.runner.delete), "onClick"); });
    assert.ok(confirmation); await act(async () => { await confirmation?.onAccept(); });
    assert.equal(writes(client).length, 1);
    assert.equal(writes(client)[0]?.path, "/api/remote-hosts/remote");
    assert.ok(markup(view).includes(TEXT.settings.system.migrated.environments.sources));
    assert.ok(markup(view).includes(TEXT.settings.system.migrated.environments.local));
    assert.equal(view.root.findAllByProps({ className: "runner-detail-heading" }).length, 0);
  } finally { await close(view); }
});

test("shared package sources remain available when the Runner catalog fails", async () => {
  const client = new Client(call => {
    if (call.path === "/api/runners") throw new Error("Runner catalog unavailable");
    if (call.path === "/api/environment-source-settings") return { condaSource: "upstream", pipSource: "upstream" };
    throw new Error(`Unexpected ${call.path}`);
  });
  const view = await mount(<RuntimeSettings client={client} onConfirm={noConfirm} />);
  try {
    assert.match(markup(view), /Runner catalog unavailable/);
    assert.ok(markup(view).includes(TEXT.settings.system.migrated.environments.sources));
    assert.equal(view.root.findByProps({ "aria-label": TEXT.settings.system.migrated.environments.pip }).props.value, "upstream");
  } finally { await close(view); }
});

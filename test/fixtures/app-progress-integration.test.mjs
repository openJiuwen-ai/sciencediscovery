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

// Root integration fixture: the web and API keep their component boundaries;
// installed render dependencies and JSX configuration belong to the web workspace.
import { createTest } from "../support/tagged/compat.mjs";
const { test, after } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";
const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createElement } = webRequire("react");
const { act, create } = webRequire("react-test-renderer");
const scoped = register({ namespace: "app-progress-integration", tsconfig: fileURLToPath(new URL("../../apps/web/tsconfig.json", import.meta.url)) });
after(() => scoped.unregister());
const load = (path) => scoped.import(path, import.meta.url);
const { App } = await load("../../apps/web/src/App.tsx");
const { LocaleProvider } = await load("../../apps/web/src/i18n/index.ts");
const { TOKEN_STORAGE_KEY } = await load("../../apps/web/src/browser-storage.ts");
const { ApiClient } = await load("../../apps/web/src/api.ts");
const { RunTimeline, reduceRunTimeline } = await load("../../apps/web/src/RunTimeline.tsx");
const { SessionStore } = await load("../../services/api/src/store.ts");
const { buildCompletedToolTrace, publishRunEvent } = await load("../../services/api/src/runs/index.ts");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function browserFixture(context, autoRestore = true) {
  let url = new URL("http://localhost/");
  const values = /* @__PURE__ */ new Map([[TOKEN_STORAGE_KEY, "old"], ["sciencediscovery.workspace-collapsed", "1"]]);
  const storage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => {
    values.set(k, v);
  }, removeItem: (k) => {
    values.delete(k);
  } };
  const location = { get href() {
    return url.href;
  }, set href(v) {
    url = new URL(v, url);
  }, get pathname() {
    return url.pathname;
  }, get search() {
    return url.search;
  }, get hash() {
    return url.hash;
  } };
  const listeners = /* @__PURE__ */ new Map();
  const win = Object.assign(new EventTarget(), {
    location,
    localStorage: storage,
    innerWidth: 1440,
    // These mounted integration scenarios use a desktop viewport.
    matchMedia: (media) => Object.assign(new EventTarget(), { media, matches: false }),
    history: { state: null, replaceState(_s, _t, path) {
      url = new URL(path, url);
    }, pushState(_s, _t, path) {
      url = new URL(path, url);
    } },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (_cb) => 0
  });
  const add = win.addEventListener.bind(win), remove = win.removeEventListener.bind(win);
  win.addEventListener = ((name, fn, options) => {
    const set = listeners.get(name) ?? /* @__PURE__ */ new Set();
    set.add(fn);
    listeners.set(name, set);
    add(name, fn, options);
  });
  win.removeEventListener = ((name, fn, options) => {
    listeners.get(name)?.delete(fn);
    remove(name, fn, options);
  });
  const doc = Object.assign(new EventTarget(), { querySelector: () => null, documentElement: { lang: "en", setAttribute() {
  } } });
  const restores = [];
  for (const [name, value] of Object.entries({ window: win, document: doc, localStorage: storage })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    restores.push(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const restore = () => restores.forEach((fn) => fn());
  if (autoRestore) context.after(restore);
  return { win, storage, listeners, restore };
}
test("mounted App applies token links synchronously, ignores stale verdicts and removes its listener", async (context) => {
  const { win, storage, listeners, restore } = browserFixture(context, false);
  const requests = [];
  context.mock.method(globalThis, "fetch", (_path, init) => new Promise((resolve) => {
    requests.push({ token: new Headers(init.headers).get("authorization"), resolve });
  }));
  let renderer;
  await act(async () => {
    renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(App)));
  });
  context.after(async () => {
    try {
      await act(async () => renderer.unmount());
    } finally {
      restore();
    }
  });
  assert.equal(listeners.get("hashchange")?.size, 1);
  assert.ok(requests.some((r) => r.token === "Bearer old"));
  const rejected = () => new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
  await act(async () => {
    win.location.href = "http://localhost/#token=invalid-link-token&section=notes";
    win.dispatchEvent(new Event("hashchange"));
    requests.filter((r) => r.token === "Bearer old").forEach((r) => r.resolve(rejected()));
    await Promise.resolve();
  });
  assert.equal(storage.getItem(TOKEN_STORAGE_KEY), "invalid-link-token");
  assert.equal(win.location.hash, "#section=notes");
  assert.ok(requests.some((r) => r.token === "Bearer invalid-link-token"));
  assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0, "an old-token 401 must not open Connection");
  await act(async () => {
    requests.find((r) => r.token === "Bearer invalid-link-token").resolve(rejected());
  });
  assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 1, "the active-token 401 opens Connection");
  assert.ok(JSON.stringify(renderer.toJSON()).includes("Local service access token rejected"));
  await act(async () => {
    win.location.href = "http://localhost/#token=valid-link-token";
    win.dispatchEvent(new Event("hashchange"));
  });
  assert.ok(requests.some((r) => r.token === "Bearer valid-link-token"));
  await act(async () => {
    requests.find((r) => r.token === "Bearer valid-link-token").resolve(new Response(JSON.stringify({ providers: [], presets: [] })));
  });
  assert.ok(!JSON.stringify(renderer.toJSON()).includes("Local service access token rejected"), "a replacement token clears the rejected-token notice");
  await act(async () => renderer.unmount());
  assert.equal(listeners.get("hashchange")?.size, 0);
  const count = requests.length;
  win.location.href = "http://localhost/#token=after-unmount";
  win.dispatchEvent(new Event("hashchange"));
  assert.equal(requests.length, count);
  assert.equal(storage.getItem(TOKEN_STORAGE_KEY), "valid-link-token");
});
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
async function recordedSession(context) {
  const root = await mkdtemp(join(tmpdir(), "issue330-app-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.load();
  const model = await store.createModel({ apiToken: "fixture", baseUrl: "http://127.0.0.1:1", model: "fixture", name: "Fixture" });
  const project = await store.createProject("Research");
  const session = await store.createSession(project.id, "Clinical search", model.id);
  const message = await store.appendMessage(session.id, "user", "Find papers");
  const run = await store.createSessionRun({ sessionId: session.id, prompt: message.content, settingsSnapshot: store.resolveRuntimeSettings(session.id).effective });
  const completed = await store.updateSessionRun(session.id, run.id, { status: "completed", userMessageId: message.id });
  return { store, project, session, run: completed };
}
async function mountRecordedApp(context, fixture) {
  const { restore } = browserFixture(context, false);
  const { store, project, session, run } = fixture;
  context.mock.method(globalThis, "fetch", () => new Promise(() => {
  }));
  const fixed = {
    listProviders: { providers: [], presets: [] },
    listProjects: [project],
    listModels: [],
    getModelCatalog: {},
    listConnectors: [],
    listSkills: [],
    listSkillLibraries: [],
    getGlobalSettings: store.getGlobalSettings(),
    getTimeoutSettings: store.getTimeoutSettings(),
    getQuotaSettings: store.getQuotaSettings(),
    getSandboxNetworkSettings: store.getSandboxNetworkSettings(),
    getProxySettings: store.getProxySettings(),
    getMcpProxyPolicies: { policies: {} },
    listMcpSources: [],
    getWebSettings: void 0,
    getMemoryGraphSettings: void 0,
    getIdeaTreeSettings: void 0,
    searchWorkbench: { results: [] },
    listSpecialists: [],
    listPermissionGrants: [],
    listConfigurationRequests: { items: [] },
    listSessions: [session],
    listProjectArtifacts: [],
    getProjectSettings: void 0,
    getSession: await store.getSessionDetail(session.id),
    getPermissionEpoch: void 0,
    getSessionUsage: void 0,
    listRuns: [run]
  };
  for (const name of ["listFiles", "listPermissionRequests", "listExecutionRuns", "listArtifactDerivations", "listPromptManifests", "listArtifactReviews", "listReviewerAuditTasks", "listMcpInvocations", "listClaims", "listEvidenceLinks", "listSubagents", "listRemoteJobs", "listArtifactOutputs", "listMcpArtifactCandidates", "listMcpArtifactJobs", "listMcpArtifactPlans"]) fixed[name] = [];
  for (const [name, value] of Object.entries(fixed)) context.mock.method(ApiClient.prototype, name, async () => value);
  context.mock.method(ApiClient.prototype, "listRunEvents", async () => store.listSessionRunEvents(session.id, run.id));
  const streams = context.mock.method(ApiClient.prototype, "listRunStreamEvents", async (_sessionId, _runId, stream) => store.listRunStreamEvents(session.id, run.id, stream));
  let renderer;
  await act(async () => {
    renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(App)));
  });
  context.after(async () => {
    try {
      await act(async () => renderer.unmount());
    } finally {
      restore();
    }
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (renderer.root.findAllByType(RunTimeline).some((view) => view.props.entries.some((entry) => entry.type === "tool"))) break;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return { renderer, streams };
}
test("mounted App loads canonical full transcripts for empty, progress-only, result-only and mixed streams", async (context) => {
  const fixture = await recordedSession(context);
  const { store, session, run } = fixture;
  const trace = buildCompletedToolTrace({ type: "tool_execution_end", toolCallId: "search", toolName: "search_pubmed", isError: false, result: { content: [{ type: "text", text: "result" }] } });
  await publishRunEvent(store, session.id, run.id, { type: "tool.completed", trace });
  const { renderer, streams } = await mountRecordedApp(context, fixture);
  const timeline = renderer.root.findAllByType(RunTimeline).find((view) => view.props.entries.some((entry) => entry.type === "tool"));
  assert.ok(timeline, "a stored terminal run is rendered by the mounted App");
  const load2 = timeline.props.onLoadToolOutput;
  assert.equal(await load2({ ...trace, outputStream: void 0 }), void 0);
  assert.equal(streams.mock.callCount(), 0);
  assert.equal(await load2(trace), void 0);
  assert.equal(await load2({ ...trace, outputStream: "main" }), void 0, "legacy mixed streams never render unrelated control records as output");
  const append = async (chunk, progress = false) => publishRunEvent(store, session.id, run.id, { type: "tool.output", toolCallId: "search", chunk, ...progress ? { progress: true } : {} });
  await append("searching", true);
  assert.equal(await load2(trace), "searching");
  await append('{"papers":2}');
  assert.equal(await load2(trace), 'searching\n\n---\n\n{"papers":2}');
  const resultTrace = { ...trace, id: "result", outputStream: "tool-result" };
  await publishRunEvent(store, session.id, run.id, { type: "tool.output", toolCallId: "result", chunk: "final only" });
  assert.equal(await load2(resultTrace), "final only");
  assert.ok(streams.mock.calls.every((call) => call.arguments[0] === session.id && call.arguments[1] === run.id));
});
test("completed search evidence survives real main-stream hydration without fetching full tool output", async (context) => {
  const fixture = await recordedSession(context);
  const { store, session, run } = fixture;
  const value = JSON.stringify({ sourceId: "pubmed", toolId: "search", records: [{ title: "Clinical evidence" }, { title: "Mechanism evidence" }] });
  const events = [
    { type: "tool.started", trace: { id: "search", name: "search_pubmed", status: "running", args: { query: "CRISPR SCD" } } },
    { type: "tool.output", toolCallId: "search", chunk: value },
    { type: "tool.completed", trace: buildCompletedToolTrace({ type: "tool_execution_end", toolCallId: "search", toolName: "search_pubmed", isError: false, result: { content: [{ type: "text", text: value }] } }) }
  ];
  const shellValue = "first evidence\nsecond evidence\nthird\nfourth\nfifth\nlast evidence";
  events.push(
    { type: "tool.started", trace: { id: "shell", name: "run_shell", status: "running" } },
    { type: "tool.output", toolCallId: "shell", chunk: shellValue },
    { type: "tool.completed", trace: buildCompletedToolTrace({ type: "tool_execution_end", toolCallId: "shell", toolName: "run_shell", isError: false, result: { content: [{ type: "text", text: shellValue }] } }) }
  );
  for (const event of events) await publishRunEvent(store, session.id, run.id, event);
  const live = events.reduce(reduceRunTimeline, []);
  const { renderer, streams } = await mountRecordedApp(context, fixture);
  const timeline = renderer.root.findAllByType(RunTimeline).find((view) => view.props.entries.some((entry) => entry.type === "tool"));
  assert.ok(timeline);
  const entries = timeline.props.entries;
  const tool = entries.find((entry) => entry.type === "tool");
  assert.ok(tool?.type === "tool");
  assert.equal(tool.paperCount ?? tool.trace.paperCount, 2);
  assert.equal(streams.mock.callCount(), 0, "collapsed hydration must not transfer full transcripts");
  const liveTool = live.find((entry) => entry.type === "tool");
  assert.ok(liveTool?.type === "tool");
  assert.equal(tool.trace.preview, liveTool.trace.preview);
  assert.equal(tool.trace.paperCount, liveTool.trace.paperCount);
  assert.equal(tool.trace.output, void 0, "bounded metadata does not duplicate the full result");
  const summaries = renderer.root.findAllByProps({ className: "timeline-evidence" });
  assert.ok(summaries.some((summary) => summary.children.join("").includes("2 papers returned")));
  assert.ok(summaries.some((summary) => summary.children.join("") === "first evidence\nsecond evidence\n\u2026\nfifth\nlast evidence"));
});

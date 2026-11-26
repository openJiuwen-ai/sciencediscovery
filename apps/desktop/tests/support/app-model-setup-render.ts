// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import React from "react";
import { DEFAULT_REVIEWER_SPECIALIST_LEVEL } from "@sciencediscovery/schema";
import { act, create, type ReactTestInstance } from "./dom-renderer.js";
import type { ModelProfile, ModelUsageBucket, Project, Session, SessionUsageSummary } from "../../src/api/types.js";
import { GUIDE_STORAGE_KEY, LOCALE_STORAGE_KEY, SIDEBAR_STORAGE_KEY } from "../../src/state/storage.js";

const [language, scenario] = process.argv.slice(2);
assert.ok(language === "zh-CN" || language === "en");
assert.ok(scenario);
const initialToken = randomUUID();
const storage = new Map<string, string>([[GUIDE_STORAGE_KEY, "1"], [LOCALE_STORAGE_KEY, language]]);
if (scenario === "sidebar-collapsed") storage.set(SIDEBAR_STORAGE_KEY, "0");
const localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
};
const fakeWindow = Object.assign(new EventTarget(), {
  innerWidth: 1440,
  localStorage,
  sdShell: { wizardIntroDone: true },
  location: { hash: "", pathname: "/", origin: "http://render.example.test" },
  history: { replaceState: () => {} },
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout,
  clearTimeout,
});
const fakeDocument = Object.assign(new EventTarget(), { documentElement: { lang: "" }, visibilityState: "visible" });
// tsx's classic JSX transform also needs React in modules that use only named
// hook imports. These globals exist only for this rendering child process.
Object.assign(globalThis, { React, window: fakeWindow, document: fakeDocument, localStorage, IS_REACT_ACT_ENVIRONMENT: true });
register("./render-css-loader.mjs", import.meta.url);
const { App } = await import("../../src/App.js");
const { Composer } = await import("../../src/views/Composer.js");
const { LoginPage } = await import("../../src/views/LoginPage.js");
const { TEXT } = await import("../../src/text.js");

const now = new Date().toISOString();
function model(id: string, name: string): ModelProfile {
  return { id, name, model: id, baseUrl: "https://models.example.test/v1", createdAt: now, updatedAt: now,
    hasApiToken: true, proxyPolicy: "inherit", vision: false };
}
const first = model("alpha", "Alpha model");
const data: { models: ModelProfile[]; projects: Project[]; sessions: Session[] } = {
  models: scenario === "last-model" ? [first] : [first, model("beta", "Beta model")],
  projects: [],
  sessions: [],
};
const inbox: Project = { id: "inbox", name: "Inbox", kind: "inbox", createdAt: now, remoteRunnerHostIds: [], settingsOverrides: {} };
const calls: string[] = [];
const unexpected: string[] = [];
let globalModel: string | undefined;
function settings(session?: Session) {
  return { overrides: session?.settingsOverrides ?? {}, effective: { modelId: session?.modelId ?? globalModel }, sources: {} };
}
function sessionUsage(sessionId: string): SessionUsageSummary {
  const totals: ModelUsageBucket = {
    key: "total", label: "Total", invocationCount: 0, reportedInvocationCount: 0, unreportedInvocationCount: 0,
    inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
  };
  return { sessionId, totals, byRun: [], byModel: [], byInvocationKind: [], invocations: [] };
}
function newSession(projectId: string): Session {
  const session: Session = {
    id: randomUUID(), projectId, title: "Rendered session", modelId: data.models[0]?.id,
    settingsOverrides: data.models[0] ? { modelId: data.models[0].id } : {},
    createdAt: now, updatedAt: now, approvalMode: "ask_for_dangerous",
    permissionEpochId: randomUUID(), reviewerAutomaticReviewEnabled: true, reviewerSpecialistLevel: DEFAULT_REVIEWER_SPECIALIST_LEVEL,
    enabledConnectorIds: [], enabledSkillIds: [], reviewCriteria: [], reviewMode: "auto", semanticReviewEnabled: true,
  };
  data.sessions.push(session);
  return session;
}
if (scenario === "empty-catalog") {
  data.models = [];
  data.projects.push({ ...inbox, id: "history-project", name: "Existing history", kind: undefined });
  newSession("history-project");
}
if (scenario === "sign-in-unconfigured") data.models = [];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), "http://render.example.test");
  const path = url.pathname;
  const method = init.method ?? "GET";
  calls.push(`${method} ${path}`);
  let result: unknown;
  if (url.hostname === "api.github.com") result = { stargazers_count: 1 };
  else if (path === "/api/health") result = { status: "ok" };
  else if (path === "/api/models") result = data.models;
  else if (path === "/api/specialists" || path === "/api/skills") result = [];
  // No credits-gateway branch here: this render has no account-service base
  // (`node:test` has no `import.meta.env`), and a build without one must never
  // reach `/v1/models` or register the credits provider. Leaving those routes
  // unhandled turns a regression into an "Unexpected request" failure.
  else if (path === "/api/providers") result = { providers: [], presets: [] };
  else if (path === "/api/settings") result = { ...settings(), overrides: globalModel ? { modelId: globalModel } : {} };
  else if (path === "/api/evolve/status") result = { state: "ready", canInitialize: false };
  else if (path === "/api/evolve/runs") result = [];
  else if (path === "/api/inbox") result = inbox;
  else if (path === "/api/projects" && method === "POST") {
    const project: Project = { ...inbox, id: "new-project", name: "Rendered project", kind: undefined };
    data.projects.push(project);
    result = { project, firstSession: newSession(project.id) };
  } else if (path === "/api/projects") result = data.projects;
  else if (/^\/api\/projects\/[^/]+\/settings$/u.test(path)) result = settings();
  else if (/^\/api\/projects\/[^/]+\/sessions$/u.test(path)) {
    const projectId = path.split("/")[3];
    assert.ok(projectId);
    result = method === "POST" ? newSession(projectId) : data.sessions.filter(session => session.projectId === projectId);
  } else if (/^\/api\/sessions\/[^/]+\/(artifact-outputs|files|runs)$/u.test(path)) result = [];
  // Opening a session reads its Idea Tree researches, and asks the legacy graph
  // route when there are none; both are product calls rather than unexpected
  // ones. Starting a research is not expected in these scenarios, so a POST
  // still falls through to the unexpected list.
  else if (method === "GET" && /^\/api\/sessions\/[^/]+\/idea-tree\/research$/u.test(path)) result = { items: [] };
  else if (method === "GET" && /^\/api\/sessions\/[^/]+\/idea-tree\/graph$/u.test(path)) result = { graph: null, hasIdeaTreeRun: false, treeIds: [] };
  else if (/^\/api\/sessions\/[^/]+\/usage$/u.test(path)) {
    const sessionId = path.split("/")[3];
    assert.ok(sessionId);
    result = sessionUsage(sessionId);
  }
  else if (method === "GET" && /^\/api\/sessions\/[^/]+\/configuration-requests$/u.test(path)) result = { items: [] };
  else if (/^\/api\/sessions\/[^/]+\/(artifact-reviews|reviewer-audit-tasks)$/u.test(path)) result = [];
  else if (path === "/api/reviewer-specialist/settings") result = { enabled: true, feedbackPolicy: "auto" };
  else if (/^\/api\/sessions\/[^/]+\/reviewer-specialist\/settings$/u.test(path)) {
    const session = data.sessions.find(candidate => path.includes(candidate.id));
    result = {
      automaticReviewEnabled: session?.reviewerAutomaticReviewEnabled ?? true,
      level: session?.reviewerSpecialistLevel ?? DEFAULT_REVIEWER_SPECIALIST_LEVEL,
    };
  } else if (method === "GET" && /^\/api\/sessions\/[^/]+\/configuration-requests$/u.test(path)) result = { items: [] };
  else if (/^\/api\/sessions\/[^/]+\/settings$/u.test(path)) result = settings(data.sessions.find(session => path.includes(session.id)));
  else if (/^\/api\/sessions\/[^/]+$/u.test(path)) result = { ...data.sessions.find(session => path.endsWith(session.id)), messages: [] };
  else {
    unexpected.push(`${method} ${path}`);
    return Response.json({ error: `Unexpected request: ${method} ${path}` }, { status: 500 });
  }
  return Response.json(result);
};

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}
let renderer: ReturnType<typeof create> | undefined;
function root() { assert.ok(renderer); return renderer.root; }
function shellClasses(): string[] {
  const shells = root().findAllByType("div")
    .filter(node => String(node.props.className).split(" ").includes("app-shell"));
  assert.equal(shells.length, 1);
  const shell = shells[0];
  assert.ok(shell);
  return String(shell.props.className).split(" ").filter(Boolean);
}
function sidebarToggle(open: boolean) {
  const found = root().findAllByProps({ className: "icon-btn side-toggle" })
    .filter(node => node.props["aria-expanded"] === open);
  assert.equal(found.length, 1);
  const toggle = found[0];
  assert.ok(toggle);
  return toggle;
}
function assertSetup() {
  // With no account and no model the entry page is the sign-in step; the
  // bring-your-own-model route sits beside it as a button rather than as a
  // tab, and the workspace stays closed until one of them succeeds.
  assert.equal(root().findAllByProps({ className: "login-tabs" }).length, 0);
  assert.equal(root().findAllByProps({ className: "login-entry" }).length, 1);
  assert.equal(root().findAllByProps({ className: "login-skip-button" }).length, 1);
  assert.ok(root().findAllByType("h1").some(node => text(node) === TEXT.login.title));
  assert.equal(root().findAllByProps({ className: "composer-model-pill" }).length, 0);
  assert.equal(root().findAllByType("div").filter(node => String(node.props.className).split(" ").includes("app-shell")).length, 0);
}
function assertModel() {
  const pills = root().findAllByProps({ className: "composer-model-pill" });
  assert.equal(pills.length, 1);
  assert.ok(pills[0]);
  assert.equal(text(pills[0]), first.name);
  assert.equal(root().findAllByProps({ className: "wizard-progress" }).length, 0);
}
async function click(node: ReactTestInstance) {
  const handler = node.props.onClick;
  assert.ok(typeof handler === "function");
  await act(async () => { await handler(); });
}
try {
  await act(async () => { renderer = create(React.createElement(App, { initialToken })); });
  if (scenario === "sign-in-unconfigured") {
    // The machine token is already in place (localToken === token). This build
    // has no account-service base, so signing in must not reach the credits
    // gateway: the custom-model wizard is the only way into the workspace.
    assertSetup();
    const authenticated = root().findByType(LoginPage).props.onAuthenticated;
    assert.ok(typeof authenticated === "function");
    const session = {
      userId: 1, openId: "open-id", displayName: "Signed-in user",
      accessToken: "gateway-token", refreshToken: "refresh-token",
      accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      balanceCredits: 100, createdAt: now,
    };
    await act(async () => { await authenticated(session, initialToken); });
    assert.ok(!calls.some(call => call.endsWith("/v1/models")), "an unconfigured build must not call the account gateway");
    assert.ok(!calls.includes("POST /api/providers"), "no credits provider without an account service");
    // The credits model never arrives, so the model wizard — not a silent
    // workspace — is what the signed-in user sees next.
    assert.equal(root().findAllByProps({ className: "wizard-progress" }).length, 1);
    assert.equal(root().findAllByProps({ className: "composer-model-pill" }).length, 0);
  } else if (scenario === "empty-catalog") {
    assertSetup();
    assert.ok(!calls.includes("GET /api/projects"), "existing history must not bypass the rendered setup gate");
    assert.ok(!JSON.stringify(renderer?.toJSON()).includes("Existing history"));
    data.models = [first];
    globalModel = first.id;
    // The entry page's model path delivers success through the actual
    // LoginPage -> App callback; no boot or selected-model state is injected.
    const configured = root().findByType(LoginPage).props.onModelConfigured;
    assert.ok(typeof configured === "function");
    data.projects = [];
    data.sessions = [];
    await act(async () => { await configured({}); });
    assertModel();
  } else if (scenario === "last-model") {
    assertModel();
    data.models = [];
    await act(async () => { fakeWindow.dispatchEvent(new Event("focus")); });
    assertSetup();
  } else if (scenario === "new-session") {
    assertModel();
    await click(root().findByProps({ className: "side-new" }));
    assert.ok(calls.includes("POST /api/projects/inbox/sessions"));
    assertModel();
  } else if (scenario === "new-project") {
    assertModel();
    // Exercise the real Composer -> App -> create-project API callback; the
    // separate naming dialog is unrelated to the model selection contract.
    const createProject = root().findByType(Composer).props.onCreateProject;
    assert.ok(typeof createProject === "function");
    await act(async () => { await createProject("Rendered project"); });
    assert.ok(calls.includes("POST /api/projects"));
    assert.equal(data.sessions[0]?.projectId, "new-project");
    assertModel();
  } else if (scenario === "sidebar-collapsed") {
    assertModel();
    // The stored fold survives the first render: the column is not there.
    assert.ok(shellClasses().includes("sidebar-hidden"), "a stored collapse must survive the first render");
    assert.equal(root().findAllByProps({ className: "side-new" }).length, 0);
    // The page head asks for the column back, which records the choice.
    await click(sidebarToggle(false));
    assert.ok(!shellClasses().includes("sidebar-hidden"));
    assert.equal(storage.get(SIDEBAR_STORAGE_KEY), "1");
    // Fold it again and render a fresh App: the refresh the issue reports.
    await click(sidebarToggle(true));
    assert.equal(storage.get(SIDEBAR_STORAGE_KEY), "0");
    await act(async () => { renderer?.unmount(); });
    await act(async () => { renderer = create(React.createElement(App, { initialToken: randomUUID() })); });
    assert.ok(shellClasses().includes("sidebar-hidden"), "a reload must not bring the folded column back");
  } else assert.fail(`Unknown scenario: ${scenario}`);
  assert.equal(fakeDocument.documentElement.lang, language);
  assert.deepEqual(unexpected, []);
} finally {
  await act(async () => { renderer?.unmount(); });
}
console.log(`Rendered ${scenario} in ${language}`);

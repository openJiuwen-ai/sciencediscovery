// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// One App-level journey for #1434: a sentence typed in a new session must not
// appear in the session the reader switches back to.
//
// The component suite pins the composer's ownership rule on its own; this
// script drives the shell that stamps `owner` and `surfaceKey` and the switch
// that mounts the next session's composer, which is where the two halves meet.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import React from "react";
import { DEFAULT_REVIEWER_SPECIALIST_LEVEL } from "@sciencediscovery/schema";
import { act, create, type ReactTestInstance } from "./dom-renderer.js";
import type { ModelProfile, Project, Session } from "../../src/api/types.js";
import { GUIDE_STORAGE_KEY, LOCALE_STORAGE_KEY } from "../../src/state/storage.js";

const COMMAND = "/idea-tree-team";
const SENTENCE = "这是一个测试";
const TITLE = "水处理材料研究";

const initialToken = randomUUID();
const storage = new Map<string, string>([[GUIDE_STORAGE_KEY, "1"], [LOCALE_STORAGE_KEY, "zh-CN"]]);
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

const now = new Date().toISOString();
const model: ModelProfile = {
  id: "alpha", name: "Alpha model", model: "alpha", baseUrl: "https://models.example.test/v1",
  createdAt: now, updatedAt: now, hasApiToken: true, proxyPolicy: "inherit", vision: false,
};
const inbox: Project = { id: "inbox", name: "Inbox", kind: "inbox", createdAt: now, remoteRunnerHostIds: [], settingsOverrides: {} };
function session(id: string, title: string): Session {
  return {
    id, projectId: "inbox", title, modelId: model.id, settingsOverrides: { modelId: model.id },
    createdAt: now, updatedAt: now, approvalMode: "ask_for_dangerous",
    permissionEpochId: randomUUID(), reviewerAutomaticReviewEnabled: true,
    reviewerSpecialistLevel: DEFAULT_REVIEWER_SPECIALIST_LEVEL,
    enabledConnectorIds: [], enabledSkillIds: [], reviewCriteria: [], reviewMode: "auto", semanticReviewEnabled: true,
  };
}
// The session the reader leaves: it has a transcript, so opening it draws the
// conversation composer rather than the welcome page.
const research = session("session-a", TITLE);
const sessions: Session[] = [research];
let next = 0;
const ideaTreeSettings = {
  templateId: "scientific-hypothesis-general/v1", explorationIntensity: "standard",
  maxTokens: 1_000_000, maxDepth: 3, maxNodes: 40, scoreDirection: "maximize",
};
const calls: string[] = [];
const unexpected: string[] = [];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), "http://render.example.test");
  const path = url.pathname;
  const method = init.method ?? "GET";
  calls.push(`${method} ${path}`);
  let result: unknown;
  const sessionSettings = { overrides: {}, effective: { modelId: model.id }, sources: {} };
  if (url.hostname === "api.github.com") result = { stargazers_count: 1 };
  else if (path === "/api/health") result = { status: "ok" };
  else if (path === "/api/models") result = [model];
  else if (path === "/api/providers") result = { providers: [], presets: [] };
  else if (path === "/api/specialists" || path === "/api/skills") result = [];
  else if (path === "/api/settings/idea-tree") result = ideaTreeSettings;
  else if (path === "/api/settings") result = { ...sessionSettings, overrides: { modelId: model.id } };
  else if (path === "/api/evolve/status") result = { state: "ready", canInitialize: false };
  else if (path === "/api/evolve/runs") result = [];
  else if (path === "/api/inbox") result = inbox;
  else if (path === "/api/projects") result = [inbox];
  else if (/^\/api\/projects\/[^/]+\/settings$/u.test(path)) result = sessionSettings;
  else if (/^\/api\/projects\/[^/]+\/sessions$/u.test(path)) {
    const projectId = path.split("/")[3];
    assert.ok(projectId);
    if (method === "POST") {
      next += 1;
      const created = session(`session-b${next}`, `Rendered session ${next}`);
      sessions.push(created);
      result = created;
    } else {
      result = sessions.filter(candidate => candidate.projectId === projectId);
    }
  } else if (/^\/api\/sessions\/[^/]+\/settings$/u.test(path)) result = sessionSettings;
  else if (/^\/api\/sessions\/[^/]+\/usage$/u.test(path)) {
    const sessionId = path.split("/")[3];
    const bucket = {
      key: "total", label: "Total", invocationCount: 0, reportedInvocationCount: 0, unreportedInvocationCount: 0,
      inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
    };
    result = { sessionId, totals: bucket, byRun: [], byModel: [], byInvocationKind: [], invocations: [] };
  } else if (/^\/api\/sessions\/[^/]+\/idea-tree\/research$/u.test(path)) result = { items: [] };
  else if (/^\/api\/sessions\/[^/]+\/idea-tree\/graph$/u.test(path)) result = { graph: null, hasIdeaTreeRun: false, treeIds: [] };
  else if (/^\/api\/sessions\/[^/]+\/(configuration-requests)$/u.test(path)) result = { items: [] };
  else if (/^\/api\/sessions\/[^/]+\/(artifact-reviews|reviewer-audit-tasks|files|runs|artifact-outputs)$/u.test(path)) result = [];
  else if (/^\/api\/sessions\/[^/]+\/reviewer-specialist\/settings$/u.test(path)) {
    result = { automaticReviewEnabled: true, level: DEFAULT_REVIEWER_SPECIALIST_LEVEL };
  } else if (path === "/api/reviewer-specialist/settings") result = { enabled: true, feedbackPolicy: "auto" };
  else if (/^\/api\/sessions\/[^/]+$/u.test(path)) {
    const sessionId = path.split("/")[3];
    const record = sessions.find(candidate => candidate.id === sessionId);
    assert.ok(record, `unknown session ${sessionId}`);
    result = {
      ...record,
      messages: record.id === research.id
        ? [{ id: "m1", role: "user", content: "keep exploring", createdAt: now }]
        : [],
    };
  } else {
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
async function click(node: ReactTestInstance) {
  const handler = node.props.onClick;
  assert.ok(typeof handler === "function");
  await act(async () => { await handler(); });
}
function composerField() {
  const fields = root().findAllByProps({ id: "composer-textarea" });
  assert.equal(fields.length, 1, "one composer is drawn");
  const field = fields[0];
  assert.ok(field);
  return field;
}
function tokenDrawn(): boolean {
  return root().findAllByProps({ className: "composer-command" }).length > 0;
}

try {
  await act(async () => { renderer = create(React.createElement(App, { initialToken })); });

  // 1. A new session, as 新增会话 makes it: an empty welcome page.
  await click(root().findByProps({ className: "side-new" }));
  const opened = sessions[1];
  assert.ok(opened, "the new session was created");

  // 2. Type the Idea Tree command and press Enter. Nothing is sent: the
  //    parameters card opens first.
  const change = composerField().props.onChange as (event: { target: { value: string } }) => void;
  await act(async () => { change({ target: { value: `${COMMAND} ${SENTENCE}` } }); });
  const keydown = composerField().props.onKeyDown as (event: {
    key: string; shiftKey: boolean; preventDefault: () => void;
  }) => void;
  await act(async () => { keydown({ key: "Enter", shiftKey: false, preventDefault() {} }); });

  // 3. Confirm the card. The draft it loaded is unedited and the session pins
  //    nothing, so confirming writes nothing and only seeds the command.
  const confirm = root().findAllByProps({ className: "evolve-create-submit" })[0];
  assert.ok(confirm, "the parameters card is open");
  await click(confirm);

  // The session that confirmed keeps the token and the sentence.
  assert.equal(composerField().props.value, SENTENCE, "the confirming session keeps the sentence");
  assert.equal(tokenDrawn(), true, "the confirming session keeps the token");

  // 4. Switch back to the session that was already open and has a transcript.
  const rows = root().findAllByProps({ className: "side-session" });
  const target = rows.find(node => text(node).includes(TITLE));
  assert.ok(target, "the first session is listed in the sidebar");
  await click(target);

  // 5. The sentence stayed where it was typed: this session's input is empty,
  //    and the token did not follow it either.
  assert.equal(composerField().props.value, "", "the opened session does not adopt the other session's sentence");
  assert.equal(tokenDrawn(), false, "the opened session draws no token");
  assert.deepEqual(unexpected, []);
} finally {
  await act(async () => { renderer?.unmount(); });
}
console.log("Journey: the confirming session kept the token, the opened session stayed empty");

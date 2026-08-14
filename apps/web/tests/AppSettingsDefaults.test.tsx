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

import assert from "node:assert/strict";
import test from "node:test";

import type { Project, Session, SessionDetail } from "@science-agent/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildCreateSessionRequest,
  followSessionTitleRefinement,
  getVisibleProjects,
  mergeRefreshedSessionDetail,
  mergeSessionDetailWithSummary,
  messageForSessionTitle,
  resourceLabelWithDraft,
  runSessionCreationOnce,
  SystemSettingsFooter,
  SystemSettingsLayout,
} from "../src/App.js";

test("new Session requests inherit settings unless a model override is explicit", () => {
  assert.deepEqual(buildCreateSessionRequest(""), {});
  assert.deepEqual(buildCreateSessionRequest("Inherited session"), {
    title: "Inherited session",
  });
  assert.deepEqual(buildCreateSessionRequest("Overridden session", { modelId: "model-1" }), {
    settingsOverrides: { modelId: "model-1" },
    title: "Overridden session",
  });
});

test("a failed Session creation restores pending state and blocks duplicate submissions", async () => {
  let inFlight = false;
  let createCalls = 0;
  const pendingStates: boolean[] = [];
  const errors: string[] = [];
  let rejectCreate: (reason: Error) => void = () => undefined;
  const create = () => {
    createCalls += 1;
    return new Promise<{ id: string }>((_resolve, reject) => { rejectCreate = reject; });
  };
  const options = {
    create,
    fallbackError: "Could not create session",
    isInFlight: () => inFlight,
    onCreated: () => undefined,
    onError: (message: string) => errors.push(message),
    setInFlight: (value: boolean) => { inFlight = value; },
    setPending: (value: boolean) => pendingStates.push(value),
  };

  const first = runSessionCreationOnce(options);
  const duplicate = await runSessionCreationOnce(options);
  assert.equal(duplicate, false);
  assert.equal(createCalls, 1);

  rejectCreate(new Error("A task model is required"));
  assert.equal(await first, true);
  assert.deepEqual(errors, ["A task model is required"]);
  assert.deepEqual(pendingStates, [true, false]);
  assert.equal(inFlight, false);
});

test("Session title input omits the web refresh command prefix", () => {
  assert.equal(messageForSessionTitle("/web-refresh search for recent TP53 papers"), "search for recent TP53 papers");
  assert.equal(messageForSessionTitle("compare TP53 cohorts"), "compare TP53 cohorts");
});

test("a refined title that arrives after the run stream closes is applied by bounded follow-up checks", async () => {
  const makeSession = (title: string): Session => ({
    approvalMode: "ask_for_dangerous",
    createdAt: "2026-07-30T01:00:00.000Z",
    enabledConnectorIds: [],
    enabledSkillIds: [],
    id: "session-1",
    permissionEpochId: "epoch-1",
    projectId: "project-1",
    reviewCriteria: [],
    reviewMode: "auto",
    semanticReviewEnabled: false,
    settingsOverrides: {},
    title,
    updatedAt: "2026-07-30T01:00:01.000Z",
  });
  const provisional = makeSession("Analyze TP53 expression");
  const refined = {
    ...makeSession("TP53 expression across treatment cohorts"),
    updatedAt: "2026-07-30T01:00:02.000Z",
  };
  const responses = [provisional, refined];
  const updates: Session[] = [];
  const waits: number[] = [];
  let loadAttempts = 0;
  let now = 1_000;

  const result = await followSessionTitleRefinement({
    loadSession: async () => {
      loadAttempts += 1;
      if (loadAttempts === 2) throw new Error("Transient refresh failure");
      return responses.shift() ?? refined;
    },
    now: () => now,
    offsetsMs: [0, 500, 1_500],
    onUpdate: (session) => updates.push(session),
    provisionalTitle: provisional.title,
    sessionId: provisional.id,
    startedAt: now,
    wait: async (delayMs) => {
      waits.push(delayMs);
      now += delayMs;
    },
  });

  assert.equal(result?.title, refined.title);
  assert.deepEqual(updates.map((session) => session.title), [refined.title]);
  assert.deepEqual(waits, [500, 1_000]);
  assert.equal(responses.length, 0);
});

test("a collapsed Projects panel keeps only the selected project visible", () => {
  const projects = [
    { createdAt: "2026-01-01T00:00:00.000Z", id: "project-1", name: "First", settingsOverrides: {} },
    { createdAt: "2026-01-02T00:00:00.000Z", id: "project-2", name: "Second", settingsOverrides: {} },
  ] satisfies Project[];

  assert.deepEqual(getVisibleProjects(projects, "project-2", false).map((project) => project.id), ["project-2"]);
  assert.deepEqual(getVisibleProjects(projects, "project-2", true).map((project) => project.id), ["project-1", "project-2"]);
});

test("an inline rename draft is shared only with the matching resource", () => {
  const target = { id: "session-1", kind: "session" as const };

  assert.equal(resourceLabelWithDraft(target, "Live draft", "session", "session-1", "Old title"), "Live draft");
  assert.equal(resourceLabelWithDraft(target, "Live draft", "session", "session-2", "Other title"), "Other title");
  assert.equal(resourceLabelWithDraft(target, "Live draft", "project", "session-1", "Project title"), "Project title");
  assert.equal(resourceLabelWithDraft(undefined, "Live draft", "session", "session-1", "Old title"), "Old title");
});

test("a newer Session summary wins over a stale detail refresh without dropping messages", () => {
  const staleDetail = {
    approvalMode: "ask_for_dangerous",
    createdAt: "2026-07-30T01:00:00.000Z",
    enabledConnectorIds: [],
    enabledSkillIds: [],
    id: "session-1",
    messages: [],
    permissionEpochId: "epoch-1",
    projectId: "project-1",
    reviewCriteria: [],
    reviewMode: "auto",
    semanticReviewEnabled: false,
    settingsOverrides: {},
    title: "Provisional local title",
    updatedAt: "2026-07-30T01:00:01.000Z",
  } satisfies SessionDetail;
  const refinedSummary = {
    ...staleDetail,
    title: "Refined scientific title",
    updatedAt: "2026-07-30T01:00:02.000Z",
  } satisfies SessionDetail;
  const { messages: _messages, ...summary } = refinedSummary;

  const merged = mergeRefreshedSessionDetail(staleDetail, 2, {
    revision: 3,
    summary: summary satisfies Session,
  });
  assert.equal(merged.title, "Refined scientific title");
  assert.equal(merged.updatedAt, "2026-07-30T01:00:02.000Z");
  assert.equal(merged.messages, staleDetail.messages);

  assert.equal(mergeRefreshedSessionDetail(staleDetail, 3, {
    revision: 3,
    summary,
  }), staleDetail);
  assert.equal(mergeRefreshedSessionDetail(staleDetail, 2, {
    revision: 3,
    summary: { ...summary, id: "session-2" },
  }), staleDetail);
  assert.equal(mergeRefreshedSessionDetail(staleDetail, 2, {
    revision: 3,
    summary: {
      ...summary,
      title: "Late old response",
      updatedAt: "2026-07-30T00:59:59.000Z",
    },
  }), staleDetail);
});

test("Session summary merge removes a cleared specialist selection", () => {
  const detail = {
    approvalMode: "ask_for_dangerous",
    createdAt: "2026-07-30T01:00:00.000Z",
    enabledConnectorIds: [],
    enabledSkillIds: [],
    id: "session-1",
    messages: [{ content: "hello", createdAt: "2026-07-30T01:00:01.000Z", id: "message-1", role: "user" }],
    permissionEpochId: "epoch-1",
    projectId: "project-1",
    reviewCriteria: [],
    reviewMode: "auto",
    semanticReviewEnabled: false,
    settingsOverrides: {},
    specialistId: "specialist-1",
    title: "Specialist session",
    updatedAt: "2026-07-30T01:00:01.000Z",
  } satisfies SessionDetail;
  const { messages: _messages, specialistId: _specialistId, ...summary } = detail;

  const merged = mergeSessionDetailWithSummary(detail, {
    ...summary,
    title: "Coordinator session",
    updatedAt: "2026-07-30T01:00:02.000Z",
  });

  assert.equal(merged.specialistId, undefined);
  assert.equal(merged.title, "Coordinator session");
  assert.equal(merged.messages, detail.messages);
});

test("renders System settings groups beside the selected details", () => {
  const html = renderToStaticMarkup(createElement(SystemSettingsLayout, {
    activeGroup: "models",
    children: createElement("p", null, "Selected details"),
    onSelect: () => undefined,
  }));

  assert.match(html, /class="system-config-layout"/);
  assert.match(html, /aria-label="Setting groups"/);
  assert.match(html, /Global defaults/);
  assert.match(html, />Timeouts</);
  assert.match(html, />Runtime status</);
  assert.match(html, />Environments</);
  assert.match(html, />Skills</);
  assert.match(html, />Specialists</);
  assert.match(html, />Remote compute</);
  assert.match(html, /aria-current="page" class="active"[^>]*>.*Model registry/);
  assert.match(html, /class="settings-group-detail"><p>Selected details<\/p>/);
});

test("renders the shared System settings commit and discard actions", () => {
  const html = renderToStaticMarkup(createElement(SystemSettingsFooter, {
    busy: false,
    onCancel: () => undefined,
    onSave: () => undefined,
    onSaveAndClose: () => undefined,
  }));

  assert.match(html, />Cancel and close</);
  assert.match(html, />Save</);
  assert.match(html, />Save and close</);
  assert.equal((html.match(/type="button"/g) ?? []).length, 3);
});

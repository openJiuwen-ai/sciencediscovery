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
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself is built with the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { SessionDetail } from "../src/api/types.js";
import type { WorkspaceActions } from "../src/app/use-workspace.js";
import { TEXT } from "../src/text.js";
import { SessionBar } from "../src/views/SessionBar.js";

const actions = {
  renameSession: async () => {},
} as unknown as WorkspaceActions;

function detail(over: Partial<SessionDetail> = {}): SessionDetail {
  return {
    createdAt: "2026-10-01T09:30:00.000Z",
    id: "session-1",
    projectId: "project-1",
    title: "晶体结构分析",
    updatedAt: "2026-10-01T09:30:00.000Z",
    ...over,
  } as SessionDetail;
}

function render(over: {
  detail?: SessionDetail;
  projectName?: string;
  sidebarCollapsed?: boolean;
  workspaceOpen?: boolean;
} = {}): string {
  return renderToStaticMarkup(
    <SessionBar
      actions={actions}
      detail={over.detail ?? detail()}
      onExpandSidebar={() => {}}
      onToggleWorkspace={() => {}}
      projectName={over.projectName ?? "材料项目"}
      sidebarCollapsed={over.sidebarCollapsed}
      workspaceOpen={over.workspaceOpen ?? false}
    />,
  );
}

test("the bar names the session, its project and the time it was last touched", () => {
  const markup = render();

  assert.match(markup, /class="task-head-title"[^>]*>晶体结构分析</);
  assert.ok(markup.includes("材料项目"));
  // The stamp is local time, so only its shape is stable across time zones.
  assert.match(markup, />\d{2}:\d{2}</);
  assert.match(markup, /title="晶体结构分析 · 双击改名"/);
  assert.equal((markup.match(/class="sep"/gu) ?? []).length, 1);
});

test("a session without a name is called 未命名会话, not the stored sentinel", () => {
  const markup = render({ detail: detail({ title: "Untitled session" }) });

  assert.ok(markup.includes(TEXT.sessionBar.untitled));
  assert.ok(!markup.includes("Untitled session"));
});

test("a draft carries the same 未命名会话 name the sidebar gives it, with neither rename nor a project", () => {
  const markup = renderToStaticMarkup(
    <SessionBar
      actions={actions}
      onToggleWorkspace={() => {}}
      workspaceOpen={false}
    />,
  );

  assert.ok(markup.includes(TEXT.sessionBar.untitled));
  assert.doesNotMatch(markup, /role="button"/);
  assert.doesNotMatch(markup, /双击改名/);
  assert.doesNotMatch(markup, /class="project"/);
  assert.match(markup, new RegExp(`aria-label="${TEXT.sessionBar.workspaceToggle}"`));
});

test("the panel control is drawn only while the panel is closed", () => {
  const closed = render({ workspaceOpen: false });
  const open = render({ workspaceOpen: true });

  assert.match(closed, new RegExp(`aria-label="${TEXT.sessionBar.workspaceToggle}"`));
  assert.doesNotMatch(open, new RegExp(`aria-label="${TEXT.sessionBar.workspaceToggle}"`));
});

test("a collapsed sidebar puts its way back at the start of the bar", () => {
  const markup = render({ sidebarCollapsed: true });

  assert.match(markup, new RegExp(`aria-label="${TEXT.sidebar.expandSidebar}"`));
  assert.match(markup, /class="icon-btn side-toggle"/);
});

test("an unreadable timestamp leaves the time out instead of printing Invalid Date", () => {
  const markup = render({ detail: detail({ createdAt: "not a date", updatedAt: "not a date" }) });

  assert.doesNotMatch(markup, /Invalid Date/);
  assert.ok(markup.includes("晶体结构分析"));
  // The separator is drawn unconditionally next to a stamp that may be empty,
  // so an unreadable timestamp leaves a dangling dot in the bar. Cosmetic, and
  // recorded as a defect in TEST-PLAN rather than papered over here.
  assert.match(markup, /class="sep"><\/span><span><\/span>/);
});

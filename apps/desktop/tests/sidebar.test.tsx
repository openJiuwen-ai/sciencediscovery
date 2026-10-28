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
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkspaceActions } from "../src/app/use-workspace.js";
import { Sidebar } from "../src/views/Sidebar.js";

const actions = { openSession: async () => {}, newSession: () => {}, createProject: async () => {} } as unknown as WorkspaceActions;

function session(id: string, title: string, updatedAt = "2026-01-01T00:00:00.000Z", projectId = "inbox") {
  return { id, projectId, title, updatedAt } as never;
}

function project(id: string, name: string) {
  return { createdAt: "2026-01-01T00:00:00.000Z", id, name } as never;
}

function render(over: Partial<Parameters<typeof Sidebar>[0]> = {}): string {
  return renderToStaticMarkup(
    <Sidebar actions={actions} projects={[]} recent={[]} sessionsByProject={{}} {...over} />,
  );
}

test("the column lists the projects first and the conversations outside them last", () => {
  const markup = render({
    projects: [project("p1", "脓毒症研究")],
    recent: [session("s1", "结构比对")],
    sessionsByProject: { p1: [session("s2", "文献综述", "2026-01-02T00:00:00.000Z", "p1")] },
  });
  // 项目 leads with the fold and its own session; 最近会话 holds the standalone
  // conversation last. A Project's sessions never appear in 最近会话, and the
  // inbox's never appear under a Project — that separation is the feature.
  const projectLabel = markup.indexOf(">项目<");
  const fold = markup.indexOf("side-row side-project");
  const own = markup.indexOf("文献综述");
  const recentLabel = markup.indexOf("最近会话");
  const standalone = markup.indexOf("结构比对");
  assert.ok(projectLabel >= 0 && recentLabel >= 0, "a section label is missing");
  assert.ok(projectLabel < fold && fold < own, "the projects do not lead");
  assert.ok(own < recentLabel, "最近会话 is not below the projects");
  assert.ok(recentLabel < standalone, "the standalone session is not under 最近会话");
});

test("a project lists its sessions most recently used first", () => {
  const markup = render({
    projects: [project("p1", "脓毒症研究")],
    sessionsByProject: {
      p1: [
        session("old", "较早的会话", "2026-01-02T00:00:00.000Z", "p1"),
        session("new", "较新的会话", "2026-01-03T00:00:00.000Z", "p1"),
      ],
    },
  });
  assert.ok(markup.indexOf("较新的会话") < markup.indexOf("较早的会话"));
});

test("the task column has no search field under 新建会话", () => {
  const markup = render({ recent: [session("s1", "结构比对")] });
  assert.doesNotMatch(markup, /side-search/);
  assert.doesNotMatch(markup, /type="search"/);
});

test("a session row carries the double-click rename as its own tooltip", () => {
  const markup = render({ recent: [session("s1", "结构比对")] });
  assert.match(markup, /title="结构比对 · 双击改名"/);
});

test("every project row can start a session inside itself", () => {
  const markup = render({ projects: [project("p1", "脓毒症研究")] });
  // The name is in the label because a column of identical `+` buttons would
  // not say which Project each one starts a session in.
  assert.match(markup, /aria-label="在「脓毒症研究」中新建会话"/);
  assert.match(markup, />新建会话</);
});

test("the projects section offers a way to make one", () => {
  const markup = render();
  assert.match(markup, /title="新建项目"/);
  assert.match(markup, /side-label side-label-row/);
});

test("a project with nothing in it is quiet, and each empty section says so once", () => {
  const markup = render({ projects: [project("p1", "脓毒症研究")] });
  assert.equal(markup.split("还没有最近会话").length - 1, 1);
  // The fold has no sessions of its own; that is the only 暂无会话 left, now
  // that the 会话 section it used to share the sentence with is gone.
  assert.equal(markup.split("暂无会话").length - 1, 1);
  assert.doesNotMatch(markup, /还没有项目/);
  assert.doesNotMatch(markup, /暂无任务/);
});

test("a column with no projects says so instead of showing an empty fold", () => {
  const markup = render();
  assert.equal(markup.split("还没有项目").length - 1, 1);
  assert.equal(markup.split("还没有最近会话").length - 1, 1);
  assert.doesNotMatch(markup, /side-row side-project/);
});

test("the running session is marked on its own row, not in a section of its own", () => {
  const markup = render({
    activeSessionId: "s1",
    recent: [session("s1", "结构比对"), session("s2", "文献综述")],
    running: true,
  });
  // One row, one spinner: the run belongs to the Session the user is looking
  // at, and 最近会话 now sits where the old 会话 section used to.
  assert.equal(markup.split("side-spinner").length - 1, 1);
  assert.doesNotMatch(markup, /side-task-row/);
  const active = markup.indexOf('class="side-row side-sub is-active"');
  const spinner = markup.indexOf("side-spinner");
  assert.ok(active < spinner, "the spinner is not inside the running session's row");
  // The idle row after it carries none.
  assert.ok(spinner < markup.indexOf("文献综述"));
});

test("a session the service still calls untitled reads in the interface language", () => {
  const markup = render({ recent: [session("s1", "Untitled session")] });
  assert.match(markup, /未命名会话/);
  assert.doesNotMatch(markup, /Untitled session/);
});

test("the active session is the only row marked active", () => {
  const markup = render({
    activeSessionId: "s2",
    recent: [session("s1", "结构比对"), session("s2", "文献综述")],
  });
  assert.equal(markup.split('class="side-row side-sub is-active"').length - 1, 1);
});

test("the project the open session belongs to is the only fold marked active", () => {
  const markup = render({
    activeProjectId: "p2",
    projects: [project("p1", "脓毒症研究"), project("p2", "文献综述")],
  });
  assert.equal(markup.split("side-project is-open is-active").length - 1, 1);
});

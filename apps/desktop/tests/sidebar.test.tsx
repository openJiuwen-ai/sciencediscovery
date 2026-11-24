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
import { EN } from "../src/text/en.js";
import { DEFAULT_SESSION_FILTERS } from "../src/app/session-filters.js";
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
  // 项目 leads with the fold and its own session; 会话 holds the standalone
  // conversation last. A Project's sessions never appear in 会话, and the
  // inbox's never appear under a Project — that separation is the feature.
  const projectLabel = markup.indexOf(">项目<");
  const fold = markup.indexOf("side-row side-project");
  const own = markup.indexOf("文献综述");
  const recentLabel = markup.indexOf('side-label-spaced">会话<');
  const standalone = markup.indexOf("结构比对");
  assert.ok(projectLabel >= 0 && recentLabel >= 0, "a section label is missing");
  assert.ok(projectLabel < fold && fold < own, "the projects do not lead");
  assert.ok(own < recentLabel, "the 会话 section is not below the projects");
  assert.ok(recentLabel < standalone, "the standalone session is not under the 会话 section");
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

function hit(kind: "project" | "session" | "artifact", label: string, over: Record<string, unknown> = {}) {
  return { detail: "", id: `${kind}-1`, kind, label, projectId: "p1", ...over };
}

function results(list: unknown[], over: Record<string, unknown> = {}) {
  return { hasMore: false, limit: 20, offset: 0, results: list, total: list.length, ...over } as never;
}

test("results are drawn in the fixed 项目 → 会话 → 产物 order, with an archived row marked", () => {
  const markup = render({
    onSearch: () => {},
    searchQuery: "本周",
    searchResults: results([
      hit("artifact", "figure.png", { projectName: "材料", sessionId: "s9", sessionTitle: "本周实验" }),
      hit("session", "本周实验", { archived: true, projectName: "材料" }),
      hit("project", "材料"),
    ]),
  });
  // The headings are the ones inside the results block, not the column's own
  // 项目 / 会话 section labels.
  const heading = (name: string) => markup.indexOf(`side-search-heading">${name}<`);
  const [project, session, artifact] = [heading("项目"), heading("会话"), heading("产物")];
  assert.ok(project >= 0 && session >= 0 && artifact >= 0, "a result group is missing");
  assert.ok(project < session && session < artifact, "the groups are not in 项目 → 会话 → 产物 order");

  assert.match(markup, /side-search-badge">已归档</u, "the archived row carries the badge");
  assert.match(markup, /本周实验/u, "a result label is drawn");
  assert.match(markup, /材料 · 本周实验/u, "the artifact's detail names its Project and Session");
});

test("an empty answer, a failure and the rest of the list each say their own thing", () => {
  const empty = render({ onSearch: () => {}, searchQuery: "晶", searchResults: results([]) });
  assert.match(empty, /没有匹配「晶」/u);
  assert.match(empty, /名称与标题/u, "the empty state says what is searched, where the caption used to");

  const failed = render({ onSearch: () => {}, searchError: "boom", searchQuery: "晶", searchResults: undefined });
  assert.match(failed, /class="side-search-note is-error" role="alert">boom</u);

  const more = render({ onSearch: () => {}, searchQuery: "晶", searchResults: results([hit("project", "材料")], { hasMore: true, total: 41 }) });
  assert.match(more, /还有 41 条结果/u);
});

test("a column with no workspace draws no results either", () => {
  const markup = render({ searchQuery: "晶", searchResults: results([hit("project", "材料")]) });
  assert.doesNotMatch(markup, /side-search-results/, "no field means no list under it");
});

test("the search field names only itself, with no caption under it", () => {
  const markup = render({ onSearch: () => {}, searchQuery: "" });
  const from = markup.indexOf('class="side-search-field"');
  assert.ok(from >= 0, "the field is missing");
  // From the start of the tag, so the attributes written before the class name
  // (aria-label) are in view as well.
  const start = markup.lastIndexOf("<input", from);
  const tag = markup.slice(start, markup.indexOf(">", from) + 1);
  // One word, the field's own name — not a sentence about what a search box does.
  assert.match(tag, /placeholder="搜索"/u);
  assert.match(tag, /aria-label="搜索"/u, "it is still named for a screen reader");
  assert.doesNotMatch(tag, /title=/, "the removed caption does not come back as a tooltip");
  assert.doesNotMatch(markup, /side-search-hint/, "no explanatory caption is drawn under the field");
  assert.equal(EN.sidebar.searchPlaceholder, "Search", "and the English field is one word too");
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

test("a project row offers rename and delete, like a session does", () => {
  // A Project is the user's own container: it can be renamed and removed whole.
  // Both live in the row's `⋯`, the same two items a session row carries, and
  // the double-click gesture is announced the same way.
  const markup = render({ projects: [project("p1", "脓毒症研究")] });
  assert.match(markup, /title="脓毒症研究 · 双击改名"/u);
  assert.match(markup, /aria-label="项目菜单"/u);
  assert.match(markup, /在「脓毒症研究」中新建会话/u);
});

test("the projects section offers a way to make one", () => {
  const markup = render();
  assert.match(markup, /title="新建项目"/);
  assert.match(markup, /side-label side-label-row/);
});

test("a project with nothing in it is quiet, and each empty section says so once", () => {
  const markup = render({ projects: [project("p1", "脓毒症研究")] });
  assert.equal(markup.split("还没有会话").length - 1, 1);
  // The fold has no sessions of its own; that is the only 暂无会话 left.
  assert.equal(markup.split("暂无会话").length - 1, 1);
  assert.doesNotMatch(markup, /还没有项目/);
  assert.doesNotMatch(markup, /暂无任务/);
});

test("a column with no projects says so instead of showing an empty fold", () => {
  const markup = render();
  assert.equal(markup.split("还没有项目").length - 1, 1);
  assert.equal(markup.split("还没有会话").length - 1, 1);
  assert.doesNotMatch(markup, /side-row side-project/);
});

test("the running session is marked on its own row, not in a section of its own", () => {
  const markup = render({
    activeSessionId: "s1",
    recent: [session("s1", "结构比对"), session("s2", "文献综述")],
    running: true,
  });
  // One row, one spinner: the run belongs to the Session the user is looking
  // at, not to a section of its own.
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

test("a filter that hides every row says so instead of reading as an empty workspace", () => {
  // 仅运行中 with nothing running: every row is gone, and "暂无会话" would be a
  // claim about the workspace rather than about the filter.
  const markup = render({
    listFilters: { ...DEFAULT_SESSION_FILTERS, onlyRunning: true },
    projects: [project("p1", "项目一")],
    sessionsByProject: { p1: [session("s1", "会话一")] },
  });
  assert.ok(markup.includes("没有符合筛选条件的会话。"), "the narrowed empty state is missing");
  assert.ok(!markup.includes("暂无会话"), "the list read as an empty workspace under a filter");
  assert.equal(EN.sidebar.noMatch, "No Session matches the current filter.");
});

test("仅当前项目 hides the other folds instead of emptying them", () => {
  const markup = render({
    activeProjectId: "p1",
    listFilters: { ...DEFAULT_SESSION_FILTERS, scope: "current" },
    projects: [project("p1", "项目一"), project("p2", "项目二")],
    sessionsByProject: { p1: [session("s1", "会话一")], p2: [session("s2", "会话二")] },
  });
  assert.ok(markup.includes("项目一"), "the current Project's fold is missing");
  assert.ok(!markup.includes("项目二"), "an excluded Project was drawn as a fold");
});

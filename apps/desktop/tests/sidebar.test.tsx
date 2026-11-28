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
import { readFileSync } from "node:fs";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkspaceActions } from "../src/app/use-workspace.js";
import { EN } from "../src/text/en.js";
import { Sidebar } from "../src/views/Sidebar.js";

import { act, create } from "./support/dom-renderer.js";
import type { ReactTestRenderer } from "./support/dom-renderer.js";

// `act` states its warnings only when the environment says it may be used; the
// interaction case below mounts a real renderer, so the flag goes on here.
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

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

test("the title row carries the 搜索 magnifier, and the column spends no row on it", () => {
  const markup = render({ onSearch: () => {}, recent: [session("s1", "结构比对")] });
  const button = markup.indexOf('class="side-head-button"');
  assert.ok(button >= 0, "the magnifier is missing from the title row");
  assert.match(markup.slice(Math.max(0, button - 240), button + 240), /aria-label="搜索"/u, "it is named for a screen reader");
  assert.doesNotMatch(markup, /side-search-entry/, "the old 搜索 row is gone");
  assert.doesNotMatch(markup, /type="search"/, "and no field is drawn in the column at all");
  assert.doesNotMatch(markup, /search-panel/, "the dialog is not part of the resting markup");

  // A column rendered without a workspace has nothing to search.
  const bare = render({ recent: [session("s1", "结构比对")] });
  assert.doesNotMatch(bare, /side-head-button/);
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

test("the section labels take a row title's size, not its weight, in the muted colour", () => {
  // 项目 and 会话 are headings over the rows they name, so they are no longer set
  // smaller than those rows: the same 14px a Project or Session title takes. They
  // stay regular rather than bold — the headings are a quiet caption over the
  // list, and the eye should land on the Project and Session names first.
  // Comments are stripped first: a comment line would otherwise be swallowed
  // into the next rule's selector list by the matcher below.
  const css = readFileSync(new URL("../src/styles/design.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  const rule = (selector: string) => {
    // The selector may sit anywhere in a comma list, so match it as a whole
    // selector line and return the block that list opens.
    for (const match of css.matchAll(/^([^{}\n][^{}]*?)\{([^{}]*)\}/gmu)) {
      const selectors = match[1]!.split(",").map((part) => part.trim());
      if (selectors.includes(selector)) return `${match[1]}{${match[2]}}`;
    }
    assert.fail(`${selector} has no rule in design.css`);
  };
  const size = (block: string) => /font-size: ([\d.]+)px;/.exec(block)?.[1];
  const label = rule(".side-label");
  assert.equal(size(label), "14");
  assert.equal(size(label), size(rule(".side-project")));
  assert.equal(size(label), size(rule(".side-session")));
  assert.match(label, /font-weight: 400;/);
  assert.match(label, /color: #777;/);
  // The `+` beside 项目 is the label's own size and weight, so it reads as a mark
  // on the heading rather than as a louder control beside it.
  const add = rule(".side-label-row .side-mini-button.is-add");
  assert.equal(size(add), "14");
  assert.match(add, /font-weight: 400;/);
  // 新建项目 waits out of the way until the heading is pointed at, and comes
  // back for the keyboard too: `opacity` keeps it in the tab order, where
  // `display: none` would not.
  assert.match(add, /opacity: 0;/);
  assert.doesNotMatch(add, /display: none;|visibility: hidden;/);
  assert.match(rule(".side-label-row:hover .side-mini-button.is-add"), /opacity: 1;/);
  assert.match(rule(".side-label-row:focus-within .side-mini-button.is-add"), /opacity: 1;/);
  assert.match(rule(".side-label-row .side-mini-button.is-add:focus-visible"), /opacity: 1;/);
});

test("a row's own actions wait for the pointer, on Project rows and Session rows alike", () => {
  // A Project's 在项目中新建会话 `+` and its `⋯`, and a Session's `⋯`, stand beside
  // the name only while the row is under the pointer or holds keyboard focus —
  // including the row of the open Project and of the active Session.
  // Comments are stripped first: a comment line would otherwise be swallowed
  // into the next rule's selector list by the matcher below.
  const css = readFileSync(new URL("../src/styles/design.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  const rule = (selector: string) => {
    for (const match of css.matchAll(/^([^{}\n][^{}]*?)\{([^{}]*)\}/gmu)) {
      const selectors = match[1]!.split(",").map((part) => part.trim());
      if (selectors.includes(selector)) return `${match[1]}{${match[2]}}`;
    }
    assert.fail(`${selector} has no rule in design.css`);
  };
  const actions = rule(".side-row.side-sub .side-actions");
  assert.match(actions, /opacity: 0;/);
  assert.match(actions, /pointer-events: none;/);
  assert.doesNotMatch(actions, /display: none;|visibility: hidden;/);
  // They float over the row's right end instead of holding width in it, so the
  // name keeps its full width at rest and does not re-truncate on hover.
  assert.match(actions, /position: absolute;/);
  assert.match(rule(".side-row.side-sub:hover .side-actions"), /opacity: 1;/);
  assert.match(rule(".side-row.side-sub:focus-within .side-actions"), /opacity: 1;/);
  assert.match(rule(".side-row.side-project:hover .side-actions"), /opacity: 1;/);
  assert.match(rule(".side-row.side-project:focus-within .side-actions"), /opacity: 1;/);
  // Neither the open Project nor the active Session keeps its controls out.
  assert.doesNotMatch(css, /\.side-project\.is-active[^{]*\.side-actions/);
  assert.doesNotMatch(css, /\.side-sub\.is-active[^{]*\.side-actions/);
  // The strip floats over the last 50px of a Project's name, so the same reveal
  // that shows it masks that band out: the name must not be read through two
  // transparent buttons. A mask moves no glyph, so the name does not
  // re-truncate on hover the way a wider `padding-right` would.
  for (const selector of [
    ".side-row.side-project:hover .side-project-toggle .label",
    ".side-row.side-project:focus-within .side-project-toggle .label",
  ]) {
    const mask = rule(selector);
    assert.match(mask, /mask-image: linear-gradient\(to right/u);
    assert.match(mask, /transparent calc\(100% - 50px\)/u);
  }
});

test("a device that cannot hover is shown the row controls without one", () => {
  // A touch screen has no pointer to wait for, so the controls a reader there
  // could never summon are simply shown: the first tap then lands on the
  // control it can see rather than only on the row underneath it.
  // Comments are stripped first: a comment line would otherwise be swallowed
  // into the next rule's selector list by the matcher below.
  const css = readFileSync(new URL("../src/styles/design.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  const media = /@media \(hover: none\) \{([\s\S]*?)\n\}/u.exec(css);
  assert.ok(media, "design.css has no no-hover fallback");
  const block = media[1]!;
  for (const selector of [
    ".side-label-row .side-mini-button.is-add",
    ".side-row.side-project .side-actions",
    ".side-row.side-sub .side-actions",
  ]) {
    assert.ok(block.includes(selector), `${selector} is not shown without a hover`);
  }
  assert.match(block, /opacity: 1;/u);
  assert.match(block, /pointer-events: auto;/u);
});

test("a project's name is its own fold control, with no chevron beside it", () => {
  // The fold is the name: `aria-expanded` on the name's button says whether the
  // Project's sessions are showing, and pressing the name folds or unfolds
  // them. A `^`/`v` glyph beside it would say the same thing a second time.
  const markup = render({ projects: [project("p1", "脓毒症研究")], sessionsByProject: { p1: [session("s1", "文献综述", undefined, "p1")] } });
  assert.match(markup, /<button aria-expanded="true" class="side-project-toggle"/);
  assert.doesNotMatch(markup, /class="chev"/);
});

test("pressing a project's name folds and unfolds its sessions, and aria-expanded follows", async () => {
  // The name is a real `<button type="button">`, so Enter and Space activate it
  // the way the browser activates any button — the test presses the handler the
  // browser presses, and reads whether the sessions and the state move with it.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false })) as unknown as typeof fetch;
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <Sidebar
          actions={actions}
          projects={[project("p1", "脓毒症研究")]}
          recent={[]}
          sessionsByProject={{ p1: [session("s1", "文献综述", undefined, "p1")] }}
        />,
      );
    });
    const fold = () => {
      const button = renderer!.root.findAllByType("button").find((node) => node.props.className === "side-project-toggle");
      assert.ok(button, "the project name is not a button");
      assert.equal(button.props.type, "button");
      return button;
    };
    const drawn = () => JSON.stringify(renderer!.toJSON());
    assert.equal(fold().props["aria-expanded"], true);
    assert.ok(drawn().includes("文献综述"), "the open Project does not list its session");
    await act(async () => { fold().props.onClick(); });
    assert.equal(fold().props["aria-expanded"], false);
    assert.ok(!drawn().includes("文献综述"), "the folded Project still lists its session");
    await act(async () => { fold().props.onClick(); });
    assert.equal(fold().props["aria-expanded"], true);
    assert.ok(drawn().includes("文献综述"), "the Project did not unfold");
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.fetch = realFetch;
  }
});

test("the project the open session belongs to is the only fold marked active", () => {
  const markup = render({
    activeProjectId: "p2",
    projects: [project("p1", "脓毒症研究"), project("p2", "文献综述")],
  });
  assert.equal(markup.split("side-project is-open is-active").length - 1, 1);
});

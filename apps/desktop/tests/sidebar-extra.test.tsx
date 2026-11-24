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
const { afterEach, describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Session } from "../src/api/types.js";
import type { WorkspaceActions } from "../src/app/use-workspace.js";
import { setLanguage, TEXT } from "../src/text.js";
import { Sidebar, stamp } from "../src/views/Sidebar.js";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The store is module state: every case leaves the default language behind for
// the next file the runner loads.
afterEach(() => setLanguage("zh-CN"));

const actions = {
  deleteSession: () => {},
  openSession: async () => {},
  renameSession: async () => {},
} as unknown as WorkspaceActions;

function session(id: string, title: string, updatedAt?: string) {
  return { createdAt: updatedAt, id, title, updatedAt } as never;
}

function project(id: string, name: string) {
  return { createdAt: "2026-10-01T08:00:00.000Z", id, name, updatedAt: "2026-10-01T08:00:00.000Z" } as never;
}

function render(over: Partial<Parameters<typeof Sidebar>[0]> = {}): string {
  return renderToStaticMarkup(
    <Sidebar
      actions={actions}
      projects={[]}
      recent={[]}
      sessionsByProject={{}}
      {...over}
    />,
  );
}

/** A local wall-clock instant N calendar days before today, so the assertion
 *  does not depend on the hour the suite happens to run. */
function localDaysAgo(days: number, hour: number, minute = 0): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function sessionAt(time: number) {
  const iso = new Date(time).toISOString();
  return { createdAt: iso, updatedAt: iso };
}

function clock(time: number): string {
  return new Date(time).toLocaleTimeString(TEXT.languageTag, { hour: "2-digit", minute: "2-digit" });
}

/**
 * A mounted column, so the fold can be pressed rather than only read.
 *
 * `useGithubStars` would otherwise ask GitHub's public API on mount; a cache
 * entry that is still fresh makes it read the stored number instead, which
 * keeps this file off the network.
 */
async function mount(over: Partial<Parameters<typeof Sidebar>[0]> = {}): Promise<ReactTestRenderer> {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(globals, "localStorage");
  const stored = new Map<string, string>([
    ["sciencediscovery-desktop:github-stars", JSON.stringify({ at: Date.now(), count: 42 })],
  ]);
  Object.defineProperty(globals, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    },
  });
  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      view = create(
        <Sidebar actions={actions} projects={[]} recent={[]} sessionsByProject={{}} {...over} />,
      );
    });
  } finally {
    if (previous === undefined) delete globals.localStorage;
    else Object.defineProperty(globals, "localStorage", previous);
  }
  return view!;
}

/** The titles the column actually rendered, in reading order. */
function rowTitles(view: ReactTestRenderer): string[] {
  return view.root
    .findAllByProps({ className: "side-session-name" })
    .map((node) => node.props.children as string);
}

function moreButtons(view: ReactTestRenderer) {
  return view.root.findAllByProps({ className: "side-more" });
}

/** Sessions a minute apart, so 「more recently used」 is unambiguous. */
function recentSessions(count: number, from = 0): Session[] {
  return Array.from({ length: count }, (_, index) =>
    session(
      `s${from + index}`,
      `会话${from + index + 1}`,
      new Date(Date.UTC(2026, 0, 1, 0, 0, from + index)).toISOString(),
    ) as Session,
  );
}

describe("the session column's dates", () => {
  it("reads a session from today as a clock time and one from three days ago as days", () => {
    const recent = localDaysAgo(0, 10);
    const older = localDaysAgo(3, 12);
    const markup = render({
      recent: [session("s1", "今天", recent), session("s2", "几天前", older)],
    });

    assert.ok(markup.includes(TEXT.workspace.daysAgo(3)));
    // A recent row has a time, not a relative sentence.
    assert.ok(!markup.includes(TEXT.workspace.daysAgo(0)));
  });

  it("renders yesterday as 昨天 instead of repeating its clock time", () => {
    const yesterday = localDaysAgo(1, 22);
    // A neutral title keeps the assertion about the stamp: a title containing
    // 昨天 would make the positive half pass even with an empty stamp span.
    const markup = render({ recent: [session("s1", "会话 A", yesterday)] });

    assert.ok(markup.includes(`>${TEXT.workspace.yesterday}<`));
    // Regression for #1400: at most hours of the day this was the bare clock,
    // indistinguishable from a Session used at 22:00 today.
    assert.ok(!markup.includes(`>${clock(Date.parse(yesterday))}<`));
  });

  it("switches to weeks after the first seven days", () => {
    const older = localDaysAgo(10, 12);
    const markup = render({ recent: [session("s1", "上周", older)] });

    assert.ok(markup.includes(TEXT.workspace.weeksAgo(1)));
  });
});

describe("the session stamp's calendar-day boundaries", () => {
  // A fixed local evening makes the #1400 boundary exact: yesterday 22:00 is
  // only 22 hours old, yet belongs to a different calendar day.
  const now = new Date(2026, 10, 25, 20, 0, 0, 0).getTime();
  const at = (day: number, hour: number, minute = 0) =>
    new Date(2026, 10, day, hour, minute, 0, 0).getTime();

  it("keeps today's HH:MM and labels yesterday", () => {
    assert.equal(stamp(sessionAt(at(25, 15, 46)), now), clock(at(25, 15, 46)));
    assert.equal(stamp(sessionAt(at(24, 22)), now), TEXT.workspace.yesterday);
  });

  it("counts days from local midnight rather than elapsed hours", () => {
    assert.equal(stamp(sessionAt(at(24, 23, 55)), now), TEXT.workspace.yesterday);
    assert.equal(stamp(sessionAt(at(23, 0, 5)), now), TEXT.workspace.daysAgo(2));
    assert.equal(stamp(sessionAt(at(19, 23, 55)), now), TEXT.workspace.daysAgo(6));
  });

  it("switches to weeks on the seventh calendar day", () => {
    assert.equal(stamp(sessionAt(at(18, 23, 55)), now), TEXT.workspace.weeksAgo(1));
    assert.equal(stamp(sessionAt(at(11, 0, 5)), now), TEXT.workspace.weeksAgo(2));
  });

  it("leaves an invalid timestamp blank", () => {
    assert.equal(stamp({ createdAt: "not a date", updatedAt: "not a date" }), "");
  });
});

describe("the session column's length", () => {
  it("shows six rows and offers the counted fold only when there are more", () => {
    const six = recentSessions(6);
    const seven = recentSessions(7);

    const short = render({ recent: six });
    assert.equal(short.split('class="side-session-name"').length - 1, 6);
    assert.ok(!short.includes('class="side-more"'));

    const long = render({ recent: seven });
    assert.equal(long.split('class="side-session-name"').length - 1, 6);
    // The control names the one row behind it, not a bare 显示更多.
    assert.ok(long.includes("显示更早的 1 个会话"));
    assert.ok(!long.includes("会话1"), "the seventh row was rendered before the fold");
  });
});

/**
 * Issue #1348: a folded tail with no count reads as Sessions that were deleted.
 * These cases pin the count to the rows actually held back, and pin the two
 * rows the fold must never take away: the most recent page and the open one.
 */
describe("the fold's count", () => {
  it("says how many older Sessions are hidden and reveals exactly those", async () => {
    const view = await mount({ recent: recentSessions(16) });

    // The first page is the newest six, in order: the fold never hides a more
    // recently used Session behind an older one.
    assert.deepEqual(rowTitles(view), recentSessions(16).map((entry) => entry.title).reverse().slice(0, 6));
    const [more] = moreButtons(view);
    assert.ok(more, "the fold is missing");
    assert.equal(more.props.children, "显示更早的 10 个会话");

    await act(async () => { (more.props.onClick as () => void)(); });

    const titles = rowTitles(view);
    assert.equal(titles.length, 16);
    // Expansion is the whole list in recency order, not a second page that
    // reorders what is already on screen.
    assert.deepEqual(titles, recentSessions(16).map((entry) => entry.title).reverse());
    assert.equal(moreButtons(view).length, 0, "the control is still offered with nothing behind it");
  });

  it("turns the Issue's 19 visible rows into 29 in one press", async () => {
    const projects = [project("p1", "示例项目"), project("p2", "文献项目"), project("p3", "单条项目")];
    const view = await mount({
      projects,
      recent: recentSessions(6),
      sessionsByProject: {
        p1: recentSessions(16, 100),
        p2: recentSessions(6, 200),
        p3: recentSessions(1, 300),
      },
    });

    // 6 (p1) + 6 (p2) + 1 (p3) + 6 (会话) = 19, exactly the Issue's before shot.
    assert.equal(rowTitles(view).length, 19);
    const [more] = moreButtons(view);
    assert.equal(more?.props.children, "显示更早的 10 个会话");

    await act(async () => { (more!.props.onClick as () => void)(); });

    assert.equal(rowTitles(view).length, 29, "the press did not add the ten rows it named");
    assert.equal(moreButtons(view).length, 0);
  });

  it("keeps the open Session on screen when it is past the first page", async () => {
    const sessions = recentSessions(10);
    // The oldest row sorts last, so it is the one a first page would hold back.
    const oldest = sessions[0]!;
    const view = await mount({ activeSessionId: oldest.id, recent: sessions });

    const titles = rowTitles(view);
    // The first page, plus the row the reader is looking at — never six rows
    // with the open one folded away, and never a newer row pushed out to make
    // room for it.
    assert.equal(titles.length, 7);
    assert.ok(titles.includes(oldest.title), "the open Session is behind the fold");
    assert.deepEqual(titles.slice(0, 6), recentSessions(10).map((entry) => entry.title).reverse().slice(0, 6));
    const [more] = moreButtons(view);
    assert.equal(more?.props.children, "显示更早的 3 个会话");

    await act(async () => { (more!.props.onClick as () => void)(); });
    assert.deepEqual(rowTitles(view), recentSessions(10).map((entry) => entry.title).reverse());
  });

  it("offers no control when the open Session is the only row past the page", async () => {
    const sessions = recentSessions(7);
    const view = await mount({ activeSessionId: sessions[0]!.id, recent: sessions });

    assert.equal(rowTitles(view).length, 7);
    assert.equal(moreButtons(view).length, 0, "a control with nothing behind it would say 0 older Sessions");
  });

  it("states each Project's fold rule, from the page size rather than a literal", () => {
    const markup = render({
      projects: [project("p1", "示例项目"), project("p2", "文献项目"), project("p3", "单页项目")],
      sessionsByProject: {
        p1: recentSessions(8, 100),
        p2: recentSessions(7, 200),
        p3: recentSessions(6, 300),
      },
    });

    // 6 is PAGE_SIZE: each folded Project says how many are shown before the
    // cut, so the page size is visible instead of a missing tail. The Project
    // whose whole list fits states no rule, because nothing is held back.
    assert.equal(markup.split('class="side-project-rule"').length - 1, 2);
    assert.equal(markup.split(TEXT.sidebar.pageRule(6)).length - 1, 2);
    assert.equal(markup.split("最近 6 个").length - 1, 2);
  });

  it("drops the fold rule once the whole list is shown", async () => {
    const view = await mount({
      projects: [project("p1", "示例项目")],
      sessionsByProject: { p1: recentSessions(8, 100) },
    });

    assert.equal(view.root.findAllByProps({ className: "side-project-rule" }).length, 1);
    const [more] = moreButtons(view);
    await act(async () => { (more!.props.onClick as () => void)(); });
    assert.equal(view.root.findAllByProps({ className: "side-project-rule" }).length, 0);
  });

  it("speaks English with the same computed count", async () => {
    setLanguage("en");
    const view = await mount({
      projects: [project("p1", "Sample project")],
      sessionsByProject: { p1: recentSessions(8, 100) },
    });

    // 8 sessions: six shown, two older ones held back.
    const [more] = moreButtons(view);
    assert.equal(more?.props.children, "Show 2 older Sessions");
    assert.equal(view.root.findAllByProps({ className: "side-project-rule" })[0]?.props.children, "Latest 6");

    await act(async () => { (more!.props.onClick as () => void)(); });
    assert.equal(moreButtons(view).length, 0);
  });

  it("uses the singular Session for a single hidden row in English", async () => {
    setLanguage("en");
    const view = await mount({ recent: recentSessions(7) });

    const [more] = moreButtons(view);
    assert.equal(more?.props.children, "Show 1 older Session");
  });
});

describe("the running Session", () => {
  it("spins on its own row rather than in a section of its own", () => {
    const markup = render({
      activeSessionId: "s1",
      recent: [session("s1", "正在分析晶体结构")],
      running: true,
    });

    assert.ok(markup.includes("side-spinner"));
    assert.ok(markup.includes("正在分析晶体结构"));
    // The run belongs to the Session: a second row for it would list the same
    // conversation twice.
    assert.ok(!markup.includes("side-task-row"));
  });

  it("leaves the column without a spinner when nothing is running", () => {
    const markup = render({ activeSessionId: "s1", recent: [session("s1", "结构比对")] });

    assert.ok(!markup.includes("side-spinner"));
  });

  it("says 暂无会话 for an empty Project and 还没有会话 for no inbox", () => {
    const markup = render({ projects: [project("p1", "材料项目")] });

    assert.ok(markup.includes(TEXT.sidebar.noTasks));
    assert.ok(markup.includes(TEXT.sidebar.noRecent));
  });
});

describe("the column controls", () => {
  it("offers a collapse control only when something can handle it", () => {
    assert.ok(!render().includes(TEXT.sidebar.collapseSidebar));
    assert.ok(render({ onToggleSidebar: () => {} }).includes(TEXT.sidebar.collapseSidebar));
  });

  it("keeps every project folded open on first paint and offers 新建会话", () => {
    const markup = render({
      projects: [project("p1", "材料项目")],
      recent: [session("s1", "结构比对")],
      sessionsByProject: { p1: [session("s2", "晶体结构分析")] },
    });

    assert.match(markup, /aria-expanded="true"/);
    assert.ok(markup.includes(TEXT.sidebar.newTask));
    assert.ok(markup.includes("晶体结构分析"));
    assert.ok(markup.includes("结构比对"));
  });
});

/**
 * The two session actions are one group: the change is a DOM move plus two CSS
 * declarations, so without this case a later sidebar edit could take the import
 * button back out (or the rule back to a row) and the suite would stay green.
 */
describe("the session actions' group", () => {
  it("puts the import action inside the new-session container", () => {
    const markup = render();
    const open = markup.indexOf('<div class="side-new-split">');
    assert.ok(open >= 0, "the two actions share one container");
    const close = markup.indexOf("</div>", open);
    const group = markup.slice(open, close);

    assert.ok(group.includes("side-import-button"), "the import button is inside the group");
    assert.ok(group.includes(TEXT.researchPackage.import), "and it is the import label");
  });

  it("stacks them with a 2px gap instead of a row", () => {
    const css = readFileSync(new URL("../src/styles/research-package.css", import.meta.url), "utf8");
    assert.match(css, /\.side-new-split \{[^}]*display:flex;[^}]*flex-direction:column;[^}]*gap:2px;/);
  });
});

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
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkspaceActions } from "../src/app/use-workspace.js";
import { TEXT } from "../src/text.js";
import { Sidebar, stamp } from "../src/views/Sidebar.js";

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
  it("shows six rows and offers 显示更多 only when there are more", () => {
    const six = Array.from({ length: 6 }, (_, index) => session(`s${index}`, `会话${index + 1}`));
    const seven = [...six, session("s6", "会话7")];

    const short = render({ recent: six });
    assert.equal(short.split('class="side-session-name"').length - 1, 6);
    assert.ok(!short.includes(TEXT.sidebar.showMore));

    const long = render({ recent: seven });
    assert.equal(long.split('class="side-session-name"').length - 1, 6);
    assert.ok(long.includes(TEXT.sidebar.showMore));
    assert.ok(!long.includes("会话7"), "the seventh row was rendered before the fold");
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

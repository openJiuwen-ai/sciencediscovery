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
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkspaceActions } from "../src/app/use-workspace.js";
import { TEXT } from "../src/text.js";
import { Sidebar } from "../src/views/Sidebar.js";

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

describe("the session column's dates", () => {
  it("reads a recent session as a clock time and an older one as days", () => {
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const older = new Date(Date.now() - (3.5 * 24 * 60 * 60 * 1000)).toISOString();
    const markup = render({
      recent: [session("s1", "刚才", recent), session("s2", "几天前", older)],
    });

    assert.ok(markup.includes(TEXT.workspace.daysAgo(3)));
    // A recent row has a time, not a relative sentence.
    assert.ok(!markup.includes(TEXT.workspace.daysAgo(0)));
  });

  it("switches to weeks after the first seven days", () => {
    const older = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const markup = render({ recent: [session("s1", "上周", older)] });

    assert.ok(markup.includes(TEXT.workspace.weeksAgo(1)));
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

  it("says 暂无会话 for an empty Project and 还没有最近会话 for no inbox", () => {
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

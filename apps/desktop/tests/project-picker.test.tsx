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
// The test runner compiles JSX with the classic runtime.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { MenuItem } from "../src/views/RowMenu.js";
import { ProjectPicker, projectChoices } from "../src/views/ProjectPicker.js";
import { TEXT } from "../src/text.js";

function project(id: string, name: string) {
  return { createdAt: "2026-01-01T00:00:00.000Z", id, name } as never;
}

/** The menu only exists while it is open, and a static render never clicks —
 *  so the entries are checked as data, and the closed chip as markup. */
function choices(
  projects: ReturnType<typeof project>[],
  activeProjectId: string | undefined,
  picked: (string | undefined)[] = [],
  created = { count: 0 },
): MenuItem[] {
  return projectChoices(projects, activeProjectId, {
    onCreate: () => {
      created.count += 1;
    },
    onSelect: (projectId) => picked.push(projectId),
  });
}

const PROJECTS = [project("p1", "脓毒症研究"), project("p2", "蛋白质组学")];

test("the strip's project is a button that says it opens a choice", () => {
  const markup = renderToStaticMarkup(
    <ProjectPicker
      activeProjectId="p1"
      label="脓毒症研究"
      onCreateProject={() => {}}
      onSelectProject={() => {}}
      projects={PROJECTS}
    />,
  );
  assert.match(markup, /<button[^>]*aria-expanded="false"/);
  assert.match(markup, /aria-label="选择项目"/);
  assert.match(markup, /class="composer-strip-label">脓毒症研究</);
  // The folder and the chevron are decoration; the name is the reading.
  assert.match(markup, /composer-strip-icon" data-kind="folder"/);
  assert.match(markup, /class="composer-strip-chev"/);
  // Closed, it offers nothing: the menu is not in the tree until it is opened.
  assert.doesNotMatch(markup, /ctx-menu/);
});

test("with no Project chosen the chip is an invitation, not a name", () => {
  const markup = renderToStaticMarkup(
    <ProjectPicker
      activeProjectId="inbox-id"
      label={TEXT.landing.projectDirectory}
      onCreateProject={() => {}}
      onSelectProject={() => {}}
      projects={PROJECTS}
    />,
  );
  // 最近会话 names where the Session ends up; it is not a destination the user
  // can pick, so the chip asks for one instead of naming the inbox.
  assert.match(markup, /class="composer-strip-project is-placeholder"/);
  assert.match(markup, /class="composer-strip-label">选择项目</);
  assert.doesNotMatch(markup, /最近会话/);
});

test("every Project is offered in order, and the one in effect is checked", () => {
  const items = choices(PROJECTS, "p2");
  assert.deepEqual(items.slice(0, 2).map((item) => item.label), ["脓毒症研究", "蛋白质组学"]);
  assert.deepEqual(items.slice(0, 2).map((item) => item.checked), [false, true]);
});

test("the list is followed by a hairline, 新建项目, then working outside any Project", () => {
  const items = choices(PROJECTS, "p1");
  assert.equal(items.length, 4);
  const [make, none] = items.slice(2);
  assert.equal(make.label, TEXT.sidebar.newProject);
  assert.equal(make.separatorBefore, true);
  assert.equal(make.checked, undefined);
  assert.equal(none.label, TEXT.landing.noProject);
  assert.equal(none.checked, false);
  // The one promise the label cannot hold: where a conversation without a
  // Project is filed.
  assert.ok(TEXT.landing.noProjectNote.includes(TEXT.sidebar.recent));
});

test("with no Project in effect, the entry for no Project is the checked one", () => {
  // The inbox is a Project the list does not contain — that is what makes the
  // last entry the honest mark for it, rather than an absence of any mark.
  const items = choices(PROJECTS, "inbox-id");
  assert.deepEqual(items.map((item) => item.checked), [false, false, undefined, true]);
});

test("a choice reports the Project's id, a new one asks for a name, and no Project says so", () => {
  const picked: (string | undefined)[] = [];
  const created = { count: 0 };
  const items = choices(PROJECTS, undefined, picked, created);
  items[1].onSelect();
  items[2].onSelect();
  items[3].onSelect();
  assert.deepEqual(picked, ["p2", undefined]);
  assert.equal(created.count, 1);
});

test("a user with no Projects yet is still offered a way in", () => {
  const items = choices([], "inbox-id");
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.label), [TEXT.sidebar.newProject, TEXT.landing.noProject]);
});

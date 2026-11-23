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
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Project, Session } from "../src/api/types.js";
import { TEXT } from "../src/text.js";
import { ArchivedSessionList } from "../src/views/settings/system/Sessions.js";

const t = TEXT.sessionManagement;

function project(id: string, name: string): Project {
  return { id, name } as Project;
}

function session(id: string, title: string, over: Record<string, unknown> = {}): Session {
  return {
    archivedAt: "2026-11-23T02:00:00.000Z",
    createdAt: "2026-11-01T00:00:00.000Z",
    id,
    projectId: "p1",
    title,
    updatedAt: "2026-11-02T00:00:00.000Z",
    ...over,
  } as Session;
}

function render(rows: { project: Project; session: Session }[], over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <ArchivedSessionList
      onOpen={() => {}}
      onRemove={() => {}}
      onRestore={() => {}}
      rows={rows}
      {...over}
    />,
  );
}

test("an archived Session shows its title, its Project and the three things the row can do", () => {
  const markup = render([{ project: project("p1", "催化剂"), session: session("s1", "铁基催化剂筛选") }]);
  assert.ok(markup.includes("铁基催化剂筛选"), "the title the user named it with");
  assert.ok(markup.includes("催化剂"), "the Project it belongs to");
  for (const label of [t.open, t.restore, t.remove]) {
    assert.ok(markup.includes(label), `the row offers ${label}`);
  }
  // Archiving makes a Session read-only; the row says so once, where the reason
  // belongs, rather than in a tooltip only a mouse can find.
  assert.ok(markup.includes(t.readOnly), "the row says it is read-only while archived");
});

test("an unnamed Session keeps the interface's name for it", () => {
  // The service files an unnamed Session under an English sentinel; the page
  // must not print either that sentinel or a blank row.
  const markup = render([{ project: project("p1", "催化剂"), session: session("s1", "") }]);
  assert.ok(markup.includes(TEXT.sessionBar.untitled), "the row says the Session has no name yet");
  assert.ok(!markup.includes('title=""'), "an empty title is not handed to the browser as a tooltip");
});

test("the delete action is the only one drawn as destructive", () => {
  // 恢复 and 打开 are reversible; only 彻底删除 can lose work, so only it gets
  // the destructive treatment the stylesheet and the ⋯ menu share.
  const markup = render([{ project: project("p1", "催化剂"), session: session("s1", "铁基催化剂筛选") }]);
  const destructive = markup.match(/session-management-button is-destructive/g) ?? [];
  assert.equal(destructive.length, 1, "exactly one row action is destructive");
});

test("the settings directory offers 会话管理 as a page of its own", () => {
  // The sidebar holds active Sessions, so the page has to be reachable from the
  // directory: a group that is not listed there is a page nobody can open.
  const group = TEXT.settings.system.groups["session-management"];
  assert.ok(group, "the group exists in the text the directory reads");
  assert.equal(group.label, t.title, "the directory and the page call it the same thing");
});

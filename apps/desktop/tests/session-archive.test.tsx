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

import type { WorkspaceActions } from "../src/app/use-workspace.js";
import {
  SESSION_FILTER_STORAGE_KEY, isSessionListState, readSessionFilter, writeSessionFilter,
} from "../src/app/session-filter.js";
import { TEXT } from "../src/text.js";
import { RowMenu } from "../src/views/RowMenu.js";
import { Sidebar } from "../src/views/Sidebar.js";

const actions = {
  archiveSession: () => {},
  createProject: async () => {},
  newSession: () => {},
  openSession: async () => {},
  restoreSession: () => {},
  setSessionFilter: () => {},
} as unknown as WorkspaceActions;

function session(id: string, title: string, over: Record<string, unknown> = {}) {
  return { id, projectId: "inbox", title, updatedAt: "2026-01-01T00:00:00.000Z", ...over } as never;
}

function render(over: Partial<Parameters<typeof Sidebar>[0]> = {}): string {
  return renderToStaticMarkup(
    <Sidebar
      actions={actions}
      projects={[]}
      recent={[]}
      sessionFilter="active"
      sessionsByProject={{}}
      {...over}
    />,
  );
}

test("the sidebar offers the three Session sets and marks the one in force", () => {
  for (const [state, label] of [["active", TEXT.sidebar.filterActive],
                                ["archived", TEXT.sidebar.filterArchived],
                                ["all", TEXT.sidebar.filterAll]] as const) {
    const markup = render({ sessionFilter: state });
    assert.ok(markup.includes(label), `${state} label missing`);
    // Exactly one segment is pressed, and it is the one the workspace asked for.
    const pressed = [...markup.matchAll(/aria-pressed="true"[^>]*>([^<]*)</g)].map((match) => match[1]);
    assert.deepEqual(pressed, [label], `pressed set for ${state}`);
  }
});

test("the filter keeps its value, and an unusable stored value falls back to 活动", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  writeSessionFilter(storage, "archived");
  assert.equal(store.get(SESSION_FILTER_STORAGE_KEY), "archived");
  assert.equal(readSessionFilter(storage), "archived", "the choice survives a reload");

  store.set(SESSION_FILTER_STORAGE_KEY, "nonsense");
  assert.equal(readSessionFilter(storage), "active", "an unknown value cannot hide archived rows");
  assert.equal(readSessionFilter(undefined), "active", "and no storage at all means the default");
  assert.equal(isSessionListState("all"), true);
  assert.equal(isSessionListState("archived "), false);
});

test("a session row offers 归档 while it is active and 恢复 once it is archived", () => {
  const active = render({ recent: [session("s1", "A finished session")] });
  const archived = render({ recent: [session("s1", "A finished session", { archivedAt: "2026-01-02T00:00:00.000Z" })], sessionFilter: "archived" });
  // The labels live in the row menu, which is opened on demand; what the column
  // carries is the row itself and the filter that decides which set it came from.
  assert.ok(active.includes("A finished session"));
  assert.ok(archived.includes("A finished session"));
  assert.ok(active.includes(TEXT.sidebar.filterActive));
  assert.ok(archived.includes(TEXT.sidebar.filterArchived));
});

test("a menu entry can be inert, and says why in the menu", () => {
  const markup = renderToStaticMarkup(
    <RowMenu
      menu={{
        items: [{ disabled: true, label: TEXT.menu.archive, onSelect: () => {} }],
        note: TEXT.errors.archiveBlockedByRun,
        x: 0,
        y: 0,
      }}
      onClose={() => {}}
    />,
  );
  assert.ok(markup.includes('aria-disabled="true"'), "the entry announces that it is inert");
  assert.ok(/<button[^>]*disabled=""[^>]*>/.test(markup) || markup.includes(" disabled"), "and it is really disabled");
  assert.ok(markup.includes(TEXT.errors.archiveBlockedByRun), "the reason is written, not implied");
});

test("the archive confirmation names the read-only state and the kernel teardown", () => {
  // Both consequences are the server's, and the dialog repeats them: a reader who
  // only sees "归档" would not expect either.
  const zh = TEXT.errors.archiveWarning("会话");
  for (const phrase of ["只读", "内核", "持久内存"]) {
    assert.ok(zh.includes(phrase), `zh warning is missing ${phrase}`);
  }
  assert.ok(zh.includes("恢复") && zh.includes("删除"), "and it keeps reversible/irreversible apart");
});

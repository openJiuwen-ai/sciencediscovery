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
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { WorkspaceActions } from "../src/app/use-workspace.js";
import {
  SESSION_FILTER_STORAGE_KEY, isSessionListState, membershipAfterRead, readSessionFilter,
  writeSessionFilter,
} from "../src/app/session-filter.js";
import { TEXT } from "../src/text.js";
import { RowMenu } from "../src/views/RowMenu.js";
import { Sidebar, archiveActionFor } from "../src/views/Sidebar.js";

// `RowMenu` portals into the body and listens for pointer and scroll events; this
// renderer has neither, so the menu would never mount.
const listeners = new Map<string, Set<() => void>>();
const body = { appendChild: () => {}, removeChild: () => {}, contains: () => false };
Object.assign(globalThis, {
  document: {
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    body,
    removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
  },
});

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

test("a run keeps the archive entry, but inert and with its reason", () => {
  const running = archiveActionFor({}, true);
  assert.equal(running.disabled, true, "a running Session must not offer the command");
  assert.equal(running.label, TEXT.menu.archive);
  assert.equal(running.reason, TEXT.errors.archiveBlockedByRun, "and it must say why");

  const idle = archiveActionFor({}, false);
  assert.equal(idle.disabled, false);
  assert.equal(idle.reason, undefined, "no reason is carried when the command is usable");
});

test("an archived Session offers 恢复 and an active one offers 归档", () => {
  assert.equal(archiveActionFor({ archivedAt: "2026-01-02T00:00:00.000Z" }, false).label, TEXT.menu.restore);
  assert.equal(archiveActionFor({}, false).label, TEXT.menu.archive);
  // Archiving a Session that is already archived (or the reverse) is not offered,
  // so one label per state is the whole rule.
  assert.notEqual(TEXT.menu.archive, TEXT.menu.restore);
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

test("a filtered refresh never prunes the artifact catalog of the Sessions it hides", () => {
  const whole = ["a", "b"];
  // 全部: the read is the workspace, so it is both the snapshot and the pruning set.
  const all = membershipAfterRead("all", whole, undefined);
  assert.deepEqual(all.pruneAgainst, whole);
  assert.deepEqual([...(all.snapshot ?? [])], whole);

  // 已归档: a subset. Pruning against it would drop every active Session's
  // artifacts - and it would do so on the *next* refresh too, which is exactly
  // the sequence to pin. The snapshot from 全部 is what keeps them.
  const filtered = membershipAfterRead("archived", ["b"], all.snapshot);
  assert.deepEqual(filtered.pruneAgainst, whole, "the hidden Session must survive pruning");
  assert.equal(filtered.snapshot, undefined, "and a subset must not become the snapshot");

  const again = membershipAfterRead("archived", ["b"], all.snapshot);
  assert.deepEqual(again.pruneAgainst, whole, "a second refresh under the same filter behaves the same");

  // Before any unfiltered read, nothing is known, so nothing may be pruned.
  assert.deepEqual(membershipAfterRead("archived", ["b"], undefined), {});
});

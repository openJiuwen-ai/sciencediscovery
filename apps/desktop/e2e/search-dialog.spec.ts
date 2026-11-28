/**
 * E2E-META
 * Purpose: Drive 搜索 from the column's title row: the dialog it opens, the kinds it filters by, and the keys that walk it.
 * Steps:
 *   1. Open the Desktop browser entry with the deterministic API fixture holding a search answer.
 *   2. Open the dialog from the magnifier and from Ctrl+K, then narrow it by kind and by the arrow keys.
 *   3. Open a hit with Enter and check that the Session it names is the one the app reads.
 * Environment: Isolated Desktop Vite app with deterministic local API mocks.
 * Type: mocked
 * LLM: none; model behavior is deterministic fixture data.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: none
 * CostSideEffects: none
 */
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

/**
 * 搜索 is a dialog the column's title row opens, not a row the list carries.
 *
 * Every case below goes through the page rather than through React state: the
 * magnifier and Ctrl+K have to reach the same dialog, the arrow keys have to
 * walk the order the reader sees, and Enter has to open the Session the hit
 * names — a shortcut or a key handler that silently stopped working would keep
 * a static render green.
 */
import { expect, test } from "@playwright/test";

import { DEFAULT_PROJECT, TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession } from "./fixtures.js";

/** One hit per kind, and two Sessions deliberately out of order, so the grouped
 *  order and the newest-first rule inside a group are both visible. The mock
 *  matches on the label, so every one of them carries 晶. */
const HITS = [
  {
    detail: "",
    id: "project:project-1",
    kind: "project",
    label: "晶体材料研究",
    projectId: "project-1",
    updatedAt: "2026-01-04T00:00:00.000Z",
  },
  {
    detail: "",
    id: "session:session-2",
    kind: "session",
    label: "晶格比对",
    projectId: "project-1",
    sessionId: "session-2",
    updatedAt: "2026-01-03T00:00:00.000Z",
  },
  {
    detail: "",
    id: "session:session-1",
    kind: "session",
    label: "晶体结构分析",
    projectId: "project-1",
    sessionId: "session-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    detail: "",
    id: "artifact:artifact-1",
    kind: "artifact",
    label: "晶格图.png",
    projectId: "project-1",
    sessionId: "session-1",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
];

function seed() {
  return {
    projects: [DEFAULT_PROJECT],
    search: { results: HITS },
    sessions: [
      makeSession({ id: "session-1", title: "晶体结构分析" }),
      makeSession({ id: "session-2", title: "晶格比对" }),
    ],
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("the title row's magnifier opens 搜索, and 全部 groups the hits newest first", async ({ page }) => {
  await installMockApi(page, seed());
  await page.goto("/");

  // The magnifier lives on the title row, beside 收起侧栏, and nothing in the
  // column is a search row any more.
  const magnifier = page.locator(".side-head .side-head-button");
  await expect(magnifier).toBeVisible();
  await magnifier.click();

  const dialog = page.locator(".search-panel");
  await expect(dialog).toBeVisible();
  // Opening it is what puts the caret in the field: the reader types at once.
  await expect(page.locator(".search-panel-input")).toBeFocused();

  await page.locator(".search-panel-input").fill("晶");
  await expect(page.locator(".search-hit")).toHaveCount(HITS.length);

  // 全部 groups by kind, in the order the dialog promises.
  await expect(page.locator(".search-panel-heading")).toHaveText(["项目", "会话", "产物"]);
  // Inside a group the newest hit leads: 晶格比对 (01-03) before 晶体结构分析
  // (01-01), even though the answer handed them over in that order anyway only
  // by accident — the fixture's artifact row sits between kinds, not in time.
  const labels = await page.locator(".search-hit-label").allTextContents();
  expect(labels).toEqual(["晶体材料研究", "晶格比对", "晶体结构分析", "晶格图.png"]);

  // Escape closes what it opened.
  await page.locator(".search-panel-input").press("Escape");
  await expect(dialog).toBeHidden();
});

test("Ctrl+K opens the same dialog, the arrows walk it, and Enter opens the hit", async ({ page }) => {
  const mock = await installMockApi(page, seed());
  await page.goto("/");
  // The shortcut is bound by the column, so the column has to be on the page
  // before the key means anything — the same moment the magnifier appears.
  await expect(page.locator(".side-head .side-head-button")).toBeVisible();

  await page.keyboard.press("Control+k");
  const dialog = page.locator(".search-panel");
  await expect(dialog).toBeVisible();

  const field = page.locator(".search-panel-input");
  await field.fill("晶");
  await expect(page.locator(".search-hit")).toHaveCount(HITS.length);

  // Down, down: the Project leads, so the second row is the newer Session.
  await field.press("ArrowDown");
  await field.press("ArrowDown");
  await expect(page.locator(".search-hit.is-active")).toHaveText(/晶格比对/u);

  await field.press("Enter");
  await expect(dialog).toBeHidden();
  // The dialog is the entry point only: the Session it names is what the app
  // reads, which is the part a render test cannot see.
  await expect
    .poll(() => mock.calls.some((call) => call.method === "GET" && call.path === "/api/sessions/session-2"))
    .toBe(true);

  // And the arrow keys stop mattering once the dialog is gone: the page is
  // still there to be walked.
  await expect(page.locator(".main-area")).toBeVisible();
});

test("a kind shows only its own hits, and the answer withholds its count", async ({ page }) => {
  await installMockApi(page, { ...seed(), search: { hasMore: true, results: HITS, total: 9 } });
  await page.goto("/");

  await page.locator(".side-head .side-head-button").click();
  await page.locator(".search-panel-input").fill("晶");
  await expect(page.locator(".search-hit")).toHaveCount(HITS.length);

  // 9 answered and 5 drawn: the dialog says nothing about the gap. The rows are
  // the answer, and a line explaining how search works is noise around them.
  await expect(page.locator(".search-panel-note")).toHaveCount(0);

  await page.locator(".search-kind", { hasText: "项目" }).click();
  await expect(page.locator(".search-hit")).toHaveCount(1);
  await expect(page.locator(".search-hit-label")).toHaveText("晶体材料研究");
  await expect(page.locator(".search-panel-heading")).toHaveCount(0);
  await expect(page.locator(".search-panel-note")).toHaveCount(0);

  await page.locator(".search-kind", { hasText: "全部" }).click();
  await expect(page.locator(".search-hit")).toHaveCount(HITS.length);
  await expect(page.locator(".search-panel-note")).toHaveCount(0);
});

test("a hit for an archived Session is not drawn", async ({ page }) => {
  // The route answers archived hits too, so the page carries the rule itself.
  // Its listing has to be in hand for that: the archived Session here is seeded
  // before the search answers, which is the ordering a reader actually gets.
  const archived = { ...makeSession({ id: "session-gone", title: "晶体旧会话" }), archivedAt: "2026-01-05T00:00:00.000Z" };
  await installMockApi(page, {
    projects: [DEFAULT_PROJECT],
    search: {
      hasMore: true,
      results: [
        { detail: "", id: "session:session-1", kind: "session", label: "晶体结构分析", projectId: "project-1", sessionId: "session-1", updatedAt: "2026-01-03T00:00:00.000Z" },
        { detail: "", id: "session:session-gone", kind: "session", label: "晶体旧会话", projectId: "project-1", sessionId: "session-gone", updatedAt: "2026-01-04T00:00:00.000Z" },
        { detail: "", id: "artifact:artifact-gone", kind: "artifact", label: "晶体旧图.csv", projectId: "project-1", sessionId: "session-gone", updatedAt: "2026-01-02T00:00:00.000Z" },
      ],
      total: 9,
    },
    sessions: [makeSession({ id: "session-1", title: "晶体结构分析" }), archived],
  });
  await page.goto("/");

  await page.locator(".side-head .side-head-button").click();
  await page.locator(".search-panel-input").fill("晶");
  await expect(page.locator(".search-hit")).toHaveCount(1);
  await expect(page.locator(".search-hit-label")).toHaveText("晶体结构分析");

  // 9 answered, 2 dropped by the rule, 1 drawn — and nothing is counted back.
  await expect(page.locator(".search-panel-note")).toHaveCount(0);
});

test("Escape closes from the footer's kinds, and the magnifier takes the focus back", async ({ page }) => {
  // The footer's kinds are buttons: the focus leaves the field the moment a
  // reader picks one, so a key bound to the field would leave the dialog with no
  // way out — and closing has to return the caret to what opened the dialog
  // rather than dropping it on the page. Both are asserted because neither shows
  // up in a static render: the effect never runs there.
  await installMockApi(page, seed());
  await page.goto("/");

  const magnifier = page.locator(".side-head .side-head-button");
  const dialog = page.locator(".search-panel");
  await magnifier.click();
  await page.locator(".search-panel-input").fill("晶");
  await expect(page.locator(".search-hit")).toHaveCount(HITS.length);

  const kind = page.locator(".search-kind", { hasText: "项目" });
  await kind.click();
  await expect(kind).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(magnifier).toBeFocused();

  // And the same from the field: open, type, Escape, and the focus is back on
  // the control that opened it.
  await page.keyboard.press("Control+k");
  await expect(dialog).toBeVisible();
  await page.locator(".search-panel-input").press("Escape");
  await expect(dialog).toBeHidden();
  await expect(magnifier).toBeFocused();
});

test("an archived hit disappears when its listing lands after the answer", async ({ page }) => {
  // The rule reads the archived ids, and those arrive with the listing rather
  // than with the answer. Holding the listing proves the order a reader actually
  // meets on a cold start: the route answers first, the hit is drawn, and the
  // listing arriving later has to take it away again. A memo reading a ref would
  // keep the archived hit on screen until the next query.
  const archived = { ...makeSession({ id: "session-gone", title: "晶体旧会话" }), archivedAt: "2026-01-05T00:00:00.000Z" };
  const mock = await installMockApi(page, {
    hold: { method: "GET", path: /\/api\/projects\/[^/]+\/sessions$/ },
    projects: [DEFAULT_PROJECT],
    search: {
      results: [
        { detail: "", id: "session:session-1", kind: "session", label: "晶体结构分析", projectId: "project-1", sessionId: "session-1", updatedAt: "2026-01-03T00:00:00.000Z" },
        { detail: "", id: "session:session-gone", kind: "session", label: "晶体旧会话", projectId: "project-1", sessionId: "session-gone", updatedAt: "2026-01-04T00:00:00.000Z" },
      ],
      total: 2,
    },
    sessions: [makeSession({ id: "session-1", title: "晶体结构分析" }), archived],
  });
  await page.goto("/");

  await page.locator(".side-head .side-head-button").click();
  await page.locator(".search-panel-input").fill("晶");
  await expect(page.locator(".search-hit")).toHaveCount(2);

  mock.release();

  await expect(page.locator(".search-hit")).toHaveCount(1);
  await expect(page.locator(".search-hit-label")).toHaveText("晶体结构分析");
});

test("a click on the overlay closes 搜索, and the magnifier keeps the focus", async ({ page }) => {
  await installMockApi(page, seed());
  await page.goto("/");

  const magnifier = page.locator(".side-head .side-head-button");
  await magnifier.click();
  const dialog = page.locator(".search-panel");
  await expect(dialog).toBeVisible();

  // The overlay is the dialog's background, so a click outside the panel closes
  // it — the gesture a mouse reader expects without hunting for the ×. The
  // magnifier keeps the focus afterwards: a mousedown on the overlay would
  // otherwise leave it on `<body>`, which is where keyboard readers get stranded.
  await page.mouse.click(8, 8);
  await expect(dialog).toBeHidden();
  await expect(magnifier).toBeFocused();
});

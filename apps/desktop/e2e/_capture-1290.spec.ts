// Local-only capture for PR #1290 at f2dc64b4: the rebuilt search column.
import { expect, test } from "@playwright/test";

import { TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession } from "./fixtures.js";

const OUT = process.env.SHOT_DIR || "/tmp/shots-1290";
const LOCALE_KEY = "sciencediscovery-desktop:locale";

const PROJECTS = [
  { createdAt: "2026-10-01T00:00:00.000Z", id: "project-1", name: "默认项目" },
  { createdAt: "2026-10-02T00:00:00.000Z", id: "project-2", name: "材料研究" },
];

const SEED = {
  projects: PROJECTS,
  sessions: [
    makeSession({ id: "session-a", projectId: "project-1", title: "probe run a" }),
    makeSession({ id: "session-b", projectId: "project-2", title: "probe run b" }),
    makeSession({ id: "session-gone", projectId: "project-1", title: "probe archived", archivedAt: "2026-10-03T00:00:00.000Z" }),
  ],
};

const ANSWER = {
  hasMore: false,
  limit: 20,
  offset: 0,
  total: 3,
  results: [
    { detail: "Session · 默认项目", id: "session:session-a", kind: "session", label: "probe run a", projectId: "project-1", projectName: "默认项目", sessionId: "session-a" },
    { detail: "Session · 材料研究", id: "session:session-b", kind: "session", label: "probe run b", projectId: "project-2", projectName: "材料研究", sessionId: "session-b" },
    { detail: "Artifact · results.csv", id: "artifact:artifact-1", kind: "artifact", label: "probe-results.csv", path: "results.csv", projectId: "project-1", projectName: "默认项目", sessionId: "session-a", sessionTitle: "probe run a" },
  ],
};

const LANGS = [
  { tag: "zh", locale: "zh-CN", entry: "搜索", folder: "选择项目", narrow: "筛选", failure: "搜索服务暂时不可用。", noMatch: "没有符合筛选条件的会话。" },
  { tag: "en", locale: "en", entry: "Search", folder: "Choose projects", narrow: "Filters", failure: "Search is unavailable right now.", noMatch: "No Session matches the current filter." },
];

for (const lang of LANGS) {
  test.describe(lang.tag, () => {
    test.use({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2 });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(
        ([tokenKey, token, localeKey, locale]) => {
          window.localStorage.setItem(tokenKey, token);
          window.localStorage.setItem(localeKey, locale);
        },
        [TOKEN_STORAGE_KEY, TOKEN, LOCALE_KEY, lang.locale],
      );
    });

    test("1. the resting column, with 搜索 as a row", async ({ page }) => {
      await installMockApi(page, SEED);
      await page.goto("/");
      await expect(page.getByRole("button", { name: lang.entry, exact: true })).toBeVisible();
      await page.locator(".sidebar").screenshot({ path: `${OUT}/1290-${lang.tag}-1-entry.png` });
    });

    test("2. the row becomes a field, with results", async ({ page }) => {
      await installMockApi(page, SEED);
      await page.route("**/api/search**", (route) => route.fulfill({ json: ANSWER }));
      await page.goto("/");
      await page.getByRole("button", { name: lang.entry, exact: true }).click();
      await page.getByLabel(lang.entry, { exact: true }).fill("probe");
      await expect(page.locator(".side-search-hit")).toHaveCount(3);
      await page.locator(".sidebar").screenshot({ path: `${OUT}/1290-${lang.tag}-2-results.png` });
    });

    test("3. the folder control, with two Projects chosen", async ({ page }) => {
      await installMockApi(page, SEED);
      await page.route("**/api/search**", (route) => route.fulfill({ json: ANSWER }));
      await page.goto("/");
      await page.getByRole("button", { name: lang.entry, exact: true }).click();
      await page.getByLabel(lang.entry, { exact: true }).fill("probe");
      await page.locator(".sidebar").getByRole("button", { name: lang.folder, exact: true }).click();
      const options = page.locator(".side-search-menu .side-search-option");
      await expect(options.first()).toBeVisible();
      // Choose two, so the frame shows a multi-selection rather than an open menu.
      await options.nth(0).click();
      if (await options.count() > 1) await options.nth(1).click();
      // The picker stays open while choosing; if the click closed it, open it
      // again so the frame shows the selection rather than the results.
      if (!(await page.locator(".side-search-menu").isVisible())) {
        await page.locator(".sidebar").getByRole("button", { name: lang.folder, exact: true }).click();
      }
      await expect(page.locator(".side-search-option.is-on").first()).toBeVisible();
      await page.locator(".sidebar").screenshot({ path: `${OUT}/1290-${lang.tag}-3-projects.png` });
    });

    test("4. the ... control, with the narrowings inside", async ({ page }) => {
      await installMockApi(page, SEED);
      await page.route("**/api/search**", (route) => route.fulfill({ json: ANSWER }));
      await page.goto("/");
      await page.getByRole("button", { name: lang.entry, exact: true }).click();
      await page.getByLabel(lang.entry, { exact: true }).fill("probe");
      await page.getByRole("button", { name: lang.narrow, exact: true }).click();
      await page.locator(".sidebar").screenshot({ path: `${OUT}/1290-${lang.tag}-4-narrowings.png` });
    });


    test("6. the shortcut opens the field with the caret in it", async ({ page }) => {
      await installMockApi(page, SEED);
      await page.route("**/api/search**", (route) => route.fulfill({ json: ANSWER }));
      await page.goto("/");
      // Wait for the column, so the shortcut is pressed against a mounted Sidebar.
      await expect(page.getByRole("button", { name: lang.entry, exact: true })).toBeVisible();
      await page.keyboard.press("Control+K");
      const field = page.getByLabel(lang.entry, { exact: true });
      await expect(field).toBeVisible();
      await expect(field).toBeFocused();
      await page.locator(".sidebar").screenshot({ path: `${OUT}/1290-${lang.tag}-6-shortcut.png` });
    });

    test("7. an artifact of an archived Session stays out of the results", async ({ page }) => {
      await installMockApi(page, SEED);
      // The route returns an artifact that belongs to the archived Session; the
      // column must not draw it, which is the rule the previous head could not
      // enforce because artifact hits carry no archived flag.
      await page.route("**/api/search**", (route) => route.fulfill({ json: {
        ...ANSWER,
        total: 4,
        results: [...ANSWER.results, {
          detail: "Artifact · 默认项目",
          id: "artifact:artifact-gone",
          kind: "artifact",
          label: "probe-archived.csv",
          path: "archived.csv",
          projectId: "project-1",
          projectName: "默认项目",
          sessionId: "session-gone",
          sessionTitle: "probe archived",
        }],
      } }));
      await page.goto("/");
      await page.getByRole("button", { name: lang.entry, exact: true }).click();
      await page.getByLabel(lang.entry, { exact: true }).fill("probe");
      await expect(page.locator(".side-search-hit")).toHaveCount(3);
      await expect(page.getByText("probe-archived.csv")).toHaveCount(0);
      await page.locator(".sidebar").screenshot({ path: `${OUT}/1290-${lang.tag}-7-archived-artifact.png` });
    });

    test("8. the ... settings narrow the column with no query", async ({ page }) => {
      await installMockApi(page, SEED);
      await page.goto("/");
      await page.getByRole("button", { name: lang.entry, exact: true }).click();
      // No query: the field is open, the results area is empty, and the folder
      // selection has to reach the folds themselves.
      await page.locator(".sidebar").getByRole("button", { name: lang.folder, exact: true }).click();
      const options = page.locator(".side-search-menu .side-search-option");
      await expect(options.first()).toBeVisible();
      await options.nth(1).click();
      // Close the picker so the frame shows the narrowed column.
      await page.locator(".sidebar").getByRole("button", { name: lang.folder, exact: true }).click();
      await expect(page.getByText(lang.noMatch).first()).toBeVisible();
      await page.locator(".sidebar").screenshot({ path: `${OUT}/1290-${lang.tag}-8-column-narrowed.png` });
    });
    test("5. a failed query says why and offers retry", async ({ page }) => {
      await installMockApi(page, SEED);
      await page.route("**/api/search**", (route) => route.fulfill({ status: 500, json: { error: lang.failure } }));
      await page.goto("/");
      await page.getByRole("button", { name: lang.entry, exact: true }).click();
      await page.getByLabel(lang.entry, { exact: true }).fill("probe");
      const note = page.locator(".side-search-note.is-error");
      await expect(note).toBeVisible();
      await expect(note.getByRole("button")).toBeVisible();
      await page.locator(".sidebar").screenshot({ path: `${OUT}/1290-${lang.tag}-5-error.png` });
    });
  });
}

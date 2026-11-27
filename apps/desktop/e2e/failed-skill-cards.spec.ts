/**
 * E2E-META
 * Purpose: Show, in both interface languages, that a bundled Skill package the loader skipped stays visible as a non-actionable failed card in 设置 › 技能, while the `/` palette and the specialist 添加技能 picker only offer the skills that actually loaded.
 * Steps:
 *   1. Answer `GET /api/skills` with one built-in skill carrying `loadFailure` plus three healthy built-ins; open 设置 › 技能, assert the failed card's localized reason, validator message and source tag and that it has no switch, detail or export control, assert a healthy card still has its switch, then capture the frame.
 *   2. On the same catalog, type `/` in the composer and assert the palette lists the healthy skills and not the failed id, then capture the frame.
 *   3. Open 设置 › 专家 › 新增专家 › 添加技能 and assert the picker lists the healthy skills and not the failed id, then capture the frame.
 *   4. Repeat steps 1–3 in English.
 * Environment: Isolated Desktop Vite app with deterministic local API mocks; viewport 1440×900; Chinese and English UI.
 * Type: mocked
 * LLM: none; no model call is made.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none; the mock answers every /api/ request.
 * Credentials: none beyond the fixture's local token.
 * CostSideEffects: none; local fixtures only.
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
 * The containment of a malformed bundled Skill, seen from the three places the
 * user meets it.
 *
 * `services/api/src/bundled-skill-load-failure.test.ts` proves the server half:
 * `/health` and every route stay up and `GET /api/skills` reports the skipped id
 * with `loadFailure`. These cases take that same answer and check what the
 * desktop does with it: the broken file stays visible in settings so it can be
 * repaired, but it is never offered as a command or as a capability, and a
 * healthy skill beside it is untouched.
 *
 * Each state is asserted before it is captured, and every assertion here fails
 * on the behaviour before the fix: a failed descriptor used to be drawn as an
 * ordinary card with a switch and an export menu, and both pickers offered it.
 */
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { LOCALE_STORAGE_KEY } from "../src/state/storage.js";
import {
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  makeSession,
  type JsonRecord,
} from "./fixtures.js";

/** The bundled id the loader skips: its own name is the id, as the catalog
 *  reports a package that never parsed far enough to declare a prettier one. */
const FAILED_ID = "idea-tree-team";

/** What the YAML validator says about the file. The card prints it verbatim. */
const VALIDATOR_MESSAGE = "SKILL.md frontmatter is invalid YAML: Nested mappings are not allowed in compact mappings at line 3, column 16";

const HEALTHY_IDS = ["literature-searcher", "report-writer", "structure-pocket-inspection"] as const;

function healthySkill(id: string, description: string): JsonRecord {
  return {
    currentRevision: 1,
    declaredVersion: "1.0.0",
    description,
    diagnostics: [],
    hash: `hash-${id}`,
    id,
    name: id,
    readOnly: true,
    resourceSummary: { bytes: 120, files: 2, kinds: { asset: 0, other: 0, reference: 2, script: 0 } },
    source: "built-in",
    version: "1.0.0",
  };
}

/** The broken package as `SkillCatalog.list()` reports it: no hash, no
 *  resources, `readOnly`, and the validator's own words under `loadFailure`. */
const FAILED_SKILL: JsonRecord = {
  currentRevision: 1,
  description: `Failed to load: ${VALIDATOR_MESSAGE}`,
  diagnostics: [],
  hash: "",
  id: FAILED_ID,
  loadFailure: { code: "SKILL_VALIDATION", message: VALIDATOR_MESSAGE },
  name: FAILED_ID,
  readOnly: true,
  resourceSummary: { bytes: 0, files: 0, kinds: { asset: 0, other: 0, reference: 0, script: 0 } },
  source: "built-in",
  version: "1.0.0",
};

/** `SkillCatalog.list()` sorts by name, and the failed entry sits among the
 *  healthy ones exactly like a real catalog's would. */
const CATALOG: JsonRecord[] = [
  FAILED_SKILL,
  healthySkill("literature-searcher", "Retrieve and verify academic sources through literature-search MCP interfaces"),
  healthySkill("report-writer", "Synthesize domain summaries into one report"),
  healthySkill("structure-pocket-inspection", "Inspect a local PDB structure and its binding pocket"),
];

async function installCatalog(page: Page): Promise<void> {
  await installMockApi(page, { sessions: [makeSession()] });
  // The fixture answers `GET /api/skills` from its own state; this journey is
  // about one catalog shape, so the route is answered per case instead of
  // changing the shared fixture.
  await page.route(
    (url) => url.pathname === "/api/skills",
    (route) => route.request().method() === "GET"
      ? route.fulfill({ json: CATALOG })
      : route.fallback(),
  );
}

async function setLocale(page: Page, locale: "zh" | "en"): Promise<void> {
  if (locale === "en") await page.addInitScript((key) => localStorage.setItem(key, "en"), LOCALE_STORAGE_KEY);
}

async function openSettings(page: Page, locale: "zh" | "en", group: string): Promise<void> {
  await page.getByRole("button", { name: locale === "en" ? "Settings" : "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: locale === "en" ? "Settings" : "设置" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: group, exact: true }).click();
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath(name) });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

for (const locale of ["zh", "en"] as const) {
  const en = locale === "en";
  const frame = (name: string) => `${name}-${locale}.png`;

  test(`${locale}: 设置 › 技能 shows the skipped package as a failed card and keeps a healthy one intact`, { tag: "@mocked" }, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setLocale(page, locale);
    await installCatalog(page);
    await page.goto("/");
    await openSettings(page, locale, en ? "Skills" : "技能");

    const dialog = page.getByRole("dialog", { name: en ? "Settings" : "设置" });
    const failed = dialog.locator("article.skill-card").filter({ hasText: FAILED_ID });
    await expect(failed).toBeVisible();
    // The row is still there so the broken file can be found, in the interface
    // language, with the validator's own sentence under it and the source tag
    // an official package carries.
    await expect(failed.locator(".row-note.is-error")).toHaveText(en ? "This bundled skill failed to load" : "内置技能加载失败");
    await expect(failed.locator(".skill-card-desc")).toHaveText(VALIDATOR_MESSAGE);
    await expect(failed.locator(".skill-card-tag")).toHaveText(en ? "Built-in" : "内置");
    // Nothing behind the row exists: no switch, no title that opens a detail
    // page, no row menu with 导出. Every one of those would reach a route that
    // answers 404 for a package with no files.
    await expect(failed.getByRole("switch")).toHaveCount(0);
    await expect(failed.getByRole("button")).toHaveCount(0);

    // Its neighbours are untouched: the healthy package keeps its switch and
    // its own description.
    const healthy = dialog.locator("article.skill-card").filter({ hasText: HEALTHY_IDS[0] });
    await expect(healthy.getByRole("switch")).toBeVisible();
    await expect(healthy.locator(".settings-card-actions")).toBeVisible();
    await expect(healthy.locator(".skill-card-desc")).toHaveText("Retrieve and verify academic sources through literature-search MCP interfaces");
    await expect(dialog.locator("article.skill-card")).toHaveCount(HEALTHY_IDS.length + 1);

    await screenshot(page, testInfo, frame("01-skills-failed-card"));
  });

  test(`${locale}: the / palette offers only the skills that loaded`, { tag: "@mocked" }, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setLocale(page, locale);
    await installCatalog(page);
    await page.goto("/");
    // The landing page remounts while boot opens the session, which would clear
    // a draft typed before the reads settle.
    await page.waitForLoadState("networkidle");
    await page.locator("#composer-textarea").fill("/");

    const palette = page.locator(".composer-skills");
    await expect(palette).toBeVisible();
    await expect(palette.locator(".expert-row")).toHaveCount(HEALTHY_IDS.length);
    for (const id of HEALTHY_IDS) await expect(palette).toContainText(id);
    // Offering the skipped id would write a command the service cannot expand.
    await expect(palette).not.toContainText(FAILED_ID);
    await expect(palette).not.toContainText("Failed to load");

    await screenshot(page, testInfo, frame("02-slash-palette"));
  });

  test(`${locale}: the specialist 添加技能 picker offers only the skills that loaded`, { tag: "@mocked" }, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setLocale(page, locale);
    await installCatalog(page);
    await page.goto("/");
    await openSettings(page, locale, en ? "Specialists" : "专家");

    const settings = page.getByRole("dialog", { name: en ? "Settings" : "设置" });
    await settings.getByRole("button", { name: en ? "Add specialist" : "新增专家" }).click();
    const form = page.getByRole("dialog", { name: en ? "Add specialist" : "新增专家" });
    await form.getByRole("button", { name: en ? "Add skill" : "添加技能" }).click();

    const picker = page.getByRole("dialog", { name: en ? "Add skills and connectors" : "添加技能和连接器" });
    await expect(picker).toBeVisible();
    // One row per healthy package, so the count is the check that the failed
    // one is not merely unlabelled.
    await expect(picker.locator(".settings-picker-option")).toHaveCount(HEALTHY_IDS.length);
    for (const id of HEALTHY_IDS) await expect(picker.getByRole("checkbox", { name: new RegExp(id, "u") })).toBeVisible();
    await expect(picker.getByRole("checkbox", { name: new RegExp(FAILED_ID, "u") })).toHaveCount(0);
    // Nor under any other label: the whole picker names only loaded packages.
    await expect(picker).not.toContainText(FAILED_ID);

    await screenshot(page, testInfo, frame("03-specialist-picker"));
  });
}

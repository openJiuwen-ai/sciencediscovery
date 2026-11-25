// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { expect, type Locator } from "@playwright/test";
import type { Specialist } from "@sciencediscovery/schema";
import { test } from "./helpers/e2e.ts";
import { api, openDesktopSession, seedDesktopOrigin, startDesktopEntry, stopDesktopEntry } from "./helpers/desktop-evolve.ts";
import { cleanupJourney, createProjectAndSession, scriptedModel, type JourneyFixture } from "./helpers/journeys.ts";

async function actionAppearance(button: Locator) {
  return button.evaluate(element => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return { background: style.backgroundColor, color: style.color, radius: style.borderRadius,
      height: box.height, right: box.right, top: box.top };
  });
}

test.describe("Desktop Specialist enablement", { tag: ["@isolation:global", "@fixture:standard", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@status:reviewed"] }, () => {
  let entry: ChildProcess | undefined;
  test.beforeAll(async () => { entry = await startDesktopEntry(); });
  test.afterAll(async () => { await stopDesktopEntry(entry); });

  for (const locale of ["zh-CN", "en"] as const) {
    /**
     * E2E-META
     * Purpose: Custom Specialists can be disabled and re-enabled persistently; their create action matches Skills.
     * Steps:
     *   1. Open Desktop Skills and Specialists and compare the header actions.
     *   2. Create a custom Specialist in the UI, disable it, reload, and edit it while disabled.
     *   3. Verify a failed toggle stays disabled, then retry successfully.
     *   4. Bulk disable and enable custom and built-in roles; the fixed reviewer remains unchanged.
     *   5. Check the create action and switch in a narrow window, restoring owned data in finally.
     *   6. Cancel deletion from the edit/delete-only menu, then confirm and verify removal through the real API.
     * Environment: Immutable isolated API at E2E_BASE_URL; Desktop Vite on 4178; pinned Chromium; 1440x900 and 960x720, DPR 1.
     * Type: mocked
     * LLM: loopback stub for model bootstrap only; no Run submitted or model call expected.
     * WebSearch: none
     * PaperSources: none
     * MCP: none
     * OtherExternal: none; one owned browser PUT is aborted to test transport failure, with no fabricated API response.
     * Credentials: E2E_API_TOKEN from the isolated stack; synthetic loopback model token only.
     * CostSideEffects: No paid services; restores original enabled flags and deletes owned Specialist, Project, Session and model.
     */
    test(`${locale}: manage custom Specialist enablement`, { tag: "@mocked" }, async ({ page, journey }) => {
      test.setTimeout(120_000);
      const zh = locale === "zh-CN";
      const words = zh
        ? { settings: "设置", skills: "技能", specialists: "专家", addSkill: "添加技能", add: "新增专家", name: "名称", description: "描述", instructions: "指令", save: "保存", edit: "编辑", editTitle: "编辑专家", off: "已禁用", disableAll: "一键关闭", enableAll: "一键启用" }
        : { settings: "Settings", skills: "Skills", specialists: "Specialists", addSkill: "Add skill", add: "Add specialist", name: "Name", description: "Description", instructions: "Instructions", save: "Save", edit: "Edit", editTitle: "Edit specialist", off: "Disabled", disableAll: "Disable all", enableAll: "Enable all" };
      journey.scenario({ goal: "Control whether a custom Specialist is available without deleting its configuration.",
        preconditions: ["Isolated real API and Desktop entry", `${locale}; Chromium at DPR 1`, "No live model calls"] });
      const model = await scriptedModel([{ text: "Unexpected model call" }]);
      const name = `测试人员 Specialist ${randomUUID().slice(0, 8)}`;
      let fixture: JourneyFixture | undefined;
      let baseline: Specialist[] = [];
      let created: Specialist | undefined;
      const settings = page.getByRole("dialog", { name: words.settings, exact: true });
      const card = settings.locator(".settings-card").filter({ hasText: name });
      const toggle = card.getByRole("switch");
      const menuTrigger = card.getByRole("button", { name: zh ? `「${name}」的操作` : `Actions for "${name}"`, exact: true });
      const menu = card.getByRole("menu");
      const openSettings = async () => {
        await page.getByRole("button", { name: words.settings, exact: true }).click();
        await settings.getByRole("button", { name: words.specialists, exact: true }).click();
      };
      const readCreated = async () => (await api<Specialist[]>(page, "/api/specialists")).find(s => s.id === created?.id);
      try {
        await journey.step("1. Compare header actions", "Specialists uses the Skills button's position, height, colours and pill radius.", async () => {
          baseline = await api<Specialist[]>(page, "/api/specialists");
          fixture = await createProjectAndSession(page, { projectName: name, sessionTitle: name,
            model: { apiToken: model.apiToken, baseUrl: model.baseUrl, model: model.model, name } });
          await seedDesktopOrigin(page);
          await page.addInitScript(language => localStorage.setItem("sciencediscovery-desktop:locale", language), locale);
          await page.setViewportSize({ width: 1440, height: 900 });
          await openDesktopSession(page, { ...fixture, modelOwned: true });
          await openSettings();
          const specialistAction = await actionAppearance(settings.getByRole("button", { name: words.add, exact: true }));
          await settings.getByRole("button", { name: words.skills, exact: true }).click();
          const skillAction = await actionAppearance(settings.getByRole("button", { name: words.addSkill, exact: true }));
          expect(specialistAction).toEqual(skillAction);
          await settings.getByRole("button", { name: words.specialists, exact: true }).click();
        });
        await journey.step("2. Create and disable a custom role", "The real API persists disabled state through a browser reload and an edit.", async () => {
          await settings.getByRole("button", { name: words.add, exact: true }).click();
          const form = page.getByRole("dialog", { name: words.add, exact: true });
          await form.getByLabel(words.name, { exact: true }).fill(name);
          await form.getByLabel(words.description, { exact: true }).fill("专门进行测试 / Test custom enablement");
          await form.getByLabel(words.instructions, { exact: true }).fill("Check the supplied test data and report findings.");
          await form.getByRole("button", { name: words.save, exact: true }).click();
          await expect(form).toBeHidden();
          created = (await api<Specialist[]>(page, "/api/specialists")).find(s => s.name === name);
          expect(created).toBeTruthy();
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-checked", "false");
          expect((await readCreated())?.enabled).toBe(false);
          await page.reload();
          await openSettings();
          await expect(toggle).toHaveAttribute("aria-checked", "false");
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: zh ? "会话设置" : "Session settings", exact: true }).click();
          await page.getByRole("button", { name: zh ? /^专家/u : /^Experts/u }).click();
          await expect(page.locator(".expert-list")).toBeVisible();
          await expect(page.locator(".expert-row").filter({ hasText: name })).toHaveCount(0);
          await page.keyboard.press("Escape");
          await openSettings();
          await menuTrigger.click();
          await expect(menu.getByRole("menuitem")).toHaveText([words.edit, zh ? "删除" : "Delete"]);
          await expect(menu.getByRole("menuitem", { name: zh ? "导出" : "Export", exact: true })).toHaveCount(0);
          await page.keyboard.press("Escape");
          await expect(menu).toHaveCount(0);
          await expect(settings).toBeVisible();
          await menuTrigger.click();
          await menu.getByRole("menuitem", { name: words.edit, exact: true }).click();
          const editor = page.getByRole("dialog", { name: words.editTitle, exact: true });
          await editor.getByLabel(words.description, { exact: true }).fill("Edited while disabled");
          await editor.getByRole("button", { name: words.save, exact: true }).click();
          await expect(editor).toBeHidden();
          expect(await readCreated()).toMatchObject({ enabled: false, description: "Edited while disabled" });
          await expect(toggle).toHaveAttribute("aria-checked", "false");
        });
        await journey.step("3. Recover a failed toggle", "A transport failure is visible and does not claim success; retry enables the role.", async () => {
          await page.route(`**/api/specialists/${created!.id}`, async route => {
            if (route.request().method() === "PUT") await route.abort("failed");
            else await route.continue();
          }, { times: 1 });
          await toggle.click();
          await expect(settings.locator(".row-note.is-error")).toBeVisible();
          await expect(toggle).toHaveAttribute("aria-checked", "false");
          expect((await readCreated())?.enabled).toBe(false);
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-checked", "true");
          await expect(settings.locator(".row-note.is-error")).toHaveCount(0);
          expect((await readCreated())?.enabled).toBe(true);
        });
        await journey.step("4. Bulk enable and disable", "All dispatchable roles change, including custom ones; the fixed reviewer has no switch.", async () => {
          await settings.getByRole("button", { name: words.disableAll, exact: true }).click();
          await expect.poll(async () => (await api<Specialist[]>(page, "/api/specialists")).every(s => s.enabled === false)).toBe(true);
          await expect(toggle).toHaveAttribute("aria-checked", "false");
          await expect(settings.getByTestId("built-in-reviewer").getByRole("switch")).toHaveCount(0);
          await expect(settings.locator(".settings-card").filter({ hasText: "assessment-screener" }).getByRole("button", { name: /的操作|Actions for/u })).toHaveCount(0);
          await settings.getByRole("button", { name: words.enableAll, exact: true }).click();
          await expect.poll(async () => (await api<Specialist[]>(page, "/api/specialists")).every(s => s.enabled !== false)).toBe(true);
          await expect(toggle).toHaveAttribute("aria-checked", "true");
        });
        await journey.step("5. Check a narrow desktop window", "Create, edit, delete and the custom switch remain reachable at 960x720.", async () => {
          await page.setViewportSize({ width: 960, height: 720 });
          await settings.getByRole("button", { name: words.add, exact: true }).click();
          await page.keyboard.press("Escape");
          await toggle.scrollIntoViewIfNeeded();
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-checked", "false");
          await menuTrigger.click();
          await expect(menu.getByRole("menuitem", { name: words.edit, exact: true })).toBeInViewport({ ratio: 1 });
          await expect(menu.getByRole("menuitem")).toHaveText([words.edit, zh ? "删除" : "Delete"]);
          expect(model.calls).toHaveLength(0);
        });
        await journey.step("6. Cancel and confirm deletion from the menu", "Cancelling preserves the role; confirming deletes it and the real API no longer lists it.", async () => {
          const remove = zh ? "删除" : "Delete";
          await menu.getByRole("menuitem", { name: remove, exact: true }).click();
          const confirmation = page.getByRole("dialog").filter({ has: page.locator("#confirm-title") });
          await expect(confirmation).toBeVisible();
          await confirmation.locator(".modal-footer").getByRole("button", { name: zh ? "取消" : "Cancel", exact: true }).click();
          expect(await readCreated()).toBeTruthy();
          await menuTrigger.click();
          await menu.getByRole("menuitem", { name: remove, exact: true }).click();
          const deletedId = created!.id;
          await confirmation.getByRole("button", { name: remove, exact: true }).click();
          await expect(card).toHaveCount(0);
          expect((await api<Specialist[]>(page, "/api/specialists")).some(s => s.id === deletedId)).toBe(false);
          created = undefined;
        });
      } finally {
        try {
          for (const s of baseline) await api(page, `/api/specialists/${s.id}`, { method: "PUT", data: { enabled: s.enabled !== false } });
        } finally {
          try {
            if (fixture) await cleanupJourney(page, fixture);
            // Find a saved row even if a later assertion failed before id capture.
            created ??= (await api<Specialist[]>(page, "/api/specialists")).find(s => s.name === name);
            if (created) await api(page, `/api/specialists/${created.id}`, { method: "DELETE" });
          } finally { await model.stop(); }
        }
      }
    });
  }
});

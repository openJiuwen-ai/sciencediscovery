// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { expect, type Locator } from "@playwright/test";
import type { ConnectorManifest, Session, Specialist } from "@sciencediscovery/schema";
import { test } from "./helpers/e2e.ts";
import { api, openDesktopSession, seedDesktopOrigin, startDesktopEntry, stopDesktopEntry } from "./helpers/desktop-evolve.ts";
import { cleanupJourney, createProjectAndSession, scriptedModel, type JourneyFixture } from "./helpers/journeys.ts";

async function toolbarActionAppearance(tabs: Locator, action: Locator) {
  await expect(tabs).toBeVisible();
  await expect(action).toBeVisible();
  const [tabsBox, actionBox] = await Promise.all([tabs.boundingBox(), action.boundingBox()]);
  if (!tabsBox || !actionBox) throw new Error("The tabs and add action must both be laid out.");
  const tabsCenter = tabsBox.y + tabsBox.height / 2;
  const actionCenter = actionBox.y + actionBox.height / 2;
  expect(Math.abs(actionCenter - tabsCenter)).toBeLessThanOrEqual(2);

  return action.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      radius: style.borderRadius,
      height: style.height,
    };
  });
}

test.describe("Desktop Specialist management", { tag: ["@isolation:global", "@fixture:standard", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@status:reviewed"] }, () => {
  let entry: ChildProcess | undefined;
  test.beforeAll(async () => { entry = await startDesktopEntry(); });
  test.afterAll(async () => { await stopDesktopEntry(entry); });
  for (const locale of ["zh-CN", "en"] as const) {
    /**
     * E2E-META
     * Purpose: Manage Specialists through the 2026-11-26 card, detail, editor and drawer design with real API persistence.
     * Steps:
     *   1. Compare the Skills and Specialist add actions, check each aligns with its own tabs, and search the Specialist catalog.
     *   2. Create a role with explicitly selected skill/MCP capabilities and persisted prompt examples.
     *   3. Bind and disable it, verify the truthful disabled binding and narrow hint, then explicitly unbind.
     *   4. Observe a failed toggle and retry; bulk switches preserve the fixed Reviewer.
     *   5. Delete its selected skill, toggle the stale role, and repair the missing reference through the editor.
     *   6. Try a saved example in a new bound conversation with a prefilled draft and no Run.
     *   7. Inspect read-only builtin details and responsive card actions at 960x720.
     *   8. Cancel and confirm deletion with the pointer, then verify the API record is gone.
     * Environment: Isolated immutable API at E2E_BASE_URL; Desktop Vite4178; pinned Chromium; 1920x1080 and960x720, DPR1.
     * Type: mocked
     * LLM: loopback stub for model bootstrap only; no model call or Run submitted.
     * WebSearch: none
     * PaperSources: none
     * MCP: select real catalog entries only; no connector invocation.
     * OtherExternal: none; abort one owned PUT for transport recovery.
     * Credentials: E2E_API_TOKEN from isolated stack; synthetic model token only.
     * CostSideEffects: Restores original enabled flags; deletes owned role, skill, trial Session, Project and model; no paid service.
     */
    test(`${locale}: manage Specialist cards and trial drafts`, { tag: "@mocked" }, async ({ page, journey }) => {
      test.setTimeout(240_000);
      const zh = locale === "zh-CN";
      const w = zh ? { settings: "设置", specialists: "专家", add: "新增专家", edit: "编辑", editTitle: "编辑专家", details: "专家详情", name: "专家名称", description: "描述", instructions: "指令", save: "保存", back: "返回", search: "搜索", specific: "指定可用能力", configureSkills: "配置技能", configureMcp: "配置 MCP 服务", confirm: "确定", cancel: "取消", remove: "删除", try: "去试试", enableAll: "一键启用", disableAll: "一键关闭" }
        : { settings: "Settings", specialists: "Specialists", add: "Add specialist", edit: "Edit", editTitle: "Edit specialist", details: "Specialist details", name: "Name", description: "Description", instructions: "Instructions", save: "Save", back: "Back", search: "Search", specific: "Choose available capabilities", configureSkills: "Configure skills", configureMcp: "Configure MCP services", confirm: "Confirm", cancel: "Cancel", remove: "Delete", try: "Try it", enableAll: "Enable all", disableAll: "Disable all" };
      const suffix = randomUUID().slice(0, 8), name = `UI-${locale}-${suffix} Specialist`, example = "Check this research dataset before analysing it.";
      const model = await scriptedModel([{ text: "No call expected" }]);
      let fixture: JourneyFixture | undefined, created: Specialist | undefined, ownedSkillId: string | undefined, inboxId: string | undefined;
      let baseline: Specialist[] = [];
      const settings = page.getByRole("dialog", { name: w.settings, exact: true });
      const detail = page.getByRole("region", { name: w.details, exact: true });
      const card = settings.locator(".specialist-card").filter({ hasText: name });
      const readCreated = async () => (await api<Specialist[]>(page, "/api/specialists")).find(row => row.id === created?.id);
      const openSettings = async () => { await page.getByRole("button", { name: w.settings, exact: true }).click(); await settings.getByRole("button", { name: w.specialists, exact: true }).click(); };
      const back = async () => { await page.getByRole("button", { name: w.back, exact: true }).click(); };
      const closeSettings = async () => { await page.keyboard.press("Escape"); await expect(settings).toBeHidden(); };
      const actions = () => card.getByRole("button", { name: zh ? `「${name}」的操作` : `Actions for "${name}"`, exact: true });
      journey.scenario({ goal: "Create, configure, inspect and safely try a custom Specialist without executing a model.", preconditions: ["Actual isolated API and compiled Desktop", locale, "Owned data and loopback model only"] });
      try {
        await journey.step("1. Inspect catalog controls", "Both add actions share the same appearance and each aligns with its page's tabs.", async () => {
          baseline = await api<Specialist[]>(page, "/api/specialists");
          fixture = await createProjectAndSession(page, { projectName: `${name} workspace`, sessionTitle: `${name} source`, model: { apiToken: model.apiToken, baseUrl: model.baseUrl, model: model.model, name } });
          await seedDesktopOrigin(page); await page.addInitScript(language => localStorage.setItem("sciencediscovery-desktop:locale", language), locale);
          await page.setViewportSize({ width: 1920, height: 1080 }); await openDesktopSession(page, { ...fixture, modelOwned: true }); await openSettings();
          await expect(settings.getByRole("tab")).toHaveCount(3);
          const tabs = settings.getByRole("tablist");
          const specialistAdd = settings.getByRole("button", { name: w.add, exact: true });
          await expect(specialistAdd).toHaveCSS("background-color", "rgb(25, 25, 25)");
          const specialistAppearance = await toolbarActionAppearance(tabs, specialistAdd);
          await settings.getByRole("button", { name: zh ? "技能" : "Skills", exact: true }).click();
          const skillAdd = settings.getByRole("button", { name: zh ? "添加技能" : "Add skill", exact: true });
          expect(await toolbarActionAppearance(tabs, skillAdd)).toEqual(specialistAppearance);
          await settings.getByRole("button", { name: w.specialists, exact: true }).click();
          await settings.getByRole("searchbox", { name: w.search, exact: true }).fill("no-matching-owned-role"); await expect(settings.locator(".specialist-card")).toHaveCount(0);
          await settings.getByRole("searchbox", { name: w.search, exact: true }).fill("");
        });
        await journey.step("2. Create with capability drawers and examples", "Only confirmed drawer selections are saved; prompt examples stay separate from instructions.", async () => {
          const skill = await api<{ id: string }>(page, "/api/skills", { method: "POST", data: { name: `ui-skill-${suffix}`, description: "Owned regression capability", instructions: "Check inputs." } }); ownedSkillId = skill.id;
          const connectors = await api<ConnectorManifest[]>(page, "/api/connectors"); expect(connectors.length).toBeGreaterThan(0); const connector = connectors[0]!;
          // Re-enter to refresh the catalog after installing the owned skill.
          await closeSettings(); await openSettings();
          await settings.getByRole("button", { name: w.add, exact: true }).click();
          const form = page.getByRole("region", { name: w.add, exact: true });
          await form.getByLabel(w.name, { exact: true }).fill(name); await form.getByLabel(w.description, { exact: true }).fill("Validate research evidence."); await form.getByLabel(w.instructions, { exact: true }).fill("Check supplied data and report evidence.");
          await form.getByRole("radio", { name: new RegExp(w.specific, "u") }).click();
          await form.getByRole("button", { name: new RegExp(w.configureSkills, "u") }).click();
          let drawer = page.getByRole("dialog", { name: w.configureSkills, exact: true });
          await drawer.getByRole("searchbox", { name: w.search, exact: true }).fill(`ui-skill-${suffix}`); await drawer.getByRole("checkbox", { name: `ui-skill-${suffix}`, exact: true }).check();
          await drawer.getByRole("button", { name: w.cancel, exact: true }).click(); await expect(form.getByRole("button", { name: w.save, exact: true })).toBeDisabled();
          await form.getByRole("button", { name: new RegExp(w.configureSkills, "u") }).click(); drawer = page.getByRole("dialog", { name: w.configureSkills, exact: true });
          await drawer.getByRole("searchbox", { name: w.search, exact: true }).fill(`ui-skill-${suffix}`); await drawer.getByRole("checkbox", { name: `ui-skill-${suffix}`, exact: true }).check(); await drawer.getByRole("button", { name: w.confirm, exact: true }).click();
          await form.getByRole("button", { name: new RegExp(w.configureMcp, "u") }).click(); drawer = page.getByRole("dialog", { name: w.configureMcp, exact: true });
          await drawer.getByRole("checkbox", { name: connector.displayName ?? connector.id, exact: true }).check(); await drawer.getByRole("button", { name: w.confirm, exact: true }).click();
          await form.getByRole("button", { name: zh ? /配置提问示例/u : /Add prompt example/u }).click(); await form.getByLabel(zh ? "提问示例 1" : "Prompt example 1", { exact: true }).fill(example);
          await form.getByRole("button", { name: w.save, exact: true }).click(); await expect(detail).toBeVisible();
          created = (await api<Specialist[]>(page, "/api/specialists")).find(row => row.name === name); expect(created).toMatchObject({ instructions: "Check supplied data and report evidence.", promptExamples: [example], enabledSkillIds: [skill.id], connectorIds: [connector.id] });
        });
        await journey.step("3. Preserve and explicitly clear a disabled current binding", "The bound name, state, full narrow hint and inactive selected option remain truthful.", async () => {
          await back(); await closeSettings(); await page.getByRole("button", { name: zh ? "会话设置" : "Session settings", exact: true }).click(); await page.getByRole("button", { name: zh ? /^专家/u : /^Experts/u }).click(); await page.locator(".expert-row").filter({ hasText: name }).click();
          await expect.poll(async () => (await api<Session>(page, `/api/sessions/${fixture!.session.id}`)).specialistId).toBe(created!.id);
          await openSettings(); await card.getByRole("switch").click(); await expect(card.getByRole("switch")).toHaveAttribute("aria-checked", "false");
          await openDesktopSession(page, { ...fixture!, modelOwned: true });
          // The composer also renders while configuration loads. Open the
          // menu after Landing mounts so the final render keeps it open.
          await expect(page.locator(".landing #composer-textarea")).toBeVisible();
          await page.setViewportSize({ width: 960, height: 720 });
          await page.getByRole("button", { name: zh ? "会话设置" : "Session settings", exact: true }).click(); const row = page.getByRole("button", { name: zh ? /^专家/u : /^Experts/u });
          await expect(row).toContainText(name); await expect(row).toContainText(zh ? "已停用" : "Disabled"); await row.hover();
          await expect(row.locator(".session-menu-tip")).toHaveCSS("opacity", "1"); await expect(row.locator(".session-menu-tip")).toBeInViewport({ ratio: 1 });
          await row.click(); const option = page.locator(".expert-row").filter({ hasText: name }); await expect(option).toHaveAttribute("aria-current", "true"); await expect(option).toBeDisabled(); await option.hover(); await expect(option).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
          await page.locator(".expert-list").getByRole("button", { name: zh ? "无" : "None", exact: true }).click(); await expect.poll(async () => (await api<Session>(page, `/api/sessions/${fixture!.session.id}`)).specialistId ?? null).toBe(null);
          await page.setViewportSize({ width: 1920, height: 1080 }); await openSettings();
        });
        await journey.step("4. Recover a toggle failure and exercise bulk actions", "A failed write stays off, retry succeeds, and fixed Reviewer has no switch.", async () => {
          await page.route(`**/api/specialists/${created!.id}`, route => route.request().method() === "PUT" ? route.abort("failed") : route.continue(), { times: 1 });
          await card.getByRole("switch").click(); await expect(settings.getByRole("alert")).toBeVisible(); await expect(card.getByRole("switch")).toHaveAttribute("aria-checked", "false");
          await card.getByRole("switch").click(); await expect(card.getByRole("switch")).toHaveAttribute("aria-checked", "true");
          await settings.getByRole("button", { name: w.disableAll, exact: true }).click(); await expect.poll(async () => (await api<Specialist[]>(page, "/api/specialists")).every(s => s.enabled === false)).toBe(true);
          await expect(settings.getByTestId("built-in-reviewer").getByRole("switch")).toHaveCount(0);
          await settings.getByRole("button", { name: w.enableAll, exact: true }).click(); await expect.poll(async () => (await api<Specialist[]>(page, "/api/specialists")).every(s => s.enabled !== false)).toBe(true);
        });
        await journey.step("5. Toggle and repair after removing a selected skill", "A stale skill does not prevent disabling; explicit removal preserves the remaining MCP selection.", async () => {
          await api(page, `/api/skills/${encodeURIComponent(ownedSkillId!)}`, { method: "DELETE" }); ownedSkillId = undefined;
          await page.reload(); await openSettings(); await card.getByRole("switch").click(); await expect(card.getByRole("switch")).toHaveAttribute("aria-checked", "false");
          await card.getByRole("button", { name: zh ? `查看专家「${name}」` : `View specialist "${name}"`, exact: true }).click(); await detail.getByRole("button", { name: w.edit, exact: true }).click();
          const form = page.getByRole("region", { name: w.editTitle, exact: true }); const missing = created!.enabledSkillIds[0]!;
          await expect(form).toContainText(zh ? `不可用技能：${missing}` : `Unavailable skill: ${missing}`); await expect(form.getByRole("button", { name: w.save, exact: true })).toBeDisabled();
          await form.getByRole("button", { name: `${zh ? "移除" : "Remove"} ${missing}`, exact: true }).click(); await form.getByLabel(w.description, { exact: true }).fill("Edited while disabled"); await form.getByRole("button", { name: w.save, exact: true }).click();
          expect(await readCreated()).toMatchObject({ enabled: false, enabledSkillIds: [], promptExamples: [example], description: "Edited while disabled" });
          await detail.getByRole("switch").click(); await expect(detail.getByRole("switch")).toHaveAttribute("aria-checked", "true");
        });
        await journey.step("6. Try an example without starting a Run", "A new inbox Session binds the role and only prefills the editable composer.", async () => {
          const inbox = await api<{ id: string }>(page, "/api/inbox", { method: "POST", data: {} }); inboxId = inbox.id;
          await detail.getByRole("button", { name: new RegExp(example, "u") }).click(); await expect(settings).toBeHidden(); await expect(page.locator("#composer-textarea")).toHaveValue(example);
          const trials = (await api<Session[]>(page, `/api/projects/${inbox.id}/sessions`)).filter(s => s.title === name); expect(trials).toHaveLength(1); expect(trials[0]!.specialistId).toBe(created!.id);
          expect(await api(page, `/api/sessions/${trials[0]!.id}/runs`)).toEqual([]); expect(model.calls).toHaveLength(0);
          const composer = page.locator("#composer-textarea");
          await composer.fill("");
          await page.locator(".side-session").filter({ hasText: fixture!.session.title }).click();
          await expect(page.locator(".task-head-title")).toContainText(fixture!.session.title);
          await page.locator(".side-session").filter({ hasText: name }).filter({ hasNotText: fixture!.session.title }).click();
          await expect(page.locator(".task-head-title")).toHaveText(name);
          await expect(composer).toHaveValue("");
          await api(page, `/api/sessions/${trials[0]!.id}`, { method: "DELETE", data: { confirmationId: trials[0]!.id } }); await openDesktopSession(page, { ...fixture!, modelOwned: true }); await openSettings();
        });
        await journey.step("7. Inspect builtins and narrow actions", "Built-ins have read-only details; custom actions stay reachable at 960px.", async () => {
          const builtin = baseline.find(s => s.builtIn)!; expect(builtin).toBeTruthy(); await settings.getByRole("button", { name: zh ? `查看专家「${builtin.name}」` : `View specialist "${builtin.name}"`, exact: true }).click();
          await expect(detail.getByRole("button", { name: w.edit, exact: true })).toHaveCount(0); await back(); await page.setViewportSize({ width: 960, height: 720 }); await card.scrollIntoViewIfNeeded(); await actions().click();
          await expect(card.getByRole("menuitem")).toHaveText([w.try, w.remove]); await expect(card.getByRole("menuitem", { name: w.remove, exact: true })).toBeInViewport({ ratio: 1 }); await page.keyboard.press("Escape");
        });
        await journey.step("8. Cancel then pointer-confirm deletion", "Cancel preserves the role; confirmation removes it from the real API.", async () => {
          await actions().click(); await card.getByRole("menuitem", { name: w.remove, exact: true }).click(); const confirmation = page.getByRole("dialog").filter({ has: page.locator("#confirm-title") });
          await confirmation.getByRole("button", { name: w.cancel, exact: true }).last().click(); expect(await readCreated()).toBeTruthy(); await actions().click(); await card.getByRole("menuitem", { name: w.remove, exact: true }).click(); await confirmation.getByRole("button", { name: w.remove, exact: true }).click();
          await expect(card).toHaveCount(0); expect(await readCreated()).toBeUndefined(); created = undefined;
        });
      } finally {
        try {
          for (const role of baseline) await api(page, `/api/specialists/${role.id}`, { method: "PUT", data: { enabled: role.enabled !== false } });
          if (inboxId) for (const trial of (await api<Session[]>(page, `/api/projects/${inboxId}/sessions`)).filter(s => s.title === name)) await api(page, `/api/sessions/${trial.id}`, { method: "DELETE", data: { confirmationId: trial.id } });
          if (fixture) await cleanupJourney(page, fixture);
          created ??= (await api<Specialist[]>(page, "/api/specialists")).find(s => s.name === name);
          if (created) await api(page, `/api/specialists/${created.id}`, { method: "DELETE" });
          if (ownedSkillId) await api(page, `/api/skills/${encodeURIComponent(ownedSkillId)}`, { method: "DELETE" });
        } finally { await model.stop(); }
      }
    });
  }
});

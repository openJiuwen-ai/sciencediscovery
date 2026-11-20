// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").

import { expect } from "@playwright/test";
import { readEvolveDirection } from "../packages/schema/src/evolve-direction.ts";
import { openDesktopSession, seedDesktopOrigin, startDesktopEntry, stopDesktopEntry } from "./helpers/desktop-evolve.ts";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel } from "./helpers/journeys.ts";

const variants = [
  { client: "Web", locale: "en", scope: "Custom JSON and edit scope", upload: "Upload JSON",
    expand: "Expand", collapse: "Collapse", fields: ["1 field", "2 fields"], item: "1 item", start: "Start evolution",
    allow: "Allow edits", addItem: "Add item", remove: "Remove" },
  { client: "Desktop", locale: "zh-CN", scope: "自定义 JSON 与修改范围", upload: "上传 JSON",
    expand: "展开", collapse: "折叠", fields: ["1 个字段", "2 个字段"], item: "1 个元素", start: "开始演进",
    allow: "允许修改", addItem: "添加元素", remove: "删除" },
] as const;

test.describe("Evolve nested starting fields", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock"] }, () => {
  for (const words of variants) {
    /**
     * E2E-META
     * Purpose: Edit an imported deeply nested starting value in the workbench and send it with its selected top-level scope.
     * Steps:
     *   1. Open the Evolve confirmation in an isolated project.
     *   2. Import and expand an object containing arrays and objects, then edit and inspect it at two widths.
     *   3. Confirm that the submitted JSON contains the edits and the chosen top-level field.
     * Environment: Local isolated stack and real Web or desktop renderer; runtime readiness and message transport are stubbed for the browser.
     * Type: mocked
     * LLM: local scripted model registered, no model call expected
     * WebSearch: none
     * PaperSources: none
     * MCP: none
     * OtherExternal: none
     * Credentials: E2E_API_TOKEN for the local test stack
     * CostSideEffects: temporary project and model, cleaned up after the test; no search runs
     */
    test(`${words.client} can edit deeply nested starting fields (${words.locale})`, { tag: "@mocked" }, async ({ page, journey }, info) => {
      journey.scenario({ goal: "Change a deep starting value without losing the nested layout or its edit scope.",
        preconditions: ["Isolated local stack with a temporary session."] });
      const model = await scriptedModel([{ text: "No model call is expected." }]);
      let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
      let desktop: Awaited<ReturnType<typeof startDesktopEntry>> | undefined;
      const starting = { fixed: 32, strategy: { rules: [{ tiers: [{ limit: 4, enabled: true }] }], mode: "LRU" } };
      const dialog = page.getByRole("dialog", { name: /^(Confirm evolution settings|确认演进设置)$/u });
      const disclosure = (action: string, name: string, count: string) =>
        dialog.getByRole("button", { name: `${action} ${name}, ${count}`, exact: true });
      const limit = dialog.getByRole("spinbutton", { name: "limit", exact: true });
      const start = dialog.getByRole("button", { name: words.start, exact: true });
      try {
        await journey.step("Open the task's evolution settings", "The confirmation lets the user turn on custom JSON.", async () => {
          fixture = await createProjectAndSession(page, { projectName: `Nested Evolve ${words.client} ${Date.now()}`,
            sessionTitle: "Edit nested starting fields", model: { ...model, name: `Nested fields ${words.client} ${Date.now()}` } });
          await page.setViewportSize({ width: 1440, height: 1080 });
          await page.addInitScript(locale => {
            localStorage.setItem("sciencediscovery-locale", locale);
            localStorage.setItem("sciencediscovery-desktop:locale", locale);
          }, words.locale);
          await page.route("**/api/evolve/status", route => route.fulfill({ json: { state: "ready", sandbox: "bwrap" } }));
          if (words.client === "Desktop") {
            desktop = await startDesktopEntry();
            await seedDesktopOrigin(page);
            await openDesktopSession(page, { ...fixture, modelOwned: true });
            await page.getByRole("button", { name: "会话设置", exact: true }).click();
            await page.getByRole("button", { name: "程序演进实验", exact: true }).click();
            await page.getByRole("button", { name: "开始设计", exact: true }).click();
            await expect(page.getByRole("dialog")).toBeHidden();
            const composer = page.locator("#composer-textarea");
            await composer.fill("Tune the nested cache strategy");
            await composer.press("Enter");
          } else {
            await openProjectSession(page, fixture);
            const composer = page.locator("form.composer");
            await composer.getByRole("textbox").fill("/evolve-design --algorithm puct Tune the nested cache strategy");
            await composer.locator('button[type="submit"]').click();
          }
          await dialog.getByRole("switch", { name: words.scope, exact: true }).check();
        });
        await journey.step("Import and edit the nested values", "Child controls use the list's width and remain in view at both sizes.", async () => {
          await dialog.getByLabel(words.upload, { exact: true }).setInputFiles({
            name: "nested-strategy.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(starting)),
          });
          await expect(start).toBeDisabled();
          for (const [name, count] of [["strategy", words.fields[1]], ["rules", words.item], ["[0]", words.fields[0]],
            ["tiers", words.item], ["[0]", words.fields[1]]] as const) {
            await disclosure(words.expand, name, count).click();
          }
          await limit.fill("8");
          const tiers = disclosure(words.collapse, "tiers", words.item);
          const tiersChildren = dialog.locator(`[id="${await tiers.getAttribute("aria-controls")}"]`);
          await tiersChildren.getByRole("button", { name: new RegExp(words.addItem, "u") }).click();
          await tiersChildren.getByRole("button", { name: `${words.remove} [1]`, exact: true }).click();
          await tiers.click();
          await expect(limit).toBeHidden();
          await disclosure(words.expand, "tiers", words.item).click();
          await expect(limit).toHaveValue("8");
          await dialog.getByRole("checkbox", { name: `${words.allow} strategy`, exact: true }).check();
          const list = dialog.locator(".evolve-json-list");
          for (const width of [620, 390]) {
            await page.setViewportSize({ width, height: 1080 });
            await expect(limit).toBeVisible();
            expect(await list.evaluate(element => {
              const listBox = element.getBoundingClientRect();
              const rows = [...element.querySelectorAll<HTMLElement>(".evolve-json-row")].filter(row => row.offsetWidth);
              return rows.every(row => row.offsetWidth >= listBox.width - 3
                && [...row.children].every(child => {
                  const box = child.getBoundingClientRect();
                  return box.left >= listBox.left && box.right <= listBox.right;
                }));
            })).toBe(true);
            await list.evaluate(element => element.scrollIntoView({ block: "start" }));
            await dialog.screenshot({ path: info.outputPath(`nested-fields-${width}.png`) });
          }
        });
        await journey.step("Confirm the modified starting fields", "The outgoing command carries the exact nested JSON and one selected field.", async () => {
          const messages = `**/api/sessions/${fixture!.session.id}/messages`;
          await page.route(messages, route => route.request().method() === "POST"
            ? route.fulfill({ status: 409, json: { error: "Stop after capturing the submitted message" } })
            : route.continue());
          const submitted = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith(`/sessions/${fixture!.session.id}/messages`));
          await start.click();
          const body = (await submitted).postDataJSON();
          starting.strategy.rules[0]!.tiers[0]!.limit = 8;
          expect(readEvolveDirection(body.content)).toEqual({ baseline: JSON.stringify(starting), editable: ["strategy"] });
        });
      } finally {
        await stopDesktopEntry(desktop);
        if (fixture) await cleanupJourney(page, fixture);
        await model.stop();
      }
    });
  }
});

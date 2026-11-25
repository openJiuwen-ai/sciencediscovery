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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import { expect, type Locator } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import { api, DESKTOP_ORIGIN, seedDesktopOrigin, startDesktopEntry, stopDesktopEntry } from "./helpers/desktop-evolve.ts";

const copy = {
  add: "添加技能",
  back: "返回技能列表",
  delete: "删除",
  detail: "详情",
  detailFiles: "文件",
  edit: "编辑",
  export: "导出",
  importAction: "导入",
  instructions: "指令",
  nav: "设置目录",
  save: "保存",
  saved: "已保存。",
  settings: "设置",
  skills: "技能",
  upload: "上传技能",
};

/** The chevron the row of `name` carries. */
const rowMenu = (settings: Locator, name: string) => settings
  .locator(".settings-card").filter({ hasText: name })
  .getByRole("button", { name: `「${name}」的操作`, exact: true });

/**
 * Put the row of `name` on screen, hover its chevron, and wait for the menu.
 *
 * The scroll is part of the step rather than left to the hover: Playwright
 * scrolls a hovered element into view itself, and a row that is still moving
 * when the press follows takes the pointer off the row, which closes the menu
 * it just opened. A person scrolls to the row they mean before pointing at it,
 * and so does this.
 */
const openRowMenu = async (settings: Locator, name: string) => {
  await rowMenu(settings, name).scrollIntoViewIfNeeded();
  await rowMenu(settings, name).hover();
  await expect(settings.getByRole("menuitem", { name: copy.export, exact: true })).toBeVisible();
};

/**
 * Press one entry of the open menu.
 *
 * `force` leaves out Playwright's own "scroll into view" before the press.
 * That scroll measures the entry while the menu is still opening and then
 * moves the settings pane by that distance, which carries the row out from
 * under the pointer; the popover follows the pointer's absence and closes
 * before the press lands. The visibility check above the press is what proves
 * the entry is on screen, and every entry's effect is asserted after it.
 */
const chooseMenuItem = async (settings: Locator, label: string) => {
  const item = settings.getByRole("menuitem", { name: label, exact: true });
  await expect(item).toBeVisible();
  await item.click({ force: true });
};

interface InstalledSkill {
  frontmatter?: Record<string, unknown>;
  id: string;
  instructions?: string;
  name: string;
}

test.describe("Desktop Skill import and editing", { tag: ["@isolation:global", "@fixture:standard", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@status:reviewed"] }, () => {
  let entry: ChildProcess | undefined;
  test.beforeAll(async () => { entry = await startDesktopEntry(); });
  test.afterAll(async () => { await stopDesktopEntry(entry); });

  /**
   * E2E-META
   * Purpose: A desktop user imports a SKILL.md into the installed catalog, finds it in 设置 › 技能, reads it on
   *   its own page, edits its instructions from the row's menu, exports the saved package, and deletes it.
   * Steps:
   *   1. Open 设置 › 技能 on the desktop entry; the Skill about to be imported is not listed.
   *   2. 添加技能 › 上传技能: hand the view one file; the import reports the package by name.
   *   3. Open the card: the bar names 技能 › Skill, the page names and describes it, and renders SKILL.md under 文件.
   *   4. From the row's chevron menu, open 编辑 and rewrite 指令; 保存 reports the save.
   *   5. 导出 from the same menu downloads `<name>.zip`.
   *   6. Read the package back through the API: the new instructions are installed and `license` survived the save.
   *   7. 删除 from the menu, confirmed in the dialog, removes the package from the list and from the catalog.
   * Environment: Immutable compiled isolated API at E2E_BASE_URL; desktop Vite on 4178; zh-CN at 1440x900.
   * Type: mocked
   * LLM: none — importing and editing a Skill package never calls a model.
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none; non-local browser requests are blocked.
   * Credentials: E2E_API_TOKEN for the isolated stack only.
   * CostSideEffects: no external cost; the downloaded ZIP is discarded, and the Skill is deleted in finally.
   */
  test("desktop: import, read, edit and remove a SKILL.md", { tag: "@mocked" }, async ({ journey, page }) => {
    test.setTimeout(120_000);
    const name = `desk-skill-${Date.now()}`;
    const description = "Imported from a single SKILL.md by the desktop journey.";
    const firstInstructions = "Read reference/notes.md before starting.";
    const editedInstructions = "Read reference/notes.md, then summarise what changed.";
    const folder = await mkdtemp(join(tmpdir(), "sd-desktop-skill-"));
    const skillFile = join(folder, "SKILL.md");
    await writeFile(
      skillFile,
      `---\nname: ${name}\ndescription: ${description}\nlicense: MIT\n---\n\n# ${name}\n\n${firstInstructions}\n`,
      "utf8",
    );

    await seedDesktopOrigin(page);
    await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-desktop:locale", "zh-CN"));
    // The desktop entry has no Electron bridge, so saving a Skill uses the
    // browser's own save picker. There is no native dialog to drive from a
    // test, so the picker is replaced with one that records what it was asked
    // to write; the export still has to produce a real ZIP for that write.
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async (options?: { suggestedName?: string }) => {
          const written: { bytes?: number; head?: string; name?: string } = {
            name: options?.suggestedName,
          };
          (window as unknown as { __exportedSkill?: typeof written }).__exportedSkill = written;
          return {
            createWritable: async () => ({
              close: async () => undefined,
              write: async (blob: Blob) => {
                const bytes = new Uint8Array(await blob.arrayBuffer());
                written.bytes = bytes.byteLength;
                written.head = String.fromCharCode(...bytes.slice(0, 2));
              },
            }),
          };
        },
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });

    // An empty model catalog is the setup wizard, and 技能 lives in the shell
    // behind it, so the journey registers one placeholder profile and one
    // Project up front. No model call happens: the endpoint is deliberately
    // unreachable and nothing here ever sends a message.
    const model = await api<{ id: string }>(page, "/api/models", {
      data: {
        apiToken: "journey-placeholder",
        apiVariant: "openai",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "journey-placeholder",
        name: `desk-skill-model-${Date.now()}`,
      },
      method: "POST",
    });
    const workspace = await api<{ firstSession: { id: string }; id?: string; project?: { id: string } }>(
      page,
      "/api/projects",
      { data: { name: `desk-skill-workspace-${Date.now()}` }, method: "POST" },
    );
    const projectId = workspace.project?.id ?? workspace.id;

    journey.scenario({
      goal: "一位桌面用户把单个 SKILL.md 导入已安装的技能目录，在「设置 › 技能」里打开它的详情页读完说明，"
        + "再从条目的下三角菜单编辑指令、导出技能包，最后删除它；保存后新指令生效，"
        + "表单没有展示的 frontmatter 字段（如许可证）不丢。",
      preconditions: [
        "隔离栈已启动，桌面入口由本旅程自行启动",
        "已通过 API 注册一个占位模型档案与一个项目，仅用于越过首次配置向导",
        "待导入的 SKILL.md 当场写到临时目录",
        "本旅程不调用任何模型",
      ],
    });

    const settings = page.getByRole("dialog", { name: copy.settings, exact: true });
    let id: string | undefined;

    try {
      await journey.step(
        "打开桌面设置里的技能页",
        "技能列表可用，并且还没有这次要导入的那一个。",
        async () => {
          await page.goto(DESKTOP_ORIGIN);
          await page.locator('.rail-item[data-guide="settings"]').click();
          await settings.getByRole("navigation", { name: copy.nav })
            .getByRole("button", { name: new RegExp(`^${copy.skills}$`) }).click();
          await expect(settings.locator(".settings-list")).toBeVisible();
          await expect(settings.locator(".settings-card").filter({ hasText: name })).toHaveCount(0);
        },
      );

      await journey.step(
        "用添加技能 › 上传技能导入一个 SKILL.md",
        "上传页说明这次装入的是哪一个技能。",
        async () => {
          await settings.getByRole("button", { name: copy.add, exact: true }).click();
          await page.getByRole("menuitem", { name: new RegExp(copy.upload) }).click();
          const dialog = settings.getByRole("dialog", { name: copy.upload });
          await expect(dialog).toBeVisible();
          await dialog.locator('input[type="file"]').setInputFiles(skillFile);
          await dialog.getByRole("button", { name: "确定", exact: true }).click();
          // The dialog closes itself once the package lands, and a notice
          // names it; the list is on screen again underneath.
          await expect(dialog).toHaveCount(0);
          await expect(settings.locator(".skill-toast")).toContainText(name);
          await expect(settings.locator(".settings-list")).toBeVisible();
        },
      );

      await journey.step(
        "打开这张技能卡片的详情页",
        "页面以技能名命名、沿用 SKILL.md 里的描述，顶部栏标出「技能 › 技能名」，SKILL.md 正文就渲染在「文件」下。",
        async () => {
          const card = settings.locator(".settings-card").filter({ hasText: name });
          await expect(card).toHaveCount(1, { timeout: 30_000 });
          await expect(card).toContainText(description);
          await card.locator(".settings-card-main").click();
          // The page owns its way out: 返回 sits at the top of its column, and
          // the name and its actions are the first line under it.
          const pageHead = settings.locator(".skill-detail-page-head");
          await expect(settings.locator(".skill-detail-back")).toBeVisible();
          await expect(pageHead.getByRole("heading", { name, exact: true })).toBeVisible();
          // 基本信息 opens on the body of SKILL.md, as the handoff draws it.
          await expect(settings.getByRole("tab", { name: "基本信息", exact: true }))
            .toHaveAttribute("aria-selected", "true");
          // The page is a document in the pane's own column. A wide table or a
          // long path inside a SKILL.md must scroll inside the prose; before
          // the column was measured, one such line pushed the whole page
          // sideways and the pane clipped the instructions at the right edge.
          const overflow = await settings.locator(".settings-group-detail").evaluate(
            (element) => element.scrollWidth - element.clientWidth,
          );
          expect(overflow, "the Skill page overflows the settings pane horizontally").toBe(0);
          await expect(settings.locator(".skill-detail-doc")).toContainText(firstInstructions);
          await expect(settings.locator(".skill-detail-facts")).toContainText("MIT");
          // 技能详情 puts the package's files beside the open one; this
          // package is SKILL.md alone, so the tree has one file.
          await settings.getByRole("tab", { name: "技能详情", exact: true }).click();
          await expect(settings.locator(".skill-file-tree")).toContainText("SKILL.md");
          await expect(settings.locator(".skill-file-head")).toContainText("SKILL.md");
          await settings.getByRole("tab", { name: "基本信息", exact: true }).click();
          await settings.locator(".skill-detail-back").click();
        },
      );

      await journey.step(
        "从条目右侧的下三角菜单打开编辑",
        "菜单列出导出、编辑、删除，编辑页以技能名命名。",
        async () => {
          await openRowMenu(settings, name);
          await expect(settings.getByRole("menuitem", { name: copy.delete, exact: true })).toBeVisible();
          await chooseMenuItem(settings, copy.edit);
          // The trail bar names the editor; the page itself opens on 名称.
          await expect(settings.locator(".skill-pane-bar .skill-breadcrumb"))
            .toContainText(`编辑 ${name}`);
          await expect(settings.getByRole("button", { name: copy.save, exact: true })).toBeVisible();
        },
      );

      await journey.step(
        "改写指令并保存",
        "编辑器报告已保存。",
        async () => {
          const instructions = settings.getByLabel(copy.instructions, { exact: true });
          await expect(instructions).toHaveValue(new RegExp(firstInstructions.replace(/\./g, "\\.")));
          await instructions.fill(editedInstructions);
          await settings.getByRole("button", { name: copy.save, exact: true }).click();
          await expect(settings.locator("small.row-note[role=status]")).toContainText(copy.saved);
          await settings.getByRole("button", { name: copy.back, exact: true }).click();
        },
      );

      await journey.step(
        "从同一个菜单导出这个技能包",
        "导出的 ZIP 以技能名命名并且确实是压缩包。",
        async () => {
          await openRowMenu(settings, name);
          await chooseMenuItem(settings, copy.export);
          await page.waitForFunction(
            () => Boolean((window as unknown as { __exportedSkill?: unknown }).__exportedSkill),
          );
          const exported = await page.evaluate(
            () => (window as unknown as { __exportedSkill?: { bytes?: number; head?: string; name?: string } }).__exportedSkill,
          );
          expect(exported?.name).toBe(`${name}.zip`);
          // A ZIP starts with "PK": the save produced the archive itself, not
          // an empty or HTML error page.
          expect(exported?.head).toBe("PK");
          expect(exported?.bytes ?? 0).toBeGreaterThan(0);
          await expect(settings.locator(".skill-export-status[role=status]")).toContainText(`已导出「${name}」`);
        },
      );

      await journey.step(
        "通过 API 读回这个技能包",
        "新指令已装进技能包，而编辑表单没有展示的 license 仍在 frontmatter 里。",
        async () => {
          const installed = await api<InstalledSkill[]>(page, "/api/skills");
          id = installed.find((skill) => skill.name === name)?.id;
          expect(id, "the imported Skill is readable through the API").toBeTruthy();
          const detail = await api<InstalledSkill>(page, `/api/skills/${encodeURIComponent(id!)}`);
          expect(detail.instructions?.trim()).toBe(editedInstructions);
          expect(detail.frontmatter?.license).toBe("MIT");
        },
      );

      await journey.step(
        "从菜单删除这个技能",
        "确认对话框说明后果；确认后卡片消失，技能目录里也不再列出它。",
        async () => {
          await openRowMenu(settings, name);
          await chooseMenuItem(settings, copy.delete);
          const confirm = page.getByRole("dialog", { name: `删除「${name}」`, exact: true });
          await expect(confirm).toBeVisible();
          await confirm.getByRole("button", { name: copy.delete, exact: true }).click();
          await expect(settings.locator("small.row-note[role=status]")).toContainText(`已删除「${name}」`);
          await expect(settings.locator(".settings-card").filter({ hasText: name })).toHaveCount(0);
          const installed = await api<InstalledSkill[]>(page, "/api/skills");
          expect(installed.some((skill) => skill.name === name)).toBe(false);
          id = undefined;
        },
      );
    } finally {
      const installedId = id ?? await api<InstalledSkill[]>(page, "/api/skills")
        .then((skills) => skills.find((skill) => skill.name === name)?.id)
        .catch(() => undefined);
      if (installedId) {
        await api(page, `/api/skills/${encodeURIComponent(installedId)}`, { method: "DELETE" })
          .catch(() => undefined);
      }
      if (projectId) {
        await api(page, `/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" })
          .catch(() => undefined);
      }
      await api(page, `/api/models/${encodeURIComponent(model.id)}`, { method: "DELETE" })
        .catch(() => undefined);
      await rm(folder, { force: true, recursive: true });
    }
  });
});

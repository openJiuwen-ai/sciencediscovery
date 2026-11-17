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

import { expect } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import { api, DESKTOP_ORIGIN, seedDesktopOrigin, startDesktopEntry, stopDesktopEntry } from "./helpers/desktop-evolve.ts";

const copy = {
  close: "关闭设置",
  edit: "编辑",
  importAction: "导入",
  importTitle: "导入技能",
  instructions: "指令",
  nav: "设置目录",
  save: "保存",
  saved: "已保存。",
  settings: "设置",
  skills: "技能",
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
   * Purpose: A desktop user imports a SKILL.md into the installed catalog, finds it in 设置 › 技能, edits its
   *   instructions in place, and the saved package keeps the frontmatter keys the editor's form does not show.
   * Steps:
   *   1. Open 设置 › 技能 on the desktop entry; the Skill about to be imported is not listed.
   *   2. 导入技能 › SKILL.md: hand the dialog one file; the import reports the package by name.
   *   3. Close the dialog and find the card, then open 编辑 on it.
   *   4. Rewrite 指令 and 保存; the editor reports the save.
   *   5. Read the package back through the API: the new instructions are installed and `license` survived the save.
   * Environment: Immutable compiled isolated API at E2E_BASE_URL; desktop Vite on 4178; zh-CN at 1440x900.
   * Type: mocked
   * LLM: none — importing and editing a Skill package never calls a model.
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none; non-local browser requests are blocked.
   * Credentials: E2E_API_TOKEN for the isolated stack only.
   * CostSideEffects: no external cost; the imported Skill is deleted in finally.
   */
  test("desktop: import a SKILL.md and edit it in place", { tag: "@mocked" }, async ({ journey, page }) => {
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
      goal: "一位桌面用户把单个 SKILL.md 导入已安装的技能目录，在「设置 › 技能」里找到它，"
        + "直接改写指令并保存；保存后新指令生效，表单没有展示的 frontmatter 字段（如许可证）不丢。",
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
        "用 SKILL.md 导入一个技能",
        "导入对话框说明这次装入的是哪一个技能。",
        async () => {
          await settings.getByRole("button", { name: copy.importTitle, exact: true }).click();
          const dialog = page.getByRole("dialog", { name: copy.importTitle, exact: true });
          await expect(dialog).toBeVisible();
          await dialog.locator('input[type="file"]').setInputFiles(skillFile);
          await dialog.getByRole("button", { name: copy.importAction, exact: true }).click();
          await expect(dialog.getByRole("status")).toContainText(name);
          await dialog.getByRole("button", { name: copy.close, exact: true }).click();
        },
      );

      await journey.step(
        "在列表里找到这张技能卡片并打开编辑",
        "卡片带上了 SKILL.md 里的描述，编辑对话框以技能名命名。",
        async () => {
          const card = settings.locator(".settings-card").filter({ hasText: name });
          await expect(card).toHaveCount(1, { timeout: 30_000 });
          await expect(card).toContainText(description);
          await card.getByRole("button", { name: copy.edit, exact: true }).click();
          await expect(page.getByRole("dialog", { name: `编辑「${name}」`, exact: true })).toBeVisible();
        },
      );

      await journey.step(
        "改写指令并保存",
        "编辑器报告已保存，对话框收起了原来的指令。",
        async () => {
          const editor = page.getByRole("dialog", { name: `编辑「${name}」`, exact: true });
          const instructions = editor.getByLabel(copy.instructions, { exact: true });
          await expect(instructions).toHaveValue(new RegExp(firstInstructions.replace(/\./g, "\\.")));
          await instructions.fill(editedInstructions);
          await editor.getByRole("button", { name: copy.save, exact: true }).click();
          await expect(editor.getByRole("status")).toContainText(copy.saved);
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

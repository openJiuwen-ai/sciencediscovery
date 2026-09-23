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

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-skill-folder-import.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

/** Write one importable folder on disk; the browser is handed the directory, not a ZIP. */
async function writeSkillFolder(root: string, files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

/**
 * E2E-META
 * Purpose: A user can hand the product a local Skill folder and find that Skill installed with its supporting files, and gets a readable reason when the folder is not one.
 * Steps:
 *   1. Open System settings and the Skills group; the Skill is not installed yet.
 *   2. Pick a folder without SKILL.md and read the refusal; nothing is installed.
 *   3. Pick the prepared Skill folder; the Skills Explorer opens on it and its file tree carries both packaged files.
 *   4. Close the Explorer and find the Skill card in the list with its description, and the installed count one higher.
 * Environment: Isolated local stack at E2E_BASE_URL; folders are written into a temporary directory and uploaded through the browser.
 * Type: mocked
 * LLM: none — importing a Skill package never calls a model.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — the upload goes to the isolated local API and non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN for the isolated local API only.
 * CostSideEffects: no external cost; the imported Skill is deleted in finally.
 */
test("J11 本地 Skill 文件夹可以直接导入", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));
  const skillName = `folder-import-${Date.now()}`;
  const description = "Imported from a local folder by the J11 journey.";
  const noteText = "# Field notes\n\nStep two reads this supporting file.\n";
  // Not under testInfo.outputPath(): that path carries this test's Chinese title, and Chromium's directory upload
  // (setInputFiles on a webkitdirectory input) never returns for a path with non-ASCII characters, so the journey
  // timed out before the product saw a file.
  const folders = await mkdtemp(join(tmpdir(), "sd-skill-folder-"));
  const skillFolder = await writeSkillFolder(join(folders, `valid/${skillName}`), {
    "SKILL.md": `---\nname: ${skillName}\ndescription: ${description}\n---\n\n# ${skillName}\n\nRead reference/notes.md before starting.\n`,
    "reference/notes.md": noteText,
  });
  const notASkillFolder = await writeSkillFolder(join(folders, "invalid/loose-notes"), {
    "readme.md": "# Loose notes\n\nThis folder has no SKILL.md.\n",
  });

  const api = async (path: string, method = "GET") => {
    const response = await page.request.fetch(apiBaseUrl() + path, { headers: authorizationHeader(), method });
    expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
    return response.json() as Promise<unknown>;
  };

  journey.scenario({
    goal: "一位用户在本机整理好了一个 Skill 目录（SKILL.md 加一个参考文件），想直接把整个目录交给产品，"
      + "导入后能在 Skill 列表里找到它、并且里面的参考文件也在；如果拿错了目录，要当场看懂为什么不行。",
    preconditions: [
      "隔离栈已启动，Skill 库为该次运行独占的初始状态",
      "两个待选目录由本旅程当场写到运行输出目录：一个是合规 Skill 目录，一个只有 readme.md",
      "本旅程不调用任何模型",
    ],
  });

  const importFolderInput = page.locator("input[webkitdirectory]");
  const manager = page.locator(".skill-catalog-manager");
  const skillCard = manager.locator("button.skill-card").filter({ hasText: skillName });
  const installedStat = manager.locator(".skill-manager-stats span").filter({ hasText: "已安装" }).locator("strong");
  let importedSkillId: string | undefined;
  let installedBefore = 0;

  try {
    await journey.step(
      "打开设置里的 Skills 页面",
      "Skill 管理器显示当前已安装的 Skill，其中还没有这次要导入的那一个。",
      async () => {
        await page.goto("/");
        await page.getByRole("button", { name: /^系统设置/ }).click();
        const dialog = page.getByRole("dialog", { name: "系统设置", exact: true });
        await dialog.getByRole("navigation", { name: "设置分组" }).getByRole("button", { name: /^Skills/ }).click();
        await expect(manager).toBeVisible();
        await expect(skillCard).toHaveCount(0);
        installedBefore = Number(await installedStat.innerText());
        expect(Number.isInteger(installedBefore)).toBe(true);
      },
    );

    await journey.step(
      "先拿一个不是 Skill 的目录试试",
      "产品不接收它，并且直接说清楚原因：目录根下必须有 SKILL.md；列表里也没有多出任何东西。",
      async () => {
        await importFolderInput.setInputFiles(notASkillFolder);
        await expect(manager.locator("p.skill-manager-error")).toContainText("SKILL.md");
        await expect(skillCard).toHaveCount(0);
      },
    );

    await journey.step(
      "把整理好的 Skill 目录交给产品",
      "导入完成后 Skill 资源浏览器直接打开这个 Skill，文件树里既有 SKILL.md，也有目录下的 reference/notes.md——"
        + "说明整个目录被打包上传并在服务端完整解开了。",
      async () => {
        await importFolderInput.setInputFiles(skillFolder);
        const explorer = page.getByRole("dialog", { name: "Skill 资源浏览器" });
        await expect(explorer).toBeVisible({ timeout: 30_000 });
        const fileTree = explorer.getByRole("navigation", { name: "Skill 包文件树" });
        await expect(fileTree).toContainText("SKILL.md");
        await fileTree.locator("button.skill-file-tree-folder").filter({ hasText: "reference" }).click();
        await fileTree.locator("button.skill-file-tree-file").filter({ hasText: "notes.md" }).click();
        await expect(explorer.getByLabel("编辑 Skill 文件 reference/notes.md")).toHaveValue(noteText);
        const skills = await api("/api/skills") as Array<{ id: string; name: string }>;
        importedSkillId = skills.find((skill) => skill.name === skillName)?.id;
        expect(importedSkillId, "the imported Skill must be readable through the API a user's client uses").toBeTruthy();
      },
    );

    await journey.step(
      "关掉浏览器，确认它留在了 Skill 列表里",
      "列表里出现这张 Skill 卡片，写着 SKILL.md 里的描述，已安装计数也随之增加。",
      async () => {
        await page.getByRole("button", { name: "关闭 Skill 浏览器", exact: true }).click();
        await expect(skillCard).toHaveCount(1);
        await expect(skillCard).toContainText(description);
        await expect(installedStat).toHaveText(String(installedBefore + 1));
      },
    );
  } finally {
    // A failure between the upload and the id lookup still leaves the Skill
    // installed, so resolve it by name rather than trusting the earlier step.
    const installed = importedSkillId ?? await api("/api/skills")
      .then((skills) => (skills as Array<{ id: string; name: string }>).find((skill) => skill.name === skillName)?.id)
      .catch(() => undefined);
    if (installed) {
      await page.request.fetch(`${apiBaseUrl()}/api/skills/${encodeURIComponent(installed)}`, {
        headers: authorizationHeader(),
        method: "DELETE",
      }).catch(() => undefined);
    }
    await rm(folders, { force: true, recursive: true });
  }
});

});

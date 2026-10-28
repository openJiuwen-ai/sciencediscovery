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
 * The three-dimensional view a structure file opens into.
 *
 * It cannot be a static case: the component imports Mol*'s stylesheet and
 * starts a second React root, neither of which runs under the test runner's
 * Node module loader. What is worth proving is the box around it — which files
 * get one, what the badge says, and the two ways into the full-screen view.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import { TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession, type JsonRecord } from "./fixtures.js";

/** Two atoms of alanine, enough for Mol* to recognise a PDB. */
const PDB = [
  "ATOM      1  CA  ALA A   1      11.104  13.207   8.783  1.00 20.00           C",
  "ATOM      2  CB  ALA A   1      12.560  13.600   8.783  1.00 20.00           C",
  "END",
  "",
].join("\n");

function file(path: string): JsonRecord {
  return { modifiedAt: "2026-10-01T09:30:00.000Z", path, size: PDB.length };
}

async function openFile(page: Page, name: string): Promise<Locator> {
  await page.goto("/");
  await page.getByRole("button", { name: "工作区面板" }).click();
  const panel = page.locator(".workspace-panel");
  // The panel opens on 产物; a structure in the workspace is one tab away.
  await panel.getByRole("tab", { name: "工作区" }).click();
  await panel.getByRole("button", { name: new RegExp(name.replace(".", "\\."), "u") }).click();
  return panel;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("a structure file opens the viewer, and the box is the way into full screen", async ({ page }) => {
  await installMockApi(page, {
    fileContents: { "crystal.pdb": PDB },
    files: [file("crystal.pdb")],
    sessions: [makeSession()],
  });
  const panel = await openFile(page, "crystal.pdb");

  const viewer = panel.getByRole("group", { name: "crystal.pdb 的三维结构" });
  // Mol* is loaded on first use and is an order of magnitude larger than the
  // rest of the app, so the first structure in a dev server takes a while.
  await expect(viewer).toBeVisible({ timeout: 30_000 });
  // The badge names the format it read and, once the plugin is up, how many
  // atoms it holds. The count depends on Mol* finishing its load.
  await expect(viewer.locator(".molstar-badge")).toContainText("PDB");

  // A click on the model is a request for the whole window; a drag is a
  // rotation and must not be mistaken for one.
  await viewer.click({ position: { x: 4, y: 4 } });

  const full = panel.locator(".molstar-shell.is-fullscreen");
  await expect(full).toBeVisible();
  await expect(full).toContainText("crystal.pdb");
  const close = full.getByRole("button", { name: "退出全屏" });
  await expect(close).toBeVisible();

  // Escape is the second way out, beside the ✕.
  await page.keyboard.press("Escape");

  await expect(panel.locator(".molstar-shell.is-fullscreen")).toHaveCount(0);
  await expect(viewer).toBeVisible();
});

test("a file that is not a structure is shown as text, with no viewer", async ({ page }) => {
  await installMockApi(page, {
    fileContents: { "notes.txt": "晶格常数是 5.43 Å。" },
    files: [file("notes.txt")],
    sessions: [makeSession()],
  });
  const panel = await openFile(page, "notes.txt");

  await expect(panel.locator(".doc-body")).toContainText("晶格常数是 5.43 Å。");
  await expect(panel.getByRole("group", { name: /三维结构/u })).toHaveCount(0);
});

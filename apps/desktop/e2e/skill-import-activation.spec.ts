/**
 * E2E-META
 * Purpose: Prove on the real settings page, in both interface languages, that an installed Skill whose switch is refused says so where the user is looking, keeps the retry, and that a Git import's own failures survive the toast that reports the import.
 * Steps:
 *   1. 上传技能: install a package whose switch is refused, assert the dialog's notice and reason, capture frame 01, press 启用, assert the dialog closes on the success notice, capture frame 02.
 *   2. 从 GitHub 导入: run an import whose job switches the package on and is refused, assert the activation toast sits beside the import toast, capture frame 03, dismiss the import toast and assert the activation toast stays, capture frame 04.
 *   3. Inspect a repository, edit the URL, assert the read rows and the import are gone, capture frame 05.
 * Environment: Isolated Desktop Vite app with deterministic local API mocks; viewport 1440×900; Chinese and English UI.
 * Type: mocked
 * LLM: none; no model call is made.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none; the mock answers every /api/ request.
 * Credentials: none beyond the fixture's local token.
 * CostSideEffects: none; no network access beyond the local mock.
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
 * Issue #1442 at the browser level, in the two interface languages this app
 * ships.
 *
 * The unit suite pins the requests; this case pins what a person sees around
 * them, and only a browser can show it: the sentence and the reason standing
 * in the dialog that is still open, the dialog closing on the success notice
 * once 启用 works, the activation toast still on the pane after the import
 * toast that reported the same job is dismissed, and the Git dialog dropping
 * the rows it read once the repository field names another repository.
 *
 * The English run exists because the two dictionaries are separate strings;
 * the frames under `docs/screenshots/1442/` are these runs' captures.
 */
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { TOKEN, TOKEN_STORAGE_KEY, installMockApi } from "./fixtures.js";

/** The locale key and values `apps/desktop` itself stores and reads. */
const LOCALE_KEY = "sciencediscovery-desktop:locale";

const REPOSITORY = "https://github.com/lab/skills.git";
/** A second repository, for the one frame about a notice that names two
 *  packages: both of its switches are refused, so their names share a line. */
const TWO_REPOSITORY = "https://github.com/lab/two-skills.git";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** The two packages the repository carries. One page only: this journey is
 *  about a source edit, not about paging. */
const INSPECTION = {
  candidates: [
    { description: "Reads a CIF file", diagnostics: [], name: "cif-reader", status: "new", subdirectory: "skills/cif-reader" },
    { description: "Plots a band structure", diagnostics: [], name: "band-plot", status: "new", subdirectory: "skills/band-plot" },
  ],
  commit: COMMIT,
  repositoryUrl: REPOSITORY,
  total: 2,
};

const TWO_INSPECTION = {
  candidates: [
    { description: "Reads a CSV table", diagnostics: [], name: "alpha-skill", status: "new", subdirectory: "skills/alpha-skill" },
    { description: "Reads a JSON record", diagnostics: [], name: "beta-skill", status: "new", subdirectory: "skills/beta-skill" },
  ],
  commit: COMMIT,
  repositoryUrl: TWO_REPOSITORY,
  total: 2,
};

/** The job the pane reads back once the import ends. The package it created is
 *  the one JiuwenSwarm refuses to switch on. */
const FINISHED_JOB = {
  commit: COMMIT,
  done: 1,
  failures: [],
  finishedAt: "2026-01-01T00:00:05.000Z",
  id: "job-1",
  imported: [{ created: true, id: "band-plot" }],
  startedAt: "2026-01-01T00:00:00.000Z",
  status: "done",
  total: 1,
};

/** The second import: two packages, and JiuwenSwarm refuses both switches, so
 *  the pane reports one sentence with two names in it. */
const TWO_FINISHED_JOB = {
  commit: COMMIT,
  done: 2,
  failures: [],
  finishedAt: "2026-01-01T00:00:05.000Z",
  id: "job-2",
  imported: [{ created: true, id: "alpha-skill" }, { created: true, id: "beta-skill" }],
  startedAt: "2026-01-01T00:00:00.000Z",
  status: "done",
  total: 2,
};

interface Copy {
  readonly rail: string;
  readonly dialog: string;
  readonly group: string;
  readonly addSkill: string;
  readonly upload: string;
  readonly git: string;
  readonly chooseFile: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly importButton: string;
  readonly importSelected: string;
  readonly dismiss: string;
  readonly activationRetry: string;
  readonly activationRefused: string;
  readonly activationRefusedImport: string;
  readonly activationRefusedTwo: string;
  readonly switchFailed: string;
  readonly uploaded: string;
  readonly githubDone: string;
  readonly repositoryUrl: string;
  readonly inspect: string;
  readonly sourceChanged: string;
  readonly urlChanged: string;
  readonly frames: readonly [string, string, string, string, string, string, string];
}

const CHINESE: Copy = {
  activationRefused: "已安装，但未启用：cif-reader。",
  activationRefusedImport: "已安装，但未启用：band-plot。",
  activationRefusedTwo: "已安装，但未启用：alpha-skill、beta-skill。",
  activationRetry: "启用",
  addSkill: "添加技能",
  cancel: "取消",
  chooseFile: "选择文件",
  confirm: "确定",
  dialog: "设置",
  frames: [
    "01-upload-switch-refused.png",
    "02-upload-switched-on.png",
    "03-activation-toast-retained.png",
    "04-activation-toast-after-dismiss.png",
    "05-git-inspected.png",
    "06-git-rows-dropped-after-edit.png",
    "07-activation-two-refusals.png",
  ],
  git: "从 GitHub 导入",
  githubDone: "GitHub 技能导入成功！",
  group: "技能",
  dismiss: "关闭提示",
  importButton: "导入",
  importSelected: "导入选中的 2 项",
  inspect: "检查",
  rail: "设置",
  repositoryUrl: "仓库地址",
  switchFailed: "Skill switch failed",
  sourceChanged: "仓库地址、Ref 或子目录在检查后已改变。请重新检查后再导入。",
  upload: "上传技能",
  uploaded: "「cif-reader」上传成功！",
  urlChanged: "https://github.com/lab/other.git",
};

const ENGLISH: Copy = {
  activationRefused: "Installed, but not switched on: cif-reader.",
  activationRefusedImport: "Installed, but not switched on: band-plot.",
  activationRefusedTwo: "Installed, but not switched on: alpha-skill, beta-skill.",
  activationRetry: "Switch on",
  addSkill: "Add skill",
  cancel: "Cancel",
  chooseFile: "Choose file",
  confirm: "OK",
  dialog: "Settings",
  frames: [
    "01-upload-switch-refused-en.png",
    "02-upload-switched-on-en.png",
    "03-activation-toast-retained-en.png",
    "04-activation-toast-after-dismiss-en.png",
    "05-git-inspected-en.png",
    "06-git-rows-dropped-after-edit-en.png",
    "07-activation-two-refusals-en.png",
  ],
  git: "Import from GitHub",
  githubDone: "GitHub import done.",
  group: "Skills",
  dismiss: "Dismiss notice",
  importButton: "Import",
  importSelected: "Import 2 selected",
  inspect: "Inspect",
  rail: "Settings",
  repositoryUrl: "Repository URL",
  switchFailed: "Skill switch failed",
  sourceChanged: "The repository, ref or subdirectory changed after this inspection. Inspect again before importing.",
  upload: "Upload skills",
  uploaded: "\"cif-reader\" uploaded.",
  urlChanged: "https://github.com/lab/other.git",
};

const pane = (page: Page) => page.getByRole("dialog").locator(".settings-group-detail");

async function openSkills(page: Page, copy: Copy) {
  await page.getByRole("button", { name: copy.rail, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: copy.dialog });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: copy.group, exact: true }).click();
  await expect(dialog.locator(".settings-group-detail h3").first()).toHaveText(copy.group);
  return dialog;
}

/** 技能 › 添加技能 › <item>, the one place both import journeys start. */
async function openAddMenu(page: Page, copy: Copy, item: string) {
  await page.getByRole("button", { name: copy.addSkill, exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
  // The add menu opens a dialog of its own inside the settings shell, so the
  // item's name is also its accessible name.
  const dialog = page.getByRole("dialog", { name: item, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** One journey per language; only the copy differs. */
async function reportRefusedSwitch(page: Page, testInfo: TestInfo, copy: Copy) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const mock = await installMockApi(page, {
    // The package the upload installs; the switch on it is refused once, so
    // 启用 has something to fix.
    gitImportJob: FINISHED_JOB,
    gitImportJobs: { [TWO_REPOSITORY]: TWO_FINISHED_JOB },
    gitInspection: INSPECTION,
    gitInspections: { [TWO_REPOSITORY]: TWO_INSPECTION },
    jiuwenSwarmSkills: [],
    sessions: [],
    // The upload's switch is refused once, below, and then works; this one is
    // the package the import creates, which JiuwenSwarm will not switch on at
    // all. Two packages, two different reports.
    skillToggleFailures: ["band-plot", "alpha-skill", "beta-skill"],
    skills: [],
  });
  await page.goto("/");
  await openSkills(page, copy);

  // ---- 1. Upload: installed, but not switched on -------------------------
  const upload = await openAddMenu(page, copy, copy.upload);
  await upload.locator('input[type="file"]').setInputFiles({
    buffer: Buffer.from("# cif-reader\n\nReads a CIF file\n"),
    mimeType: "text/markdown",
    name: "cif-reader.md",
  });
  await expect(upload.getByText("cif-reader.md")).toBeVisible();
  // The first switch is refused; the retry the dialog offers is the recovery.
  mock.failNext("PUT", /\/api\/jiuwenswarm\/skills-by-id\//u, 502, copy.switchFailed);
  await upload.getByRole("button", { name: copy.confirm, exact: true }).click();

  const notice = upload.locator(".skill-activation-notice");
  await expect(notice).toBeVisible();
  // The sentence and its reason, not a success notice: the package is on disk
  // and the user cannot use it yet.
  await expect(notice).toContainText(copy.activationRefused);
  await expect(notice).toContainText(copy.switchFailed);
  // Once, and in the dialog: the pane behind it must not carry a second copy.
  await expect(page.getByText(copy.activationRefused)).toHaveCount(1);
  // The picker and 确定 are inert until the notice is answered: another file
  // here would clear the only account of why the package is off.
  await expect(upload.locator('input[type="file"]')).toBeDisabled();
  await expect(upload.getByRole("button", { name: copy.confirm, exact: true })).toBeDisabled();
  await expect(upload.locator(".skill-drop")).toHaveAttribute("aria-disabled", "true");
  // The pane's own toast column is empty: the dialog is the one place that
  // reports this failure, and no success notice was posted behind it.
  await expect(page.locator(".skill-toast")).toHaveCount(0);
  await upload.screenshot({ animations: "disabled", path: testInfo.outputPath(copy.frames[0]) });

  // ---- 2. 启用: the same request again, and the dialog closes ------------
  await notice.getByRole("button", { name: copy.activationRetry, exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole("dialog").filter({ hasText: copy.upload })).toHaveCount(0);
  const done = page.locator(".skill-toasts .skill-toast");
  await expect(done).toHaveCount(1);
  await expect(done.first()).toContainText(copy.uploaded);
  // The upload went up once; only the switch was repeated.
  const uploads = mock.calls.filter((call) => call.method === "POST" && call.path.startsWith("/api/skills/import"));
  expect(uploads).toHaveLength(1);
  await pane(page).screenshot({ animations: "disabled", path: testInfo.outputPath(copy.frames[1]) });
  // The upload's notice is news about a dialog that has closed, and it leaves
  // by itself after a few seconds. Dismissing it here keeps the next frame's
  // two notices exactly the import's own.
  await done.getByRole("button", { name: copy.dismiss }).click();
  await expect(done).toHaveCount(0);

  // ---- 3. A Git import whose switch is refused keeps both reports --------
  const git = await openAddMenu(page, copy, copy.git);
  await git.getByRole("textbox", { name: copy.repositoryUrl }).fill(REPOSITORY);
  await git.getByRole("button", { name: copy.inspect, exact: true }).click();
  await expect(git.locator(".skill-candidates input[type=checkbox]")).toHaveCount(2);
  await git.getByRole("button", { name: copy.importSelected, exact: true }).click();

  // The job ends and its dialog closes on the list. The import succeeded and the
  // switch of the package it created was refused, so the pane carries two
  // notices: the job's own result, and the package that cannot be used yet.
  await expect(page.getByRole("dialog", { name: copy.git, exact: true })).toHaveCount(0);
  const toasts = page.locator(".skill-toasts .skill-toast");
  await expect(toasts).toHaveCount(2);
  const activation = page.locator(".skill-toasts .skill-toast.is-error");
  await expect(activation).toContainText(copy.activationRefusedImport);
  await expect(activation).toContainText(copy.switchFailed);
  const imported = page.locator(".skill-toasts .skill-toast.is-success").filter({ hasText: copy.githubDone });
  await expect(imported).toHaveCount(1);
  await pane(page).screenshot({ animations: "disabled", path: testInfo.outputPath(copy.frames[2]) });

  // Dismissing the import's own notice must not take the activation report
  // with it: they are about two different things, and only one of them is
  // fixed by dismissing anything.
  await imported.getByRole("button", { name: copy.dismiss }).click();
  await expect(toasts).toHaveCount(1);
  await expect(activation).toContainText(copy.activationRefusedImport);
  await pane(page).screenshot({ animations: "disabled", path: testInfo.outputPath(copy.frames[3]) });

  // ---- 4. A source edit owns the dialog: no row survives it --------------
  const second = await openAddMenu(page, copy, copy.git);
  await second.getByRole("textbox", { name: copy.repositoryUrl }).fill(REPOSITORY);
  await second.getByRole("button", { name: copy.inspect, exact: true }).click();
  await expect(second.locator(".skill-candidates input[type=checkbox]")).toHaveCount(2);
  await expect(second.getByRole("button", { name: copy.importSelected, exact: true })).toBeEnabled();
  // Frame 5: what the dialog holds before the field moves — two rows read from
  // the repository above, both ticked, the import ready.
  await second.screenshot({ animations: "disabled", path: testInfo.outputPath(copy.frames[4]) });

  // The repository field names another repository now. The rows were read from
  // the first one, so they are gone and 导入 has nothing to send.
  await second.getByRole("textbox", { name: copy.repositoryUrl }).fill(copy.urlChanged);
  await expect(second.locator(".skill-candidates")).toHaveCount(0);
  await expect(second.locator(".skill-git-results")).toHaveCount(0);
  // The rows are gone and the dialog says why, as a note rather than an error:
  // editing the source is normal, only its consequence needs saying.
  const note = second.locator('[role="status"]', { hasText: copy.sourceChanged });
  await expect(note).toHaveCount(1);
  await expect(note).toHaveClass(/row-note/u);
  await expect(note).toHaveClass(/skill-git-note/u);
  await expect(note).not.toHaveClass(/is-error/u);
  await expect(second.getByRole("button", { name: copy.importButton, exact: true })).toBeDisabled();
  await second.screenshot({ animations: "disabled", path: testInfo.outputPath(copy.frames[5]) });

  // ---- 5. One notice, two refused packages -------------------------------
  // The sentence is the dictionary's own, so its separator has to be readable
  // in the language of the frame: two names, one line.
  await second.getByRole("button", { name: copy.cancel, exact: true }).click();
  await activation.getByRole("button", { name: copy.dismiss }).click();
  await expect(toasts).toHaveCount(0);

  const two = await openAddMenu(page, copy, copy.git);
  await two.getByRole("textbox", { name: copy.repositoryUrl }).fill(TWO_REPOSITORY);
  await two.getByRole("button", { name: copy.inspect, exact: true }).click();
  await expect(two.locator(".skill-candidates input[type=checkbox]")).toHaveCount(2);
  await two.getByRole("button", { name: copy.importSelected, exact: true }).click();
  await expect(page.getByRole("dialog", { name: copy.git, exact: true })).toHaveCount(0);

  const both = page.locator(".skill-toasts .skill-toast.is-error");
  await expect(toasts).toHaveCount(2);
  await expect(both).toContainText(copy.activationRefusedTwo);
  // The import's own notice goes; the two-name sentence stays on its own, so
  // the frame shows the sentence rather than the pair of notices again.
  await page.locator(".skill-toasts .skill-toast.is-success")
    .getByRole("button", { name: copy.dismiss })
    .click();
  await expect(toasts).toHaveCount(1);
  await expect(both).toContainText(copy.activationRefusedTwo);
  await pane(page).screenshot({ animations: "disabled", path: testInfo.outputPath(copy.frames[6]) });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("a refused switch is reported in the upload dialog and in the import's own notice", async ({ page }, testInfo) => {
  await reportRefusedSwitch(page, testInfo, CHINESE);
});

test("the same two reports hold in English", async ({ page }, testInfo) => {
  await page.addInitScript((key) => localStorage.setItem(key, "en"), LOCALE_KEY);
  await reportRefusedSwitch(page, testInfo, ENGLISH);
});

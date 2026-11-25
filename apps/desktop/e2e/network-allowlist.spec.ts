/**
 * E2E-META
 * Purpose: Prove on the real settings page, in both interface languages, that 无网络 / No network keeps a saved allowlist and only 开放网络 / Open network clears it.
 * Steps:
 *   1. Open 设置 › 网络 / Settings › Sandbox network with a saved allowlist, read the box and capture frame 01.
 *   2. Press 无网络 / No network, assert the pill, the inert box, the absent hint and the recorded write, and capture frame 02.
 *   3. Press 域名白名单 / Domain allowlist, assert the hosts are back, capture frame 03, then press 保存 / Save and assert the write.
 * Environment: Isolated Desktop Vite app with deterministic local API mocks; viewport 1440×900; Chinese and English UI.
 * Type: mocked
 * LLM: none; no model call is made.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none; the mock answers every /api/ request.
 * Credentials: none beyond the fixture's local token.
 * CostSideEffects: none; hostnames only, no network access.
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
 * Issue #1399 at the browser level, in the two interface languages this app
 * ships.
 *
 * The unit suite pins the requests this page sends; this case pins what a
 * person sees around the same press: the box carries the saved hosts, 无网络
 * leaves it inert and empty *without* claiming the list is empty, and picking
 * 域名白名单 again brings the hosts back so 保存 can write them.
 *
 * The hint matters as much as the hosts. "至少填写一个允许的域名" is the page's
 * own error for an empty list, so a mode press that raised it would have made
 * the UI invent the condition it warns about. The English run exists because
 * the two dictionaries are separate: the same states must hold when every
 * label on the pane is a different string.
 *
 * The screenshots each run writes are copied unchanged into
 * `docs/screenshots/1399/` as the PR's review evidence; they are captures, not
 * assertions, so a failed run can still fail before any of them exists.
 */
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { TOKEN, TOKEN_STORAGE_KEY, installMockApi, type Mock } from "./fixtures.js";

/** Deliberately not the field's placeholder (`example.org`,
 *  `*.example.org:443`): in 无网络 the box is empty and shows that grey
 *  placeholder, and a saved list spelled the same way would make the capture
 *  read as though the hosts were still on screen. */
const SAVED = ["pypi.org", "*.pythonhosted.org:443"];

/** The locale key and values `apps/desktop` itself stores and reads. */
const LOCALE_KEY = "sciencediscovery-desktop:locale";

interface Copy {
  readonly rail: string;
  readonly dialog: string;
  readonly group: string;
  readonly none: string;
  readonly allowlist: string;
  readonly domains: string;
  readonly hint: string;
  readonly save: string;
  readonly saved: string;
  /** Frame file names, in the order the journey takes them. */
  readonly frames: readonly [string, string, string];
}

const CHINESE: Copy = {
  rail: "设置",
  dialog: "设置",
  group: "沙箱网络",
  none: "无网络",
  allowlist: "域名白名单",
  domains: "允许的域名",
  hint: "至少填写一个允许的域名。",
  save: "保存",
  saved: "沙箱网络已保存",
  frames: ["01-allowlist-saved.png", "02-none-inert-no-hint.png", "03-allowlist-restored.png"],
};

const ENGLISH: Copy = {
  rail: "Settings",
  dialog: "Settings",
  group: "Sandbox network",
  none: "No network",
  allowlist: "Domain allowlist",
  domains: "Allowed domains",
  hint: "Add at least one allowed domain.",
  save: "Save",
  saved: "Sandbox network saved",
  frames: ["01-allowlist-saved-en.png", "02-none-inert-no-hint-en.png", "03-allowlist-restored-en.png"],
};

const networkPuts = (mock: Mock) =>
  mock.calls
    .filter((call) => call.method === "PUT" && call.path === "/api/sandbox-network-settings")
    .map((call) => JSON.parse(call.body ?? "{}") as { allowedDomains?: string[]; mode?: string });

const pane = (page: Page) => page.getByRole("dialog").locator(".settings-group-detail");

async function openNetworkSettings(page: Page, copy: Copy) {
  await page.getByRole("button", { name: copy.rail, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: copy.dialog });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: copy.group, exact: true }).click();
  // The pane draws the group name twice: once as its own header, once as the
  // group's heading. Either proves the pane switched; the first is the header.
  await expect(dialog.locator(".settings-group-detail h3").first()).toHaveText(copy.group);
  return dialog;
}

const pill = (page: Page, label: string) => page.getByRole("dialog").getByRole("button", { name: label, exact: true });
const domainsBox = (page: Page, copy: Copy) =>
  page.getByRole("dialog").getByRole("textbox", { name: copy.domains });

/** The journey is one function because only the copy differs between the two
 *  runs: same viewport, same fixture, same presses, same assertions. */
async function keepAllowlistAcrossNone(page: Page, testInfo: TestInfo, copy: Copy) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const mock = await installMockApi(page, {
    sandboxNetwork: { allowedDomains: [...SAVED], mode: "domain-allowlist" },
    sessions: [],
  });
  await page.goto("/");

  await openNetworkSettings(page, copy);
  const box = domainsBox(page, copy);
  await expect(box).toBeEnabled();
  await expect(box).toHaveValue(SAVED.join("\n"));
  // Frame 1: the list the policy holds, in the mode that owns it.
  await pane(page).screenshot({ animations: "disabled", path: testInfo.outputPath(copy.frames[0]) });

  // No network: the pill moves, the box goes inert and empty, and nothing
  // claims the list was lost.
  await pill(page, copy.none).click();
  await expect(pill(page, copy.none)).toHaveAttribute("aria-pressed", "true");
  await expect(box).toBeDisabled();
  await expect(box).toHaveValue("");
  await expect(page.getByText(copy.hint)).toHaveCount(0);
  await expect(page.locator(".row-note.is-error")).toHaveCount(0);
  // Frame 2: the inert box and the absent hint, which is what the mode press
  // itself must not turn into a loss.
  await pane(page).screenshot({ animations: "disabled", path: testInfo.outputPath(copy.frames[1]) });

  // The write carries the saved hosts: the mode changed, the list did not.
  await expect.poll(() => mock.state.sandboxNetwork).toEqual({ allowedDomains: SAVED, mode: "none" });
  expect(networkPuts(mock)).toHaveLength(1);
  expect(networkPuts(mock)[0]).toMatchObject({ allowedDomains: SAVED, mode: "none" });

  // Back to the allowlist: staged only, and the hosts are on screen again.
  await pill(page, copy.allowlist).click();
  await expect(box).toBeEnabled();
  await expect(box).toHaveValue(SAVED.join("\n"));
  expect(networkPuts(mock)).toHaveLength(1);
  // Frame 3: the same two hosts after the round trip through No network.
  await pane(page).screenshot({ animations: "disabled", path: testInfo.outputPath(copy.frames[2]) });

  await pane(page).getByRole("button", { name: copy.save, exact: true }).click();
  // Both writes toast the same sentence, and the earlier one may still be on
  // screen while the list is a toast per press rather than one replaced.
  await expect(page.locator(".toast.toast-info").last()).toContainText(copy.saved);
  await expect.poll(() => mock.state.sandboxNetwork).toEqual({ allowedDomains: SAVED, mode: "domain-allowlist" });
  expect(networkPuts(mock)).toHaveLength(2);
  expect(networkPuts(mock)[1]).toMatchObject({ allowedDomains: SAVED, mode: "domain-allowlist" });
  await expect(page.getByText(copy.hint)).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("无网络 keeps the saved allowlist and 开放网络 is the only mode that clears it", async ({ page }, testInfo) => {
  await keepAllowlistAcrossNone(page, testInfo, CHINESE);
});

test("No network keeps the saved allowlist and only Open network clears it (English UI)", async ({ page }, testInfo) => {
  await page.addInitScript((key) => localStorage.setItem(key, "en"), LOCALE_KEY);
  await keepAllowlistAcrossNone(page, testInfo, ENGLISH);
});

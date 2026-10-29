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
 * Getting a file into the session's workspace, and the ceiling that can refuse
 * it before the request is made. The picker is the same `uploadFiles` path the
 * drop overlay and the panel use.
 */
import { expect, test, type Page } from "@playwright/test";

import { TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession } from "./fixtures.js";

/** A drag carrying one file. The overlay reads `DataTransfer.types`, so the
 *  transfer has to be a real one rather than an empty object. */
function transfer(page: Page, name: string) {
  return page.evaluateHandle((fileName) => {
    const data = new DataTransfer();
    data.items.add(new File(["a,b\n1,2\n"], fileName, { type: "text/csv" }));
    return data;
  }, name);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("a chosen file is uploaded to the open session and held in the composer's tray", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");
  // A resumed Session replaces the composer's state when it opens, and with it
  // the files waiting there — so the gesture has to wait for that to have
  // happened. The sidebar marks the row of the Session that is open.
  await expect(page.locator(".side-row.is-active .side-session-name")).toHaveCount(1);

  // The actual gesture: the composer's attach button opens the picker.
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传文件" }).click();
  await (await chooserPromise).setFiles({
    buffer: Buffer.from("a,b\n1,2\n"),
    mimeType: "text/csv",
    name: "data.csv",
  });

  // The card is the receipt: it says the file landed, and where it went is the
  // panel's business, not a toast the user has to catch.
  const card = page.locator(".attach-card");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".attach-name")).toHaveText("data.csv");
  await expect(card.locator(".attach-meta")).toHaveText("CSV 8B");
  expect(mock.state.files.map((file) => (file as { path: string }).path)).toEqual(["data.csv"]);
  expect(
    mock.calls.some(
      (call) =>
        call.method === "POST" &&
        call.path === "/api/sessions/session-1/workspace/upload",
    ),
  ).toBe(true);
});

test("a file over the health-reported ceiling is refused without a request", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");

  // The fixture reports a 10 MiB ceiling; go one byte over it.
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传文件" }).click();
  await (await chooserPromise).setFiles({
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
    mimeType: "application/octet-stream",
    name: "sample.bin",
  });

  await expect(page.getByText("sample.bin 超过 10 MiB，没有上传。", { exact: false })).toBeVisible();
  expect(mock.state.files).toHaveLength(0);
  expect(
    mock.calls.some((call) => call.path.endsWith("/workspace/upload")),
  ).toBe(false);
});

test("a file dragged over the window is announced, and dropping it uploads it", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");
  // See the first test: the resumed Session takes the tray with it when it opens.
  await expect(page.locator(".side-row.is-active .side-session-name")).toHaveCount(1);

  const dragged = await transfer(page, "dropped.csv");
  await page.dispatchEvent("body", "dragenter", { dataTransfer: dragged });

  // The whole window is the target, and the card says what will happen before
  // the reader commits to it.
  await expect(page.locator(".drop-overlay")).toBeVisible();
  await expect(page.getByText("松开即上传")).toBeVisible();
  await expect(page.getByText("单个文件最大 10 MiB", { exact: false })).toBeVisible();

  await page.dispatchEvent("body", "drop", { dataTransfer: dragged });

  await expect(page.locator(".drop-overlay")).toHaveCount(0);
  await expect(page.locator(".attach-card .attach-name")).toHaveText("dropped.csv");
  expect(mock.state.files.map((file) => (file as { path: string }).path)).toEqual(["dropped.csv"]);
});

test("a dropped file with path segments uploads only its basename", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await test.step("1. Open the conversation workspace", async () => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "上传文件" })).toBeVisible();
    // See the first test: the resumed Session takes the tray with it when it
    // opens, so the drop has to wait for that to have happened.
    await expect(page.locator(".side-row.is-active .side-session-name")).toHaveCount(1);
  });
  await test.step("2. Drop a file whose name contains parent path segments", async () => {
    const dragged = await transfer(page, "../outside.csv");
    await page.dispatchEvent("body", "dragenter", { dataTransfer: dragged });
    await page.dispatchEvent("body", "drop", { dataTransfer: dragged });
  });
  await test.step("3. Confirm the uploaded workspace path is a basename", async () => {
    // The card is the receipt, as it is for every other upload. It has to read
    // as stored: the answer names the file by the segment the request sent, and
    // a card that did not match that name would say 上传失败 about bytes that are
    // already in the workspace.
    const card = page.locator(".attach-card");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveClass(/is-uploaded/u);
    await expect(card.locator(".attach-name")).toHaveText("../outside.csv");
    await expect(card.locator(".attach-meta")).toHaveText("CSV 8B");
    expect(mock.state.files.map((file) => (file as { path: string }).path)).toEqual(["outside.csv"]);
  });
});

test("an archived session refuses the drop and says why", async ({ page }) => {
  const mock = await installMockApi(page, {
    sessions: [makeSession({ archivedAt: "2026-10-02T00:00:00.000Z" })],
  });
  await page.goto("/");

  const dragged = await transfer(page, "dropped.csv");
  await page.dispatchEvent("body", "dragenter", { dataTransfer: dragged });

  await expect(page.locator(".drop-card.is-blocked")).toBeVisible();
  await expect(page.getByText("这个会话已经归档，不能再写入。")).toBeVisible();

  await page.dispatchEvent("body", "drop", { dataTransfer: dragged });
  expect(mock.state.files).toHaveLength(0);
});

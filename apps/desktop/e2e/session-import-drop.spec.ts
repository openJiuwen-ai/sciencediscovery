// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect, test, type Page } from "@playwright/test";

import { TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession } from "./fixtures.js";

/**
 * E2E-META
 * Purpose: A package dropped on the import dialog stays the dialog's file and is not uploaded as a chat attachment.
 * Steps: 1. Open the import dialog. 2. Drop a .sdresearch package on its drop zone. 3. Read the dialog, the tray and the mocked upload log.
 * Environment: Desktop app with a mocked control plane; no service, no filesystem.
 * Type: mocked
 * LLM: none. WebSearch: none. PaperSources: none. MCP: none.
 * OtherExternal: none. Credentials: fixture token only. CostSideEffects: local fixtures only.
 */

/** A drag carrying one file, with the name and type the dialog's zone accepts. */
function transfer(page: Page, name: string, type: string) {
  return page.evaluateHandle(([fileName, fileType]) => {
    const data = new DataTransfer();
    data.items.add(new File(["package-bytes"], fileName as string, { type: fileType as string }));
    return data;
  }, [name, type] as const);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("a package dropped on the import dialog is not also uploaded as an attachment", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await test.step("1. Open the import dialog on a session", async () => {
    await page.goto("/");
    // The resumed Session takes the tray when it opens; the drop happens after.
    await expect(page.locator(".side-row.is-active .side-session-name")).toHaveCount(1);
    await page.getByRole("button", { name: "导入会话", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "导入会话" })).toBeVisible();
    await expect(page.locator(".research-package-upload")).toBeVisible();
  });

  await test.step("2. Drop the package on the dialog's own zone", async () => {
    const dragged = await transfer(page, "shared-research.sdresearch", "application/octet-stream");
    await page.locator(".research-package-upload").dispatchEvent("dragenter", { dataTransfer: dragged });
    await page.locator(".research-package-upload").dispatchEvent("drop", { dataTransfer: dragged });
    // The dialog took it: the file card names the package the reader dropped.
    await expect(page.locator(".research-file-card")).toContainText("shared-research.sdresearch");
  });

  await test.step("3. The drop is the dialog's file only — nothing was uploaded", async () => {
    // The whole window accepts a drop and puts the file in the composer's tray.
    // A drop an inner target already took is not that: uploading the package
    // here would leave it as an attachment in the new conversation, which is
    // exactly what a reader who then cancels the import must not get.
    expect(mock.state.files).toHaveLength(0);
    await expect(page.locator(".attach-card")).toHaveCount(0);
  });
});

test("a package dropped on the dialog itself, not on its dashed zone, is not uploaded either", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");
  await expect(page.locator(".side-row.is-active .side-session-name")).toHaveCount(1);
  await page.getByRole("button", { name: "导入会话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入会话" });
  await expect(dialog).toBeVisible();

  // Most of the dialog is not a drop zone: the header, the 项目 select, the footer
  // and the scrim. A reader aiming for the dashed area and missing it must not
  // end up with the package in the conversation behind the dialog.
  const dragged = await transfer(page, "missed-zone.sdresearch", "application/octet-stream");
  for (const selector of [".modal-panel", ".modal-backdrop"]) {
    await page.locator(selector).first().dispatchEvent("dragenter", { dataTransfer: dragged });
    await page.locator(selector).first().dispatchEvent("drop", { dataTransfer: dragged });
  }
  expect(mock.state.files).toHaveLength(0);
  await expect(page.locator(".attach-card")).toHaveCount(0);
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".attach-card")).toHaveCount(0);
});

test("a package the dialog could not read leaves no error behind when the import is cancelled", async ({ page }) => {
  await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");
  await expect(page.locator(".side-row.is-active .side-session-name")).toHaveCount(1);
  await page.getByRole("button", { name: "导入会话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入会话" });
  await expect(dialog).toBeVisible();

  // This control plane does not answer the inspection route, so the dialog says
  // it could not read the package — the red line the reader sees while it is open.
  const dragged = await transfer(page, "not-a-package.sdresearch", "application/octet-stream");
  await page.locator(".research-package-upload").dispatchEvent("dragenter", { dataTransfer: dragged });
  await page.locator(".research-package-upload").dispatchEvent("drop", { dataTransfer: dragged });
  await expect(dialog.locator(".research-package-error")).toBeVisible();

  // Cancelling is the reader abandoning the import. Nothing of it may survive on
  // the page: an error line under the conversation reads as the cancel failing.
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".research-package-error")).toHaveCount(0);
});

test("a drag over an open palette promises nothing, and releasing uploads nothing", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");
  await expect(page.locator(".side-row.is-active .side-session-name")).toHaveCount(1);

  // 搜索 is the one modal that paints under the drop overlay, so a drag over it
  // used to raise "松开即上传" and then discard the drop.
  await page.keyboard.press("Control+k");
  const palette = page.locator(".search-panel");
  await expect(palette).toBeVisible();

  const dragged = await transfer(page, "over-palette.csv", "text/csv");
  await palette.dispatchEvent("dragenter", { dataTransfer: dragged });
  await expect(page.locator(".drop-overlay")).toHaveCount(0);

  await palette.dispatchEvent("drop", { dataTransfer: dragged });
  expect(mock.state.files).toHaveLength(0);
  await expect(page.locator(".attach-card")).toHaveCount(0);
});

test("a package dropped on the import dialog and then cancelled leaves the composer empty", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");
  await expect(page.locator(".side-row.is-active .side-session-name")).toHaveCount(1);
  await page.getByRole("button", { name: "导入会话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入会话" });
  await expect(dialog).toBeVisible();

  const dragged = await transfer(page, "cancel-me.sdresearch", "application/octet-stream");
  await page.locator(".research-package-upload").dispatchEvent("dragenter", { dataTransfer: dragged });
  await page.locator(".research-package-upload").dispatchEvent("drop", { dataTransfer: dragged });
  await expect(page.locator(".research-file-card")).toContainText("cancel-me.sdresearch");

  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Nothing of the cancelled import reaches the conversation: no card, no upload.
  await expect(page.locator(".attach-card")).toHaveCount(0);
  expect(mock.state.files).toHaveLength(0);
});

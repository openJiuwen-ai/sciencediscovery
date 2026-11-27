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

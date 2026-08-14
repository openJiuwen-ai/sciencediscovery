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

import { test, expect, type Page } from "@playwright/test";

const SCREENSHOTS = "screenshots";

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: false });
}

async function waitForToast(page: Page, text: string | RegExp, opts?: { timeout?: number; state?: "visible" | "hidden" }) {
  const toast = page.locator("[role='status']").filter({ hasText: text });
  await toast.waitFor({ timeout: opts?.timeout ?? 10000, state: opts?.state ?? "visible" });
  return toast;
}

async function createProject(page: Page, name: string) {
  await page.getByRole("button", { name: "Add project" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Project" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "Create Project" }).click();
  await waitForToast(page, "Project created");
  await expect(dialog).toBeHidden();
}

async function createSession(page: Page, name: string, opts: { connectorIds?: string[]; skillIds?: string[] } = {}) {
  await page.getByRole("button", { name: "Add session" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Session" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Session name").fill(name);

  if (opts.skillIds?.length) {
    await dialog.getByLabel("Skill settings mode").selectOption("override");
    for (const skillId of opts.skillIds) {
      await dialog.locator(".settings-choices label").filter({ hasText: skillId }).locator("input[type='checkbox']").check();
    }
  }

  if (opts.connectorIds?.length) {
    await dialog.getByLabel("Connector settings mode").selectOption("override");
    for (const connectorId of opts.connectorIds) {
      await dialog.locator(".settings-choices label").filter({ hasText: connectorId }).locator("input[type='checkbox']").check();
    }
  }

  await dialog.getByRole("button", { name: "Create Session" }).click();
  await waitForToast(page, "Session created");
  await expect(dialog).toBeHidden();
}

test("debug main path with console capture", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/messages")) logs.push(`[request] ${req.method()} ${req.url()}`);
  });
  page.on("response", (res) => {
    if (res.request().method() === "POST" && res.url().includes("/messages")) logs.push(`[response] ${res.status()} ${res.url()}`);
  });
  page.on("requestfailed", (req) => logs.push(`[requestfailed] ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ""}`));

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("ScienceDiscovery").first()).toBeVisible();

  await createProject(page, `Debug Project ${Date.now()}`);
  await createSession(page, `Debug Session ${Date.now()}`, { skillIds: ["life-science-evidence-brief"] });

  await page.locator("button.connector-card").filter({ hasText: "PubMed" }).click();
  await expect(page.locator("button.connector-card.enabled").filter({ hasText: "PubMed" })).toBeVisible();
  await page.getByLabel("Plan").selectOption("auto");

  const composer = page.locator(".composer textarea");
  await composer.fill("Research human TP53 and create a cited evidence brief.");
  await screenshot(page, "debug-06-question-typed");

  // Capture geometry and the actual pointer hit target before submitting.
  const sendButton = page.locator("button.send-button");
  const before = await sendButton.textContent().catch(() => "no send-button");
  logs.push(`before click send-button text: ${before}`);
  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { bottom: box.bottom, height: box.height, left: box.left, right: box.right, top: box.top, width: box.width };
    };
    const button = document.querySelector<HTMLButtonElement>("button.send-button");
    const box = button?.getBoundingClientRect();
    const hit = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
    return {
      button: rect("button.send-button"),
      composer: rect("form.composer"),
      footer: rect(".composer-footer"),
      hitClass: hit instanceof HTMLElement ? hit.className : null,
      hitTag: hit?.tagName ?? null,
      workspace: rect("aside.workspace-panel"),
    };
  });
  logs.push(`geometry: ${JSON.stringify(geometry)}`);
  console.log(logs.join("\n"));

  // Keyboard submit bypasses pointer occlusion so the downstream request can
  // be diagnosed independently from the layout defect.
  await composer.press("Enter");

  // Wait briefly for the running state: the composer button becomes Stop.
  await expect(page.getByRole("button", { name: "Stop the current run" })).toBeVisible({ timeout: 20000 }).catch((e) => {
    logs.push(`running state not observed: ${e.message}`);
    return Promise.resolve();
  });
  await screenshot(page, "debug-06b-running-or-after-click");

  // Wait for up to 60s for an assistant message or final state
  const assistant = page.locator(".message.assistant").first();
  await expect(assistant).toBeVisible({ timeout: 60000 }).catch(() => {});
  await screenshot(page, "debug-07-after-wait");

  const runButton = page.getByRole("button", { name: "Run analysis" });
  const isEnabled = await runButton.isEnabled().catch(() => false);
  logs.push(`after wait Run analysis enabled: ${isEnabled}`);
  const assistantCount = await page.locator(".message.assistant").count();
  logs.push(`assistant message count: ${assistantCount}`);

  // Print logs so they appear in stdout
  console.log("--- CONSOLE LOGS ---");
  console.log(logs.join("\n"));
  console.log("--- END CONSOLE LOGS ---");
});

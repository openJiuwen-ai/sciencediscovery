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

// End-to-end coverage for the artifact dashboard work surface.
//
// Prerequisite: a local ScienceDiscovery dev server must already be running
// against this machine (`pnpm server` or `pnpm dev`) and reachable at
// E2E_BASE_URL (defaults to http://127.0.0.1:4310). The spec seeds fixture
// data through the public API and then drives the artifact modal exactly as
// a researcher would: click a file in the file list, interact with the modal.
//
// The access token comes from `E2E_API_TOKEN`; the product ships no default.

import { randomUUID } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";

const BASE_URL = apiBaseUrl();

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...authorizationHeader(),
      ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

async function ensureModel(): Promise<string> {
  const response = await apiFetch("/api/models");
  if (response.ok) {
    const models = (await response.json()) as Array<{ id: string }>;
    if (models.length) return models[0]!.id;
  }
  const created = await apiFetch("/api/models", {
    body: JSON.stringify({ apiToken: "test", baseUrl: "https://example.test/v1", model: "test", name: "Dashboard E2E" }),
    method: "POST",
  });
  if (!created.ok) throw new Error(`Could not ensure a model for the dashboard e2e: ${created.status}`);
  return ((await created.json()) as { id: string }).id;
}

type SeededSession = {
  projectName: string;
  sessionId: string;
  sessionTitle: string;
};

async function seedSession(): Promise<SeededSession> {
  const fixtureId = randomUUID();
  const projectName = `Dashboard E2E ${fixtureId}`;
  const sessionTitle = `Dashboard E2E session ${fixtureId}`;
  const projectResponse = await apiFetch("/api/projects", {
    body: JSON.stringify({ name: projectName }),
    method: "POST",
  });
  if (!projectResponse.ok) throw new Error(`Project creation failed: ${projectResponse.status}`);
  const project = (await projectResponse.json()) as { id: string };
  const modelId = await ensureModel();
  const sessionResponse = await apiFetch(`/api/projects/${project.id}/sessions`, {
    body: JSON.stringify({ title: sessionTitle, modelId }),
    method: "POST",
  });
  if (!sessionResponse.ok) throw new Error(`Session creation failed: ${sessionResponse.status}`);
  const session = (await sessionResponse.json()) as { id: string };
  return { projectName, sessionId: session.id, sessionTitle };
}

async function uploadFile(sessionId: string, path: string, content: string): Promise<void> {
  const response = await apiFetch(`/api/sessions/${sessionId}/files`, {
    body: JSON.stringify({ path, content }),
    method: "POST",
  });
  if (!response.ok) throw new Error(`File upload ${path} failed: ${response.status}`);
}

async function openSeededSession(page: Page, fixture: SeededSession): Promise<void> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const projectButton = page.locator("button.nav-item").filter({ hasText: fixture.projectName });
  await expect(projectButton).toBeVisible();
  await projectButton.click();
  const sessionButton = page.locator("button.nav-item").filter({ hasText: fixture.sessionTitle });
  await expect(sessionButton).toBeVisible();
  await sessionButton.click();
  await expect(page.locator(".topbar h1")).toHaveText(fixture.sessionTitle);
}

test("artifact modal renders markdown preview after clicking a file in the list", async ({ page }: { page: Page }) => {
  const fixture = await seedSession();
  await uploadFile(fixture.sessionId, "notes.md", "# Dashboard E2E\n\nHello from the dashboard spec.");

  await openSeededSession(page, fixture);
  // Click the file row in the file list to open the artifact modal.
  const fileRow = page.locator(".file-row", { hasText: "notes.md" });
  await fileRow.click();
  const modal = page.locator("section[role='dialog']");
  await expect(modal).toBeVisible();
  await expect(modal.locator(".manuscript-preview")).toContainText("Hello from the dashboard spec.");
});

test("switching artifact versions in the modal re-renders the preview", async ({ page }: { page: Page }) => {
  const fixture = await seedSession();
  await uploadFile(fixture.sessionId, "notes.md", "# v1 content");
  await uploadFile(fixture.sessionId, "notes.md", "# v2 content");

  await openSeededSession(page, fixture);
  const fileRow = page.locator(".file-row", { hasText: "notes.md" });
  await fileRow.click();
  const modal = page.locator("section[role='dialog']");
  await expect(modal).toBeVisible();
  const versionSelect = modal.locator("select[aria-label='Artifact version']");
  const options = versionSelect.locator("option");
  await expect(options).toHaveCount(2);
  // Default selection is the latest version (v2).
  await expect(modal.locator(".manuscript-preview")).toContainText("v2 content");
  // Switch back to v1.
  const previousVersionValue = await options.nth(1).getAttribute("value");
  expect(previousVersionValue).not.toBeNull();
  await versionSelect.selectOption(previousVersionValue!);
  await expect(modal.locator(".manuscript-preview")).toContainText("v1 content");
});

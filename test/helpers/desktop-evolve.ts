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
 * The desktop (new UI) entry inside the shared real E2E catalog.
 *
 * `apps/desktop` is a second front end over the same control API and the same
 * token key, but it is not what the stack serves at `/`: the API's static
 * directory is still `apps/web/dist`. So a shared spec that wants to drive the
 * desktop has to bring its own entry — the Vite dev server, with `/api` and
 * `/health` proxied to the stack under test. That is what this module starts.
 *
 * The harness owns every record it creates. A Project, its Session and the
 * model profile carry a random suffix and are removed in `finally`; the model
 * itself is the operator's endpoint from `E2E_LLM_*` or `E2E_MODEL_ID`, never a
 * credential invented here.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, request, type Page, type TestInfo } from "@playwright/test";

export const TOKEN_STORAGE_KEY = "sciencediscovery-token";

/** The first-run guide's own flag (`GUIDE_STORAGE_KEY` in `src/state/storage.ts`).
 *  Leaving it unset puts three cards over the page this case has to click. */
export const GUIDE_STORAGE_KEY = "sciencediscovery-desktop:guide";

/** A port of its own: 4174 is `vite preview`, 4175 the mocked suite, 4176 the
 *  desktop real suite. Two entries can then be running on one workstation. */
export const DESKTOP_PORT = 4178;
export const DESKTOP_ORIGIN = `http://127.0.0.1:${DESKTOP_PORT}`;

/** The stack under test, defaulted the way the rest of the shared suite does. */
export const API_ORIGIN = (
  process.env.E2E_BASE_URL ?? process.env.E2E_API_URL ?? "http://127.0.0.1:4310"
).replace(/\/+$/, "");

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../apps/desktop");

export interface DesktopModel {
  id: string;
  model: string;
  name: string;
}

export interface DesktopSession {
  id: string;
  projectId: string;
  title: string;
}

export interface DesktopProject {
  id: string;
  name: string;
}

export interface DesktopFixture {
  model?: DesktopModel;
  /** False when the profile was already on the stack and must not be removed. */
  modelOwned: boolean;
  project: DesktopProject;
  session: DesktopSession;
}

export interface DesktopRun {
  id: string;
  prompt?: string;
  status: string;
}

function token(): string {
  return process.env.E2E_API_TOKEN?.trim() ?? "";
}

/** One authenticated REST call against the stack, bypassing the browser. */
export async function api<T>(
  page: Page,
  path: string,
  init: { data?: unknown; method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT" } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const response = await page.request.fetch(`${API_ORIGIN}${path}`, {
    ...(init.data === undefined ? {} : { data: init.data as Record<string, unknown> }),
    // The service closes idle keep-alive sockets after a few seconds. A test
    // that spends longer than that in the UI would otherwise retry a socket
    // the server has just closed and see ECONNRESET on a healthy API.
    headers: { authorization: `Bearer ${token()}`, connection: "close" },
    method,
  });
  if (!response.ok()) {
    throw new Error(`${method} ${path} -> ${response.status()}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

/** A real model is either an owned profile built from `E2E_LLM_*`, or a profile
 *  already on the stack named by `E2E_MODEL_ID`. */
export function requireModelSource(info: TestInfo): void {
  if (process.env.E2E_MODEL_ID?.trim()) return;
  const missing = ["E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN"]
    .filter((name) => !process.env[name]?.trim());
  if (missing.length) info.skip(true, `requires E2E_MODEL_ID or ${missing.join(", ")}`);
}

async function resolveModel(
  page: Page,
  name: string,
): Promise<{ model: DesktopModel; owned: boolean }> {
  const reuseId = process.env.E2E_MODEL_ID?.trim();
  if (reuseId) {
    const models = await api<DesktopModel[]>(page, "/api/models");
    const model = models.find((profile) => profile.id === reuseId);
    if (model === undefined) {
      throw new Error(`E2E_MODEL_ID ${reuseId} is not a profile on ${API_ORIGIN}/api/models`);
    }
    return { model, owned: false };
  }

  const baseUrl = process.env.E2E_LLM_BASE_URL?.trim();
  const model = process.env.E2E_LLM_MODEL?.trim();
  const llmToken = process.env.E2E_LLM_TOKEN?.trim();
  if (!baseUrl || !model || !llmToken) {
    throw new Error("requires E2E_MODEL_ID or E2E_LLM_BASE_URL, E2E_LLM_MODEL and E2E_LLM_TOKEN");
  }
  const profile = await api<DesktopModel>(page, "/api/models", {
    data: {
      apiToken: llmToken,
      apiVariant: process.env.E2E_LLM_VARIANT?.trim() || "openai",
      baseUrl,
      model,
      name,
    },
    method: "POST",
  });
  return { model: profile, owned: true };
}

/**
 * Create the records one journey owns: a model profile pointed at the real
 * endpoint, a Project, and its Session. The design conversation runs shell and
 * Python to build the evaluator, so the Session starts in `always_allow`; the
 * test is about the search, not about answering a permission card.
 */
export async function createDesktopFixture(page: Page): Promise<DesktopFixture> {
  const suffix = randomUUID().slice(0, 8);
  const { model: profile, owned } = await resolveModel(page, `Desktop SRBench ${suffix}`);
  let project: DesktopProject | undefined;
  try {
    const created = await api<DesktopProject & { firstSession: DesktopSession; project?: DesktopProject }>(
      page,
      "/api/projects",
      { data: { name: `Desktop SRBench ${suffix}` }, method: "POST" },
    );
    project = created.project ?? created;
    const sessionPath = `/api/sessions/${encodeURIComponent(created.firstSession.id)}`;
    const session = await api<DesktopSession>(page, sessionPath, {
      data: { modelId: profile.id, title: `Desktop SRBench ${suffix}` },
      method: "PATCH",
    });
    // The service refuses a mode switch that shares a request with other
    // fields, because the switch tears down kernels and must be auditable on
    // its own. A fixture sets it as a second, dedicated PATCH.
    await api<DesktopSession>(page, sessionPath, {
      data: { approvalMode: "always_allow" },
      method: "PATCH",
    });
    return { model: profile, modelOwned: owned, project, session };
  } catch (error) {
    if (owned) {
      await api(page, `/api/models/${encodeURIComponent(profile.id)}`, { method: "DELETE" }).catch(() => undefined);
    }
    if (project !== undefined) {
      await api(page, `/api/projects/${encodeURIComponent(project.id)}`, {
        data: { confirmationId: project.id },
        method: "DELETE",
      }).catch(() => undefined);
    }
    throw error;
  }
}

/** Remove the owned records through a fresh request context, because a failed
 *  test may already have torn down the page that created them. */
export async function cleanupDesktopFixture(fixture: DesktopFixture | undefined): Promise<void> {
  if (fixture === undefined) return;
  const context = await request.newContext();
  try {
    const headers = { authorization: `Bearer ${token()}`, connection: "close" };
    const remove = (path: string, data?: unknown) => context.fetch(`${API_ORIGIN}${path}`, {
      ...(data === undefined ? {} : { data: data as Record<string, unknown> }),
      headers,
      method: "DELETE",
    });
    await remove(`/api/projects/${encodeURIComponent(fixture.project.id)}`, {
      confirmationId: fixture.project.id,
    }).catch(() => undefined);
    if (fixture.model && fixture.modelOwned) {
      await remove(`/api/models/${encodeURIComponent(fixture.model.id)}`).catch(() => undefined);
    }
  } finally {
    await context.dispose();
  }
}

/**
 * Put one file into the Session's workspace through the route the composer
 * uses. The evolve design conversation decides what to do with it; the case
 * seeds the problem's data so a run does not depend on the model reaching a
 * dataset mirror from inside the sandbox.
 */
export async function uploadWorkspaceFile(
  page: Page,
  sessionId: string,
  file: { name: string; path: string; mimeType?: string },
): Promise<void> {
  const response = await page.request.post(
    `${API_ORIGIN}/api/sessions/${encodeURIComponent(sessionId)}/workspace/upload?conflict=rename`,
    {
      headers: { authorization: `Bearer ${token()}`, connection: "close" },
      multipart: {
        files: {
          buffer: await readFile(file.path),
          mimeType: file.mimeType ?? "application/json",
          name: file.name,
        },
      },
    },
  );
  if (!response.ok()) {
    throw new Error(`upload ${file.name} -> ${response.status()}: ${await response.text()}`);
  }
}

/** Seed the desktop origin before the app's first request: the token key both
 *  front ends share, and the flag that says the guide has been read. */
export async function seedDesktopOrigin(page: Page): Promise<void> {
  await page.addInitScript(
    ([tokenKey, tokenValue, guideKey]) => {
      localStorage.setItem(tokenKey, tokenValue);
      localStorage.setItem(guideKey, "1");
    },
    [TOKEN_STORAGE_KEY, token(), GUIDE_STORAGE_KEY] as const,
  );
}

/**
 * The desktop entry: its own Vite server, with the browser's `/api` and
 * `/health` going to the stack under test. The app has no absolute API origin,
 * so without the proxy it would open on its offline screen.
 */
export async function startDesktopEntry(): Promise<ChildProcess> {
  const vite = resolve(desktopRoot, "node_modules/.bin/vite");
  if (!existsSync(vite)) {
    throw new Error(`${vite} is missing; run pnpm install before the desktop entry`);
  }
  const child = spawn(vite, ["--port", String(DESKTOP_PORT), "--strictPort"], {
    cwd: desktopRoot,
    detached: true,
    env: { ...process.env, SCIENCE_AGENT_API_URL: API_ORIGIN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[desktop] ${String(chunk)}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[desktop] ${String(chunk)}`));
  await waitForHttp(DESKTOP_ORIGIN, 180_000, "the desktop entry");
  return child;
}

export async function stopDesktopEntry(child: ChildProcess | undefined): Promise<void> {
  if (child?.pid === undefined) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      // Detached starts a process group, so Vite's esbuild child goes with it.
      process.kill(-child.pid!, name);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  await new Promise((done) => setTimeout(done, 1_000));
  signal("SIGKILL");
}

async function waitForHttp(origin: string, timeout: number, what: string): Promise<void> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(5_000) });
      if (response.ok || response.status === 401) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${what} did not answer on ${origin} within ${timeout} ms (last: ${String(last)})`);
}

/** Open the created Session through the desktop entry. */
export async function openDesktopSession(page: Page, fixture: DesktopFixture): Promise<void> {
  await page.goto(DESKTOP_ORIGIN);
  const row = page.locator(".side-session", { hasText: fixture.session.title });
  await expect(row.first()).toBeVisible();
  await row.first().click();
  await expect(page.locator(".task-head-title")).toContainText(fixture.session.title);
  await expect(page.locator("#composer-textarea")).toBeVisible();
}

/** Wait on the persisted Run the service created, not on a transient state. */
export async function waitForNewRun(
  page: Page,
  sessionId: string,
  before: Set<string>,
  timeout = 120_000,
): Promise<DesktopRun> {
  let created: DesktopRun | undefined;
  await expect.poll(async () => {
    created = (await api<DesktopRun[]>(page, `/api/sessions/${encodeURIComponent(sessionId)}/runs`))
      .find((run) => !before.has(run.id));
    return created?.id;
  }, { message: "the command should create a persisted Run", timeout }).toBeTruthy();
  return created!;
}

/** Submit one prompt from the composer and return the Run it started. */
export async function sendMessage(page: Page, sessionId: string, prompt: string): Promise<DesktopRun> {
  const runsPath = `/api/sessions/${encodeURIComponent(sessionId)}/runs`;
  const before = new Set((await api<DesktopRun[]>(page, runsPath)).map((run) => run.id));
  await page.locator("#composer-textarea").fill(prompt);
  await page.locator("#composer-textarea").press("Enter");
  return waitForNewRun(page, sessionId, before);
}

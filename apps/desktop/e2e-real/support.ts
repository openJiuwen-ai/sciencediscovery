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
 * Wiring for the real (L3) desktop journeys.
 *
 * The suite owns every record it creates: a Project, its Session and the model
 * profile all carry a random suffix and are removed in `finally`. The model
 * itself is the operator's real endpoint, passed in through the same
 * `E2E_LLM_*` variables the shared real suite uses, or named by `E2E_MODEL_ID`
 * when the key already lives on the stack; nothing here invents a credential.
 *
 * A missing credential or stack skips with a named reason instead of failing.
 * The L3 gate is allowed to be skipped on a workstation, but a silent pass is
 * not: `info.skip` records why the case did not run.
 */
import { randomUUID } from "node:crypto";

import { expect, request, type Page, type TestInfo } from "@playwright/test";

export const TOKEN_STORAGE_KEY = "sciencediscovery-token";

export const API_ORIGIN = (
  process.env.E2E_BASE_URL ?? process.env.E2E_API_URL ?? "http://127.0.0.1:4410"
).replace(/\/+$/, "");

export interface RealModel {
  id: string;
  model: string;
  name: string;
}

export interface RealSession {
  id: string;
  projectId: string;
  title: string;
}

export interface RealProject {
  id: string;
  name: string;
}

export interface RealFixture {
  model?: RealModel;
  /** False when the profile was already on the stack and must not be removed. */
  modelOwned: boolean;
  project: RealProject;
  session: RealSession;
}

export interface RealRun {
  id: string;
  prompt: string;
  status: "blocked" | "cancelled" | "completed" | "failed" | "interrupted" | "queued" | "running";
}

export type ApprovalMode = "always_allow" | "ask_for_dangerous";

const TERMINAL = /^(cancelled|completed|failed|interrupted)$/;

function token(): string {
  return process.env.E2E_API_TOKEN?.trim() ?? "";
}

/** Skip, with the missing names, before the first external action. */
export function requireEnv(info: TestInfo, ...names: string[]): Record<string, string> {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length) info.skip(true, `requires ${missing.join(", ")}`);
  return Object.fromEntries(names.map((name) => [name, process.env[name] ?? ""]));
}

/** Seed the same localStorage key a person sets by pasting the printed token. */
export async function seedToken(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, token()] as const,
  );
}

/**
 * Skip when the configured stack is absent or incomplete.
 *
 * The API reports `status: "ok"` only when the Runner answered too, so one
 * probe covers both services. A failed request is a skip, a 401 is not — the
 * latter means the stack is there and the credential is wrong, which should be
 * reported as a failure rather than hidden.
 */
export async function requireStack(info: TestInfo): Promise<void> {
  let health: Response;
  try {
    health = await fetch(`${API_ORIGIN}/health`, { signal: AbortSignal.timeout(3_000) });
  } catch (error) {
    info.skip(true, `ScienceDiscovery stack is unavailable at ${API_ORIGIN}: ${String(error)}`);
    return;
  }
  if (health.status === 401 || health.status === 403) {
    throw new Error(`${API_ORIGIN}/health rejected the configured credential (HTTP ${health.status})`);
  }
  if (!health.ok) info.skip(true, `ScienceDiscovery stack health is HTTP ${health.status}`);
  const body = await health.json() as { runner?: { status?: string }; service?: string; status?: string };
  if (body.service !== "sciencediscovery-api" || body.status !== "ok" || body.runner?.status === "unavailable") {
    info.skip(true, `ScienceDiscovery stack health is incomplete (service=${body.service ?? "unknown"}, status=${body.status ?? "unknown"}, runner=${body.runner?.status ?? "unknown"})`);
  }
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

/**
 * A real model is either an owned profile built from `E2E_LLM_*`, or a profile
 * already on the stack named by `E2E_MODEL_ID`. The second form is for a stack
 * whose key is stored server-side and cannot be exported; the probe and the
 * conversation still reach the real endpoint, they just reuse that profile.
 */
export function requireModelSource(info: TestInfo): void {
  if (process.env.E2E_MODEL_ID?.trim()) return;
  requireEnv(info, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
}

/** Find the reused profile, or register an owned one for this journey. */
export async function resolveModel(
  page: Page,
  name: string,
): Promise<{ model: RealModel; owned: boolean }> {
  const reuseId = process.env.E2E_MODEL_ID?.trim();
  if (reuseId) {
    const models = await api<RealModel[]>(page, "/api/models");
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
  const profile = await api<RealModel>(page, "/api/models", {
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
 * endpoint, a Project, and its Session. The suffix keeps two runs that overlap
 * on the same stack from reading each other's rows.
 */
export async function createFixture(
  page: Page,
  options: { approvalMode?: ApprovalMode } = {},
): Promise<RealFixture> {
  const suffix = randomUUID().slice(0, 8);
  const { model: profile, owned } = await resolveModel(page, `Desktop real ${suffix}`);
  let project: RealProject | undefined;
  try {
    const created = await api<RealProject & { firstSession: RealSession; project?: RealProject }>(
      page,
      "/api/projects",
      { data: { name: `Desktop real ${suffix}` }, method: "POST" },
    );
    project = created.project ?? created;
    const sessionPath = `/api/sessions/${encodeURIComponent(created.firstSession.id)}`;
    const session = await api<RealSession>(page, sessionPath, {
      data: { modelId: profile.id, title: `Desktop real ${suffix}` },
      method: "PATCH",
    });
    // The service refuses a mode switch that shares a request with other
    // fields, because the switch tears down kernels and must be auditable on
    // its own. A fixture sets it as a second, dedicated PATCH.
    if (options.approvalMode !== undefined) {
      await api<RealSession>(page, sessionPath, {
        data: { approvalMode: options.approvalMode },
        method: "PATCH",
      });
    }
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

/**
 * Remove the owned records through a fresh request context, because a failed
 * test may already have torn down the page that created them.
 */
export async function cleanupFixture(fixture: RealFixture | undefined): Promise<void> {
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
 * Open the created Session through the app.
 *
 * Boot resumes the most recent Session, but the row is clicked explicitly so
 * the test still targets its own Session when another run wrote in between.
 */
export async function openSession(page: Page, fixture: RealFixture): Promise<void> {
  await page.goto("/");
  const row = page.locator(".side-session", { hasText: fixture.session.title });
  await expect(row.first()).toBeVisible();
  await row.first().click();
  await expect(page.locator(".task-head-title")).toContainText(fixture.session.title);
  await expect(page.locator("#composer-textarea")).toBeVisible();
}

/** Submit one prompt from the composer and return the Run the service created. */
export async function sendMessage(page: Page, sessionId: string, prompt: string): Promise<RealRun> {
  const runsPath = `/api/sessions/${encodeURIComponent(sessionId)}/runs`;
  const before = new Set((await api<RealRun[]>(page, runsPath)).map((run) => run.id));
  const submitted = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST"
      && new RegExp(`/api/sessions/${encodeURIComponent(sessionId)}/messages$`).test(new URL(request.url()).pathname);
  });
  await page.locator("#composer-textarea").fill(prompt);
  await page.locator("#composer-textarea").press("Enter");
  await submitted;

  let created: RealRun | undefined;
  await expect.poll(async () => {
    created = (await api<RealRun[]>(page, runsPath)).find((run) => !before.has(run.id));
    return created?.id;
  }, { message: "the prompt should create a persisted Run", timeout: 30_000 }).toBeTruthy();
  return created!;
}

/** Wait on persisted Run state, not on a transient button. */
export async function waitForRun(
  page: Page,
  sessionId: string,
  runId: string,
  timeout = 180_000,
): Promise<RealRun> {
  let current: RealRun | undefined;
  await expect.poll(async () => {
    current = (await api<RealRun[]>(page, `/api/sessions/${encodeURIComponent(sessionId)}/runs`))
      .find((run) => run.id === runId);
    return current?.status;
  }, { message: `Run ${runId} should reach a terminal state`, timeout }).toMatch(TERMINAL);
  return current!;
}

/** The tags the catalog uses for the first real tier. */
export const REAL_TAGS = [
  "@real",
  "@category:e2e",
  "@os:linux",
  "@arch:amd64",
  "@model:real",
  "@tier:l3",
] as const;

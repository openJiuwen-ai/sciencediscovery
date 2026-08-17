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

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, type Locator, type Page } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "../e2e-auth.js";

export interface JourneyModel {
  id: string;
  model: string;
  name: string;
}

export interface JourneyProject {
  id: string;
  name: string;
}

export interface JourneySession {
  id: string;
  modelId?: string;
  projectId: string;
  title: string;
}

export type JourneyRunStatus =
  | "blocked"
  | "cancelled"
  | "completed"
  | "failed"
  | "interrupted"
  | "queued"
  | "running";

export interface JourneyRun {
  createdAt: string;
  error?: string;
  id: string;
  prompt: string;
  sessionId: string;
  status: JourneyRunStatus;
}

export interface JourneyFixture {
  model?: JourneyModel;
  project: JourneyProject;
  session: JourneySession;
}

export interface ToolProcess {
  details: string;
  status: string;
  summary: string;
}

export interface ScriptedToolStep {
  arguments: Record<string, unknown>;
  delayMs?: number;
  tool: string;
}

export interface ScriptedTextStep {
  delayMs?: number;
  text: string;
}

export type ScriptedModelStep = ScriptedTextStep | ScriptedToolStep;

export interface ScriptedModelCall {
  arguments?: Record<string, unknown>;
  route: "main" | "subagent";
  step: number;
  tool?: string;
  turn: number;
}

export interface ScriptedModel {
  apiToken: string;
  baseUrl: string;
  calls: ScriptedModelCall[];
  model: string;
  stop: () => Promise<void>;
}

export interface JourneyEnvironment {
  currentRevisionId: string;
  id: string;
  kind: "starter" | "task";
  language: "python" | "r";
  name: string;
}

export interface JourneyEnvironmentRevision {
  environmentId: string;
  id: string;
  language: "python" | "r" | "shell";
  packages: string[];
}

const TERMINAL_RUN_STATUSES = new Set<JourneyRunStatus>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
]);

async function apiJson<T>(
  page: Page,
  path: string,
  options: { data?: unknown; method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT" } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const response = await page.request.fetch(`${apiBaseUrl()}${path}`, {
    ...(options.data === undefined ? {} : { data: options.data }),
    headers: authorizationHeader(),
    method,
  });
  if (!response.ok()) {
    throw new Error(`${method} ${path} -> ${response.status()}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

type ScriptedTurns = ScriptedModelStep[] | ScriptedModelStep[][];
type ChatMessage = { content?: string; role?: string };

const SUBAGENT_PRESET_MARKER = "Applied subagent preset general-purpose";

function scriptedTurn(steps: ScriptedTurns, turn: number): ScriptedModelStep[] {
  if (!Array.isArray(steps[0])) return steps as ScriptedModelStep[];
  const turns = steps as ScriptedModelStep[][];
  const selected = turns[turn];
  if (!selected) throw new Error(`No scripted model turn ${turn + 1}; received more user turns than expected`);
  return selected;
}

function completionChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null) {
  return {
    choices: [{ delta, finish_reason: finishReason, index: 0 }],
    created: 1,
    id,
    model,
    object: "chat.completion.chunk",
  };
}

/**
 * Start a deterministic OpenAI-compatible model for a complete user journey.
 * Each nested mainSteps array is one user turn. Within a turn, every tool
 * result advances to the next step. Subagent requests are routed only by the
 * product's general-purpose preset marker, keeping orchestration under test.
 */
export function scriptedModel(
  mainSteps: ScriptedTurns,
  subagentSteps?: ScriptedTurns,
): Promise<ScriptedModel> {
  const calls: ScriptedModelCall[] = [];
  const model = "journey-scripted-model";
  const apiToken = "journey-local-stub-token";
  let sequence = 0;
  const server: Server = createServer((request, response) => {
    const bodyChunks: Buffer[] = [];
    request.on("data", (chunk) => bodyChunks.push(Buffer.from(chunk)));
    request.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(bodyChunks).toString("utf8")) as { messages?: ChatMessage[] };
        const messages = body.messages ?? [];
        const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
        const isSubagent = systemPrompt.includes(SUBAGENT_PRESET_MARKER);
        const route = isSubagent ? "subagent" : "main";
        const scripts = isSubagent ? subagentSteps : mainSteps;
        if (!scripts) throw new Error("The product made an unexpected subagent model request");
        const turn = Math.max(0, messages.filter((message) => message.role === "user").length - 1);
        const steps = scriptedTurn(scripts, isSubagent ? 0 : turn);
        const stepIndex = messages.filter((message) => message.role === "tool").length;
        const step = steps[stepIndex];
        if (!step) throw new Error(`No ${route} scripted step ${stepIndex + 1} for turn ${turn + 1}`);

        sequence += 1;
        const id = `chatcmpl-journey-${sequence}`;
        calls.push({
          ...("tool" in step ? { arguments: step.arguments, tool: step.tool } : {}),
          route,
          step: stepIndex,
          turn,
        });
        if (step.delayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, step.delayMs));
        response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
        if ("tool" in step) {
          response.write(`data: ${JSON.stringify(completionChunk(id, model, {
            role: "assistant",
            tool_calls: [{
              function: { arguments: JSON.stringify(step.arguments), name: step.tool },
              id: `call-journey-${sequence}`,
              index: 0,
              type: "function",
            }],
          }, null))}\n\n`);
          response.write(`data: ${JSON.stringify({
            ...completionChunk(id, model, {}, "tool_calls"),
            usage: { completion_tokens: 8, prompt_tokens: 20, total_tokens: 28 },
          })}\n\n`);
        } else {
          response.write(`data: ${JSON.stringify(completionChunk(id, model, {
            content: step.text,
            role: "assistant",
          }, null))}\n\n`);
          response.write(`data: ${JSON.stringify({
            ...completionChunk(id, model, {}, "stop"),
            usage: { completion_tokens: 8, prompt_tokens: 20, total_tokens: 28 },
          })}\n\n`);
        }
        response.end("data: [DONE]\n\n");
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        apiToken,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        calls,
        model,
        stop: () => new Promise<void>((resolveStop) => {
          server.closeAllConnections?.();
          server.close(() => resolveStop());
        }),
      });
    });
    server.on("error", reject);
  });
}

/** Register either a spec-owned local stub or an explicitly gated real model. */
export function registerModel(
  page: Page,
  input: { apiToken: string; baseUrl: string; model: string; name: string; vision?: boolean },
): Promise<JourneyModel> {
  return apiJson(page, "/api/models", { data: { vision: false, ...input }, method: "POST" });
}

async function deleteJourneyModel(page: Page, model: JourneyModel): Promise<void> {
  const settings = await apiJson<{ overrides?: Record<string, unknown> }>(page, "/api/settings").catch(() => undefined);
  if (settings?.overrides) {
    const overrides = { ...settings.overrides };
    let changed = false;
    for (const key of ["modelId", "reviewModelId"]) {
      if (overrides[key] === model.id) {
        delete overrides[key];
        changed = true;
      }
    }
    if (changed) await apiJson(page, "/api/settings", { data: overrides, method: "PUT" });
  }
  await apiJson(page, `/api/models/${encodeURIComponent(model.id)}`, { method: "DELETE" });
}

/** Select a model for the user's Session without coupling tests to the settings dialog layout. */
export function selectModelForSession(page: Page, sessionId: string, modelId: string): Promise<JourneySession> {
  return apiJson(page, `/api/sessions/${encodeURIComponent(sessionId)}`, {
    data: { modelId },
    method: "PATCH",
  });
}

/**
 * Create the Project and its initial Session, then apply the user-visible
 * Session title/model/approval choices. Specs still navigate and interact
 * through the browser for the behavior they are validating.
 */
export async function createProjectAndSession(
  page: Page,
  input: {
    approvalMode?: "always_allow" | "ask_for_dangerous";
    model?: { apiToken: string; baseUrl: string; model: string; name: string; vision?: boolean };
    modelId?: string;
    projectName: string;
    sessionTitle: string;
  },
): Promise<JourneyFixture> {
  const model = input.model ? await registerModel(page, input.model) : undefined;
  let project: JourneyProject | undefined;
  try {
    const created = await apiJson<JourneyProject & { firstSession: JourneySession; project?: JourneyProject }>(
      page,
      "/api/projects",
      { data: { name: input.projectName }, method: "POST" },
    );
    project = created.project ?? created;
    let session = await apiJson<JourneySession>(page, `/api/sessions/${encodeURIComponent(created.firstSession.id)}`, {
      data: {
        ...(model?.id || input.modelId ? { modelId: model?.id ?? input.modelId } : {}),
        title: input.sessionTitle,
      },
      method: "PATCH",
    });
    if (input.approvalMode) {
      session = await apiJson<JourneySession>(page, `/api/sessions/${encodeURIComponent(session.id)}`, {
        data: { approvalMode: input.approvalMode },
        method: "PATCH",
      });
    }
    return { ...(model ? { model } : {}), project, session };
  } catch (error) {
    if (project) {
      await apiJson(page, `/api/projects/${encodeURIComponent(project.id)}`, {
        data: { confirmationId: project.id },
        method: "DELETE",
      }).catch(() => undefined);
    }
    if (model) {
      await deleteJourneyModel(page, model).catch(() => undefined);
    }
    throw error;
  }
}

/** Navigate to a prepared Project/Session using the same controls a user sees. */
export async function openProjectSession(
  page: Page,
  fixture: Pick<JourneyFixture, "project" | "session">,
): Promise<void> {
  const currentSession = await apiJson<JourneySession>(
    page,
    `/api/sessions/${encodeURIComponent(fixture.session.id)}`,
  );
  await page.goto("/");
  await expect(page.getByText("ScienceDiscovery").first()).toBeVisible();
  await page.locator("button.nav-item").filter({ hasText: fixture.project.name }).click();
  await page.locator("button.nav-item").filter({ hasText: currentSession.title }).click();
  await expect(page.getByRole("heading", { exact: true, name: currentSession.title })).toBeVisible();
}

/** Send one natural-language user request and return the persisted Run it creates. */
export async function sendUserMessage(page: Page, sessionId: string, prompt: string): Promise<JourneyRun> {
  const runsPath = `/api/sessions/${encodeURIComponent(sessionId)}/runs`;
  const before = new Set((await apiJson<JourneyRun[]>(page, runsPath)).map((run) => run.id));
  const request = page.waitForRequest((candidate) =>
    candidate.method() === "POST" && /\/api\/sessions\/[^/]+\/messages$/.test(candidate.url()));
  await page.locator("form.composer").getByRole("textbox").fill(prompt);
  await page.getByRole("button", { name: /^(Run analysis|Add to queue|运行分析|加入队列)$/ }).click();
  await request;

  let created: JourneyRun | undefined;
  await expect.poll(async () => {
    created = (await apiJson<JourneyRun[]>(page, runsPath))
      .find((run) => !before.has(run.id) && run.prompt === prompt);
    return created?.id;
  }, { message: "the submitted user message should create a persisted Run", timeout: 20_000 }).toBeTruthy();
  return created!;
}

/** Wait on persisted Run state so fast completions do not race a transient Stop button. */
export async function waitForRunTerminal(
  page: Page,
  sessionId: string,
  runId: string,
  timeout = 420_000,
): Promise<JourneyRun> {
  let current: JourneyRun | undefined;
  await expect.poll(async () => {
    current = (await apiJson<JourneyRun[]>(page, `/api/sessions/${encodeURIComponent(sessionId)}/runs`))
      .find((run) => run.id === runId);
    return current?.status;
  }, { message: `Run ${runId} should reach a terminal state`, timeout }).toMatch(/^(cancelled|completed|failed|interrupted)$/);
  return current!;
}

/**
 * Resolve permission cards as they appear until the chosen Run finishes.
 * The returned Run lets each journey decide which terminal states satisfy its
 * own user goal instead of baking one assertion into the helper.
 */
export async function handlePermissionsUntilTerminal(
  page: Page,
  sessionId: string,
  runId: string,
  options: {
    decision?: "allow-matching" | "allow-once" | "deny";
    timeout?: number;
  } = {},
): Promise<{ decisions: number; run: JourneyRun }> {
  const decision = options.decision ?? "allow-once";
  const labels = {
    "allow-matching": /^(Allow same type|Allow matching|允许同类操作)$/,
    "allow-once": /^(Allow once|Allow|仅允许一次)$/,
    deny: /^(Deny|拒绝)$/,
  } as const;
  const deadline = Date.now() + (options.timeout ?? 420_000);
  let decisions = 0;

  while (Date.now() < deadline) {
    const run = (await apiJson<JourneyRun[]>(page, `/api/sessions/${encodeURIComponent(sessionId)}/runs`))
      .find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`Run ${runId} disappeared while waiting for permission`);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return { decisions, run };

    const timelineCard = page.locator("article.permission-card.pending").first();
    const outerCard = page.locator("section[aria-label='Permission cards'] article.permission-card").first();
    const pendingCard = await timelineCard.isVisible().catch(() => false) ? timelineCard : outerCard;
    const disclosure = pendingCard.locator("button.permission-card-heading");
    if (await disclosure.isVisible().catch(() => false)
      && await disclosure.getAttribute("aria-expanded") === "false") {
      await disclosure.click();
    }
    const button = pendingCard.getByRole("button", { name: labels[decision] }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      decisions += 1;
      continue;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Run ${runId} did not finish within ${options.timeout ?? 420_000} ms`);
}

/** User-facing locators remain available so journey specs own their assertions. */
export function journeyViews(page: Page): {
  permissionCards: Locator;
  timelines: Locator;
  toolProcesses: Locator;
} {
  const timelines = page.getByRole("region", { name: "Agent activity" });
  return {
    permissionCards: page.locator("article.permission-card"),
    timelines,
    toolProcesses: timelines.locator("details.timeline-disclosure.tool"),
  };
}

/** Read the currently rendered timeline and expandable tool process cards. */
export async function readRunActivity(page: Page, options: { expandTools?: boolean } = {}): Promise<{
  text: string[];
  tools: ToolProcess[];
}> {
  const views = journeyViews(page);
  await expect(views.timelines.first()).toBeVisible();
  const tools: ToolProcess[] = [];
  for (let index = 0; index < await views.toolProcesses.count(); index += 1) {
    const card = views.toolProcesses.nth(index);
    if (options.expandTools && await card.getAttribute("open") === null) await card.locator(":scope > summary").click();
    tools.push({
      details: (await card.locator(".timeline-content").textContent())?.trim() ?? "",
      status: (await card.locator(".timeline-status").textContent())?.trim() ?? "",
      summary: (await card.locator("summary").textContent())?.trim() ?? "",
    });
  }
  return { text: await views.timelines.allInnerTexts(), tools };
}

/** Locate a tool process by a marker in its rendered input/output, then expand it. */
export async function expandToolStep(page: Page, options: { contains: string | RegExp }): Promise<Locator> {
  const cards = page.getByRole("region", { name: /^(Agent activity|Agent 活动)$/ })
    .locator("details.timeline-disclosure.tool")
    .filter({ hasText: options.contains });
  await expect(cards.first(), `a tool step should contain ${String(options.contains)}`).toBeVisible({ timeout: 60_000 });
  const card = cards.first();
  if (await card.getAttribute("open") === null) await card.locator(":scope > summary").click();
  await expect(card.locator(".timeline-content")).toBeVisible();
  return card;
}

/** Open the user-visible scientific environment settings page. */
export async function openEnvironmentPage(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: /^(System configuration|系统设置)/ }).click();
  const dialog = page.getByRole("dialog", { name: /^(System configuration|系统设置)$/ });
  await dialog.getByRole("navigation", { name: /^(Setting groups|设置分组)$/ })
    .getByRole("button", { name: /^(Environments|环境)/ })
    .click();
  const manager = dialog.locator(".environment-manager");
  await expect(manager).toBeVisible();
  return manager;
}

/** Expand and return the Project-level artifact catalog in the workspace rail. */
export async function openArtifactPanel(page: Page): Promise<Locator> {
  const showWorkspace = page.getByRole("button", { name: /^(Show workspace|显示工作区)$/ });
  if (await showWorkspace.isVisible().catch(() => false)) await showWorkspace.click();
  const catalog = page.locator("aside.workspace-panel details.artifact-catalog-section");
  await expect(catalog).toBeVisible();
  if (await catalog.getAttribute("open") === null) await catalog.locator(":scope > summary").click();
  return catalog;
}

/**
 * Expose the three user-visible workspace views without treating physical
 * files as declared Artifacts: catalog rows/count, @ suggestions, and the
 * opt-in workspace-file tree.
 */
export async function artifactTree(page: Page): Promise<{
  artifactCount: Locator;
  artifacts: Locator;
  catalog: Locator;
  mentionCandidates: (query?: string) => Promise<Locator>;
  openPhysicalFiles: () => Promise<Locator>;
  physicalFiles: Locator;
  sessionGroups: Locator;
}> {
  const catalog = await openArtifactPanel(page);
  const folders = catalog.locator("details.artifact-tree-folder");
  for (let index = 0; index < await folders.count(); index += 1) {
    const folder = folders.nth(index);
    if (await folder.getAttribute("open") === null) await folder.locator(":scope > summary").click();
  }
  const workspace = page.locator("aside.workspace-panel");
  const artifacts = catalog.locator("button.artifact-tree-file");
  const physicalFiles = workspace.locator("details.physical-files button.workspace-file-tree-leaf");
  return {
    artifactCount: catalog.locator("summary .fold-meta"),
    artifacts,
    catalog,
    mentionCandidates: async (query = "") => {
      const composer = page.locator("form.composer").getByRole("textbox");
      await composer.fill(`@${query}`);
      const menu = page.getByRole("listbox", { name: "@ context suggestions" });
      await expect(menu).toBeVisible();
      return menu.getByRole("option");
    },
    openPhysicalFiles: async () => {
      const toggle = workspace.getByRole("button", { name: /^(View workspace files|查看工作区文件)$/ });
      if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
      const tree = workspace.locator("details.physical-files");
      await expect(tree).toBeVisible();
      return tree;
    },
    physicalFiles,
    sessionGroups: catalog.locator("section.artifact-session-group"),
  };
}

/** Read environment state after UI creation so only the stub receives its immutable revision id. */
export async function currentEnvironmentRevision(
  page: Page,
  name: string,
): Promise<{ environment: JourneyEnvironment; revision: JourneyEnvironmentRevision }> {
  const environments = await apiJson<JourneyEnvironment[]>(page, "/api/environments");
  const environment = environments.find((candidate) => candidate.name === name);
  if (!environment) throw new Error(`Environment ${name} was not found after UI creation`);
  const revisions = await apiJson<JourneyEnvironmentRevision[]>(page, "/api/environment-revisions");
  const revision = revisions.find((candidate) => candidate.id === environment.currentRevisionId);
  if (!revision) throw new Error(`Current revision ${environment.currentRevisionId} was not returned by the API`);
  return { environment, revision };
}

/** Query the setup state without triggering installation or other environment changes. */
export function environmentSetup(page: Page): Promise<{ message: string; state: string }> {
  return apiJson(page, "/api/environment-setup");
}

/** Best-effort cleanup for data created in an isolated E2E run. */
export async function cleanupJourney(page: Page, fixture: JourneyFixture): Promise<void> {
  await apiJson(page, `/api/projects/${encodeURIComponent(fixture.project.id)}`, {
    data: { confirmationId: fixture.project.id },
    method: "DELETE",
  }).catch(() => undefined);
  if (fixture.model) {
    await deleteJourneyModel(page, fixture.model).catch(() => undefined);
  }
}

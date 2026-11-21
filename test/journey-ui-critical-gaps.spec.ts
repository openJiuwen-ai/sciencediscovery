// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { DESKTOP_ORIGIN, seedDesktopOrigin, startDesktopEntry, stopDesktopEntry, waitForNewRun } from "./helpers/desktop-evolve.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, sessionExecutionRuns, waitForRunTerminal, type JourneyFixture } from "./helpers/journeys.ts";
import { unavailableRunner } from "./fixtures/unavailable-runner.mjs";

test.use({ locale: "zh-CN" });

async function api<T>(page: Page, path: string, method = "GET", data?: unknown): Promise<T> {
  const response = await page.request.fetch(`${apiBaseUrl()}${path}`, { method, headers: authorizationHeader(), data });
  expect(response.ok(), `${method} ${path}: HTTP ${response.status()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function fixtureFor(page: Page, stub: Awaited<ReturnType<typeof scriptedModel>>, title: string, approvalMode: "always_allow" | "ask_for_dangerous" = "always_allow") {
  const suffix = randomUUID().slice(0, 8);
  return createProjectAndSession(page, {
    approvalMode, model: { ...stub, name: `${title} ${suffix}` }, projectName: `${title} ${suffix}`, sessionTitle: `${title} ${suffix}`,
  });
}

async function openDesktop(page: Page, fixture: Pick<JourneyFixture, "project" | "session">) {
  await seedDesktopOrigin(page);
  await page.goto(DESKTOP_ORIGIN);
  const sidebar = page.locator(".sidebar");
  const project = sidebar.getByRole("button", { name: fixture.project.name, exact: true });
  await expect(project).toBeVisible({ timeout: 30_000 });
  if (await project.getAttribute("aria-expanded") === "false") await project.click();
  const row = sidebar.locator(".side-session").filter({ has: page.getByText(fixture.session.title, { exact: true }) });
  await row.click({ timeout: 30_000 });
  await expect(page.locator(".task-head-title")).toContainText(fixture.session.title);
  await expect(page.locator("#composer-textarea")).toBeEditable();
}

async function sendDesktop(page: Page, sessionId: string, prompt: string) {
  const path = `/api/sessions/${sessionId}`;
  const before = new Set((await api<Array<{ id: string }>>(page, `${path}/runs`)).map(run => run.id));
  const input = page.locator("#composer-textarea");
  const send = page.getByRole("button", { name: "发送", exact: true });
  // Reopening the Session can still remount the composer while it loads.
  // Wait until the draft enables Send before submitting it exactly once.
  await expect(async () => {
    await input.fill(prompt, { timeout: 2_000 });
    await expect(send).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await send.click({ timeout: 10_000 });
  return waitForNewRun(page, sessionId, before, 30_000);
}

// Fail only the browser's first message stream. The product still accepts the
// original POST and runs the model. All later requests use unmodified fetch.
async function armMessageDisconnect(page: Page, sessionId: string) {
  await page.addInitScript((path) => {
    const actualFetch = window.fetch.bind(window);
    let armed = true;
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (!armed || url.pathname !== path || method !== "POST") return actualFetch(input, init);
      armed = false;
      const response = await actualFetch(input, init);
      if (!response.ok || !response.body) return response;
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          window.addEventListener("test:disconnect-run-stream", () => {
            document.documentElement.dataset.testRunStreamCut = "true";
            controller.error(new TypeError("test stream connection lost"));
            void reader.cancel().catch(() => undefined);
          }, { once: true });
        },
        async pull(controller) {
          const read = await reader.read();
          if (read.done) controller.close();
          else controller.enqueue(read.value);
        },
        cancel: () => reader.cancel(),
      });
      return new Response(body, response);
    };
  }, `/api/sessions/${sessionId}/messages`);
}

test.describe("Critical UI recovery journeys", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap", "@isolation:global"] }, () => {
  /**
   * E2E-META
   * Purpose: A disconnected browser can read the rest of an accepted run without resubmitting it.
   * Steps:
   *   1. Send in both UIs, cut the response mid-turn, and verify replay and completion on the same run.
   * Environment: Isolated product stack and Desktop Vite entry, Chromium.
   * Type: mocked
   * LLM: Local gated scripted model.
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none
   * Credentials: Isolated stack token.
   * CostSideEffects: Disposable sessions and model profiles only.
   */
  test("Web and Desktop recover the same Run after a stream disconnect", { tag: "@mocked" }, async ({ page, journey }) => {
    test.setTimeout(240_000);
    journey.scenario({ goal: "Recover an accepted Run without resubmitting the prompt", preconditions: ["Isolated product stack", "Local scripted model"] });
    const desktop = await startDesktopEntry();
    try {
      for (const surface of ["Web", "Desktop"] as const) {
        await journey.step(surface, "The disconnected browser recovers the existing Run and shows one complete result.", async () => {
          const suffix = randomUUID().slice(0, 8);
          const command = `printf reconnect-${suffix}`;
          const answer = `Recovered ${suffix}`;
          const prompt = `Disconnect test ${suffix}`;
          const release = Promise.withResolvers<void>();
          const stub = await scriptedModel([
            { tool: "run_shell", arguments: { command } },
            { text: answer, waitFor: release.promise },
          ]);
          let fixture: JourneyFixture | undefined;
          try {
            fixture = await fixtureFor(page, stub, `${surface} reconnect`);
            const { id } = fixture.session;
            const runsPath = `/api/sessions/${id}/runs`;
            await armMessageDisconnect(page, id);
            if (surface === "Web") await openProjectSession(page, fixture);
            else await openDesktop(page, fixture);
            const posts: string[] = [];
            const recordPost = (request: import("@playwright/test").Request) => {
              if (request.method() === "POST" && new URL(request.url()).pathname === `/api/sessions/${id}/messages`) posts.push(request.url());
            };
            page.on("request", recordPost);
            try {
              const run = surface === "Web" ? await sendUserMessage(page, id, prompt) : await sendDesktop(page, id, prompt);
              const toolCards = page.locator(surface === "Web" ? ".run-timeline .tool" : ".tool-card");
              await expect(toolCards.filter({ hasText: "run_shell" })).toHaveCount(1, { timeout: 45_000 });
              const eventsPath = `${runsPath}/${run.id}/events`;
              const reconnected = page.waitForRequest(request => new URL(request.url()).pathname === eventsPath && request.headers().accept === "text/event-stream");
              const cut = await page.evaluate(() => {
                window.dispatchEvent(new Event("test:disconnect-run-stream"));
                return document.documentElement.dataset.testRunStreamCut;
              });
              expect(cut).toBe("true");
              if (surface === "Desktop") {
                // Switch away and return without reloading the page. Desktop
                // attaches to the existing Run when reopening a Session.
                await page.getByRole("button", { name: "新建会话", exact: true }).click();
                await page.locator(".side-session").filter({ hasText: fixture.session.title }).first().click();
              }
              const request = await reconnected;
              if (surface === "Web") expect(Number(new URL(request.url()).searchParams.get("after"))).toBeGreaterThan(0);
              release.resolve();
              expect((await waitForRunTerminal(page, id, run.id, 60_000)).status).toBe("completed");
              await expect(toolCards.filter({ hasText: "run_shell" })).toHaveCount(1);
              await expect(page.getByText(answer, { exact: true })).toHaveCount(1);
              expect((await api<Array<{ id: string }>>(page, runsPath)).map(item => item.id)).toEqual([run.id]);
              expect(await sessionExecutionRuns(page, id)).toHaveLength(1);
              expect(posts).toHaveLength(1);
            } finally { page.off("request", recordPost); }
          } finally {
            release.resolve();
            try { if (fixture) await cleanupJourney(page, fixture); } finally { await stub.stop(); }
          }
        });
      }
    } finally { await stopDesktopEntry(desktop); }
  });

  /**
   * E2E-META
   * Purpose: Repair a Runner and continue the same blocked Run from the UI.
   * Steps:
   *   1. Wait on an unavailable sandbox, repair its executable, recheck in Web and verify one dispatch.
   * Environment: Isolated product stack with a disposable local Runner listening on loopback.
   * Type: mocked
   * LLM: Local scripted model acknowledges the retry and explicitly issues a new tool call.
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none
   * Credentials: Isolated stack token.
   * CostSideEffects: Disposable Runner, project and model only.
   */
  test("Web rechecks a repaired Runner and completes the blocked Run once", { tag: "@mocked" }, async ({ page, journey }) => {
    test.setTimeout(180_000);
    journey.scenario({ goal: "Resume a Run after repairing its selected Runner", preconditions: ["Isolated product stack", "Local scripted model"] });
    const runner = await unavailableRunner();
    let hostId: string | undefined;
    let fixture: JourneyFixture | undefined;
    let stub: Awaited<ReturnType<typeof scriptedModel>> | undefined;
    try {
      const host = await api<{ id: string }>(page, "/api/runners", "POST", { alias: `repair-${randomUUID()}`, connectionKind: "direct", endpoint: runner.endpoint, token: runner.token });
      hostId = host.id;
      expect(await api(page, `/api/runners/${host.id}/connect`, "POST", {})).toMatchObject({ state: "ready" });
      const capabilityPath = `/api/runners/${host.id}/execution-capability`;
      expect(await api(page, capabilityPath, "POST", {})).toMatchObject({ capability: { ready: false, reason: "dependency-unavailable" } });
      const marker = `runner-${randomUUID()}`;
      const command = { runner_id: host.id, command: `printf '%s' '${marker}' > recovered.txt`, wait_ms: 30_000 };
      const waitArguments = {
        get operation_id() {
          const results = stub?.calls.find(call => call.step === 1)?.toolResults?.join("\n") ?? "";
          const operation = results.match(/"operationId"\s*:\s*"([^"]+)"/)?.[1];
          if (!operation) throw new Error("Blocked Runner did not return an operationId");
          return operation;
        },
      };
      stub = await scriptedModel([
        { tool: "run_shell", arguments: command },
        { tool: "wait_for_runner", arguments: waitArguments },
        { tool: "run_shell", arguments: command },
        { text: marker },
      ], undefined, { captureContext: true });
      fixture = await fixtureFor(page, stub, "Repair Runner");
      const sessionId = fixture.session.id;
      await api(page, `/api/projects/${fixture.project.id}`, "PATCH", { runnerIds: [host.id] });
      await api(page, `/api/sessions/${sessionId}`, "PATCH", { runnerIds: [host.id] });
      await openProjectSession(page, fixture);
      const run = await sendUserMessage(page, sessionId, "Run the calculation on the selected Runner.");
      const card = page.getByRole("region", { name: "执行受阻" });
      await journey.step("Wait without dispatch", "The selected Runner is unavailable and the call has not started.", async () => {
        await expect(card).toBeVisible({ timeout: 60_000 });
        await expect(card).toContainText(host.id);
        expect(await sessionExecutionRuns(page, sessionId)).toHaveLength(0);
      });
      await journey.step("Repair and recheck", "The retry releases the same Run and only the new tool call dispatches.", async () => {
        await runner.repair();
        await card.getByRole("button", { name: "已修复，重新检查", exact: true }).click();
        expect((await waitForRunTerminal(page, sessionId, run.id, 60_000)).status).toBe("completed");
        await expect(card).toHaveCount(0);
        await expect(page.getByText(marker, { exact: true })).toBeVisible();
        expect(await sessionExecutionRuns(page, sessionId)).toEqual([expect.objectContaining({ runnerId: host.id, status: "succeeded", createdFiles: ["recovered.txt"] })]);
        expect(runner.requests.filter(request => request.method === "POST" && /^\/(execute|execute-shell|shell-executions)(?:\/|$)/.test(request.path))).toHaveLength(1);
        expect(stub!.calls.find(call => call.step === 2)?.toolResults?.join("\n")).toMatch(/"action"\s*:\s*"retry"/);
      });
    } finally {
      try {
        if (fixture) await cleanupJourney(page, fixture);
        if (hostId) await api(page, `/api/remote-hosts/${hostId}`, "DELETE");
      } finally {
        try { await stub?.stop(); } finally { await runner.stop(); }
      }
    }
  });

  /**
   * E2E-META
   * Purpose: A Desktop denial prevents tool execution and persists across reopening.
   * Steps:
   *   1. Submit a command, deny from the card, verify API and workspace, then reload the UI.
   * Environment: Desktop Vite entry against the isolated product API and Runner.
   * Type: mocked
   * LLM: Local scripted tool call and final answer.
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none
   * Credentials: Isolated stack token.
   * CostSideEffects: Disposable session and model only.
   */
  test("Desktop denial skips the command and survives reopening", { tag: "@mocked" }, async ({ page, journey }) => {
    test.setTimeout(180_000);
    journey.scenario({ goal: "Deny a tool without side effects", preconditions: ["Isolated product stack", "Local scripted model"] });
    const desktop = await startDesktopEntry();
    const file = "must-not-exist.txt";
    const answer = "The request was denied.";
    let fixture: JourneyFixture | undefined;
    const stub = await scriptedModel([
      { tool: "run_shell", arguments: { command: `printf denied > ${file}` } },
      { text: answer },
    ], undefined, { captureContext: true });
    try {
      fixture = await fixtureFor(page, stub, "Desktop deny", "ask_for_dangerous");
      const { id } = fixture.session;
      const card = page.locator(".permission-card").filter({ has: page.getByRole("button", { name: "拒绝", exact: true }) });
      const permissions = `/api/permission-requests?sessionId=${id}`;
      await openDesktop(page, fixture);
      const run = await sendDesktop(page, id, "Create the requested file only if permission is granted.");
      await journey.step("Deny the pending tool", "The persisted permission changes to denied and the model observes the denial.", async () => {
        await expect(card).toBeVisible({ timeout: 60_000 });
        const pending = await api<Array<{ id: string }>>(page, permissions);
        expect(pending).toEqual([expect.objectContaining({ state: "pending" })]);
        await card.getByRole("button", { name: "拒绝", exact: true }).click();
        expect((await waitForRunTerminal(page, id, run.id, 60_000)).status).toBe("completed");
        expect(await api(page, permissions)).toEqual([expect.objectContaining({ id: pending[0].id, state: "denied" })]);
        expect(stub.calls.flatMap(call => call.toolResults ?? []).join("\n")).toMatch(/denied|拒绝/i);
      });
      await journey.step("Verify no side effects after reload", "The answer remains, no tool ran, and the denied card cannot be answered again.", async () => {
        expect(await sessionExecutionRuns(page, id)).toHaveLength(0);
        const absent = await page.request.get(`${apiBaseUrl()}/api/sessions/${id}/file?path=${file}`, { headers: authorizationHeader() });
        expect(absent.status()).toBe(404);
        await openDesktop(page, fixture!);
        await expect(page.getByText(answer, { exact: true })).toBeVisible();
        await expect(card).toHaveCount(0);
        await expect(page.locator(".permission-card").getByRole("button", { name: "仅允许一次", exact: true })).toHaveCount(0);
      });
    } finally {
      try { if (fixture) await cleanupJourney(page, fixture); } finally {
        try { await stub.stop(); } finally { await stopDesktopEntry(desktop); }
      }
    }
  });

  /**
   * E2E-META
   * Purpose: A Desktop export can be imported into another project and safely continued.
   * Steps:
   *   1. Create an artifact, export through the UI, import the downloaded bytes, continue and check the immutable original.
   * Environment: Desktop Vite entry against the isolated product API, Runner and research-package storage.
   * Type: mocked
   * LLM: Local scripted artifact creation and continuation.
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none
   * Credentials: Isolated stack token.
   * CostSideEffects: Disposable projects, model and browser download only.
   */
  test("Desktop exports a real research package, imports it and continues in a new Session", { tag: "@mocked" }, async ({ page, journey }, info) => {
    test.setTimeout(240_000);
    journey.scenario({ goal: "Continue from the file produced by a real export", preconditions: ["Isolated product stack", "Local scripted model"] });
    const desktop = await startDesktopEntry();
    const file = "evidence.txt";
    const marker = `Evidence ${randomUUID()}`;
    const firstAnswer = "The evidence file is ready.";
    const continued = "The imported evidence remains available in this continuation.";
    const stub = await scriptedModel([
      [
        { tool: "run_shell", arguments: { command: `printf '%s' '${marker}' > ${file}`, wait_ms: 30_000 } },
        { tool: "declare_artifact", arguments: { artifacts: [{ path: file }] } },
        { text: firstAnswer },
      ],
      [{ text: continued }],
    ], undefined, { waitForShellCompletion: true, captureContext: true });
    let source: JourneyFixture | undefined;
    let destination: JourneyFixture | undefined;
    const sessionPath = (id: string) => `/api/sessions/${id}`;
    async function fileContents(id: string) {
      const response = await page.request.get(`${apiBaseUrl()}${sessionPath(id)}/file?path=${file}`, { headers: authorizationHeader() });
      expect(response.ok()).toBe(true);
      return response.text();
    }
    async function artifactEvidence(id: string) {
      const path = sessionPath(id);
      const artifacts = await api<Array<{ id: string; logicalName: string }>>(page, `${path}/artifacts`);
      expect(artifacts).toEqual([expect.objectContaining({ logicalName: file })]);
      const artifact = `${path}/artifacts/${artifacts[0].id}`;
      const versions = await api<Array<{ id: string; content: { hash: string } }>>(page, `${artifact}/versions`);
      expect(versions).toHaveLength(1);
      const provenance = await api(page, `${path}/artifact-versions/${versions[0].id}/provenance`);
      expect(provenance).toMatchObject({ version: { id: versions[0].id, content: { hash: versions[0].content.hash } } });
      return versions[0].content.hash;
    }
    try {
      source = await fixtureFor(page, stub, "Round trip source");
      const originalId = source.session.id;
      await openDesktop(page, source);
      const original = await sendDesktop(page, originalId, "Produce a short evidence file and declare it as an artifact.");
      expect((await waitForRunTerminal(page, originalId, original.id, 60_000)).status).toBe("completed");
      await expect(page.getByText(firstAnswer, { exact: true })).toBeVisible();
      const hash = await artifactEvidence(originalId);
      const saved = info.outputPath("round-trip.sdresearch");
      await journey.step("Export the actual package", "The backend produces a package that the Desktop UI downloads.", async () => {
        await page.getByRole("button", { name: "会话菜单", exact: true }).click();
        await page.getByRole("menuitem", { name: "导出会话", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "导出会话", exact: true });
        await dialog.getByRole("button", { name: /^完整导出/ }).click();
        await expect(dialog.getByRole("checkbox", { name: /evidence\.txt$/ })).toBeChecked({ timeout: 60_000 });
        const pending = page.waitForEvent("download", { timeout: 60_000 });
        await dialog.getByRole("button", { name: "开始导出", exact: true }).click();
        const download = await pending;
        expect(download.suggestedFilename()).toMatch(/\.sdresearch$/);
        await download.saveAs(saved);
        await expect(page.getByText("证据包已保存", { exact: true })).toBeVisible();
      });
      destination = await createProjectAndSession(page, { projectName: `Round trip target ${randomUUID()}`, modelId: source.model!.id, sessionTitle: "Package destination" });
      await page.reload();
      let snapshotId = "";
      await journey.step("Import the same bytes", "The new project receives a read-only snapshot with identical file and artifact evidence.", async () => {
        await page.getByRole("complementary").getByRole("button", { name: "导入会话", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "导入会话", exact: true });
        await dialog.getByRole("combobox").selectOption(destination!.project.id, { timeout: 15_000 });
        const chooser = page.waitForEvent("filechooser", { timeout: 15_000 });
        await dialog.locator(".research-package-upload").click();
        await (await chooser).setFiles(saved);
        const importButton = dialog.getByRole("button", { name: "导入", exact: true });
        await expect(importButton).toBeEnabled({ timeout: 60_000 });
        const imported = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/projects/${destination!.project.id}/research-package/import`, { timeout: 60_000 });
        await importButton.click();
        const response = await imported;
        expect(response.ok()).toBe(true);
        const { importedSessionIds } = await response.json();
        expect(importedSessionIds).toHaveLength(1);
        [snapshotId] = importedSessionIds;
        expect(snapshotId).not.toBe(originalId);
        await expect(page.getByRole("button", { name: "继续聊天", exact: true })).toBeVisible();
        await expect(page.locator("#composer-textarea")).toHaveCount(0);
        await expect(page.getByText(firstAnswer, { exact: true })).toBeVisible();
        expect(await fileContents(snapshotId)).toBe(marker);
        expect(await artifactEvidence(snapshotId)).toBe(hash);
      });
      await journey.step("Continue independently", "A new writable Session gets a new Run and the snapshot is unchanged.", async () => {
        const summaryBefore = await api<{ messages: unknown }>(page, sessionPath(snapshotId));
        const created = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${sessionPath(snapshotId)}/research-continuations`);
        await page.getByRole("button", { name: "继续聊天", exact: true }).click();
        const operation = await (await created).json();
        let copyId = "";
        await expect.poll(async () => {
          const copy = await api<{ state: string; entrySessionId?: string }>(page, `${sessionPath(snapshotId)}/research-continuations/${operation.id}`);
          copyId = copy.entrySessionId ?? "";
          return copy.state;
        }, { timeout: 60_000 }).toBe("ready");
        expect(copyId).toBeTruthy();
        expect(copyId).not.toBe(snapshotId);
        await expect(page.locator("#composer-textarea")).toBeEditable({ timeout: 30_000 });
        expect(await fileContents(copyId)).toBe(marker);
        await api(page, sessionPath(copyId), "PATCH", { modelId: source!.model!.id });
        await openDesktop(page, { project: destination!.project, session: await api(page, sessionPath(copyId)) });
        const run = await sendDesktop(page, copyId, "Continue from the imported evidence.");
        expect((await waitForRunTerminal(page, copyId, run.id, 60_000)).status).toBe("completed");
        await expect(page.getByText(continued, { exact: true })).toBeVisible();
        expect((await api<{ messages: unknown }>(page, sessionPath(snapshotId))).messages).toEqual(summaryBefore.messages);
        const rejected = await page.request.post(`${apiBaseUrl()}${sessionPath(snapshotId)}/files`, { headers: authorizationHeader(), data: { path: file, content: "should not be writable" } });
        expect(rejected.status()).toBe(409);
        expect((await rejected.json()).code).toBe("SESSION_EVIDENCE_LOCKED");
        expect(await fileContents(snapshotId)).toBe(marker);
      });
    } finally {
      try {
        try { if (destination) await cleanupJourney(page, destination); } finally { if (source) await cleanupJourney(page, source); }
      } finally {
        try { await stub.stop(); } finally { await stopDesktopEntry(desktop); }
      }
    }
  });

});

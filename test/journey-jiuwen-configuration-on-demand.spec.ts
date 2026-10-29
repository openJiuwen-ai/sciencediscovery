// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";

test.describe("Jiuwen application configuration wait", { tag: ["@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {
/**
 * E2E-META
 * Purpose: User choices in configuration cards resume the original Jiuwen task; refusal and Stop never call an unapproved connector.
 * Steps:
 *   1. Start owned loopback model/MCP fixtures and submit a task through the conversation.
 *   2. Confirm the card, repeat the click, separately allow tool execution, and observe one connector call in the original task.
 *   3. Refuse another card and observe the original task finish without the connector.
 *   4. Stop a third waiting task and verify its card cannot resume it after refresh.
 * Environment: Isolated committed JiuwenSwarm product with ordinary upstream core; E2E_SWARM_TASK=1.
 * Type: mocked
 * LLM: owned loopback OpenAI-compatible scripted model; actual JiuwenSwarm agent loop.
 * WebSearch: none
 * PaperSources: none
 * MCP: owned loopback lookup fixture only.
 * OtherExternal: none — non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN; synthetic local model token only.
 * CostSideEffects: Creates and deletes three owned Project/Session records and local model/MCP; no paid services.
 */
test("configuration cards continue or stop the same Jiuwen task", { tag: "@mocked" }, async ({ page, journey }) => {
  test.setTimeout(300_000);
  expect(process.env.E2E_SWARM_TASK, "Actual Jiuwen backend is required").toBe("1");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["test/api/jiuwen-configuration-on-demand.mjs", "--browser"], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { errors += String(chunk); });
  type Fixture = { mode: string; sessionId: string; projectId: string; url: string; prompt: string };
  let fixture: { marker: string; fixtures: Fixture[]; statsUrl: string };
  const api = async (path: string) => {
    const response = await page.request.get(`${apiBaseUrl()}${path}`, { headers: authorizationHeader() });
    expect(response.ok(), path).toBeTruthy(); return response.json();
  };
  let journeyFailed = false;
  try {
    await expect.poll(() => {
      const line = output.split("\n").find(line => line.startsWith("{") && line.includes('"fixtures"'));
      if (line) { fixture = JSON.parse(line); return true; }
      if (child.exitCode !== null) throw new Error(`Fixture exited: ${errors}\n${output}`);
      return false;
    }, { timeout: 30_000 }).toBe(true);
    journey.scenario({ goal: "Continue the original task after a user decision without core interrupt patches.", preconditions: ["Actual JiuwenSwarm backend", "Ordinary upstream openjiuwen core", "Loopback model and MCP"] });
    for (const owned of fixture!.fixtures) {
      await journey.step(`${owned.mode}: decide in the configuration card`, "The card remains actionable; the original run ends once with the expected resource usage.", async () => {
        await page.goto(owned.url);
        const run = await sendUserMessage(page, owned.sessionId, owned.prompt);
        const card = page.locator(".configuration-request").last();
        await expect(card).toBeVisible({ timeout: 60_000 });
        const before = await (await page.request.get(fixture!.statsUrl)).json();
        if (owned.mode === "ALLOW") {
          const choice = card.locator('input[type="radio"][value="persist"]');
          if (await choice.count()) await choice.check();
          const confirm = card.locator("button.primary-button");
          await expect(confirm).toBeEnabled();
          await confirm.dblclick();
          const permissionCard = page.locator("article.permission-card.pending").first();
          // Activation is followed by two real Jiuwen tool/model turns before authorization.
          await expect(permissionCard).toBeVisible({ timeout: 60_000 });
          const beforePermission = await (await page.request.get(fixture!.statsUrl)).json();
          expect(beforePermission.toolCalls).toBe(before.toolCalls);
          const disclosure = permissionCard.locator("button.permission-card-heading");
          if (await disclosure.isVisible() && await disclosure.getAttribute("aria-expanded") === "false") await disclosure.click();
          await permissionCard.getByRole("button", { name: "Allow once", exact: true }).click();
          expect((await waitForRunTerminal(page, owned.sessionId, run.id)).status).toBe("completed");
          await expect(page.getByText(`${fixture!.marker}:RESEARCH_COMPLETE`, { exact: true })).toBeVisible();
          const after = await (await page.request.get(fixture!.statsUrl)).json();
          expect(after.toolCalls).toBe(before.toolCalls + 1);
        } else if (owned.mode === "DECLINE") {
          await card.locator(".configuration-close").click();
          expect((await waitForRunTerminal(page, owned.sessionId, run.id)).status).toBe("completed");
          const after = await (await page.request.get(fixture!.statsUrl)).json();
          expect(after.toolCalls).toBe(before.toolCalls);
          const detail = await api(`/api/sessions/${owned.sessionId}`);
          expect(detail.messages.some((message: { content: string }) => message.content.includes("DECLINED_CONTINUED"))).toBe(true);
        } else {
          await page.getByRole("button", { name: "Stop the current run", exact: true }).click();
          expect((await waitForRunTerminal(page, owned.sessionId, run.id)).status).toBe("cancelled");
          await page.reload();
          await expect(page.locator(".configuration-request button.primary-button")).toHaveCount(0);
          const after = await (await page.request.get(fixture!.statsUrl)).json();
          expect(after.toolCalls).toBe(before.toolCalls);
        }
        expect((await api(`/api/sessions/${owned.sessionId}/runs`)).length).toBe(1);
      });
    }
  } catch (error) { journeyFailed = true; throw error; } finally {
    if (child.exitCode === null) {
      const stopped = once(child, "exit"); child.kill("SIGTERM");
      const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
      try { await stopped; } finally { clearTimeout(deadline); }
    }
    if (!journeyFailed) expect(child.exitCode, errors + output).toBe(0);
  }
});
});

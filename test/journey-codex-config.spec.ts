// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { scriptedModel, createProjectAndSession, openProjectSession, sendUserMessage, cleanupJourney } from "./helpers/journeys.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";

test.describe("Codex specialist configuration", { tag: ["@fixture:standard", "@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {
  /**
   * E2E-META
   * Purpose: Surface missing Codex credentials in conversation and cancel safely.
   * Steps:
   *   1. Register a Codex specialist and ask the local lead to delegate explicitly.
   *   2. Inspect the config card at wide and narrow widths; credentials stay outside chat.
   *   3. Cancel the pending child and reject a stale configuration submission.
   * Environment: Isolated product API/Runner, browser and loopback lead stub.
   * Type: mocked
   * LLM: Local scripted lead only. Codex is never launched because no credential is supplied.
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none
   * Credentials: E2E_API_TOKEN and a synthetic value submitted only after cancellation.
   * CostSideEffects: Creates a specialist, Project/Session/model; removes them in finally.
   */
  test("Show Codex auth card and cancel pending setup", { tag: "@mocked" }, async ({ page, journey }) => {
    journey.scenario({ goal: "Configure an explicit Codex delegation without exposing secrets in chat", preconditions: ["Isolated API/Runner", "Local scripted lead"] });
    const headers = authorizationHeader();
    const created = await page.request.post(`${apiBaseUrl()}/api/specialists`, { headers, data: { name: `Codex ${Date.now()}`, description: "Coding runtime", instructions: "Solve the task", runtime: { kind: "codex" } } });
    expect(created.ok()).toBeTruthy();
    const specialist = await created.json();
    const stub = await scriptedModel([{ tool: "task", arguments: { description: "Codex work", prompt: "Produce a result", specialistId: specialist.id } }, { text: "Delegation ended." }]);
    const fixture = await createProjectAndSession(page, { projectName: `Codex config ${Date.now()}`, sessionTitle: "Codex setup", approvalMode: "always_allow", model: { ...stub, name: `Lead ${Date.now()}` } });
    let child: { id: string; runtimeInput: { id: string; state: string }; status: string };
    try {
      await journey.step("Delegate to Codex", "An interactive config card appears even under Always-allow", async () => {
        await openProjectSession(page, fixture);
        await sendUserMessage(page, fixture.session.id, "Use the Codex specialist for this task.");
        await expect(page.getByRole("form", { name: "Connect Codex to continue" }).first()).toBeVisible({ timeout: 60000 });
        const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/subagents`, { headers });
        child = (await response.json())[0];
        expect(child.runtimeInput.state).toBe("pending");
      });
      for (const width of [390, 1440]) {
        await journey.step(`Inspect private credential entry at ${width}px`, "Password input and submit remain visible and within the viewport", async () => {
          await page.setViewportSize({ width, height: 900 });
          const card = page.getByRole("form", { name: "Connect Codex to continue" }).first();
          await expect(card.getByLabel("OpenAI API key")).toHaveAttribute("type", "password");
          await expect(card.getByRole("button", { name: "Connect and continue" })).toBeVisible();
          await expect(card.getByRole("button", { name: "Connect and continue" })).toBeDisabled();
          const fallback = card.getByRole("checkbox", { name: "Use code-engineer if Codex cannot run" });
          await expect(fallback).toBeVisible();
          if (width === 390) { await expect(fallback).toBeChecked(); await fallback.uncheck(); }
          await expect(fallback).not.toBeChecked();
          const box = await card.getByLabel("OpenAI API key").boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
          expect(stub.calls.every(call => call.route === "main")).toBeTruthy();
        });
      }
      await journey.step("Cancel setup", "Child becomes cancelled; stale secret submission is rejected and no card remains", async () => {
        const stopped = await page.request.post(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/subagents/${child.id}/stop`, { headers });
        expect(stopped.ok()).toBeTruthy();
        await expect.poll(async () => {
          const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/subagents`, { headers });
          return (await response.json())[0].status;
        }).toBe("cancelled");
        const stale = await page.request.post(`${apiBaseUrl()}/api/subagents/${child.id}/codex-config`, { headers, data: { inputId: child.runtimeInput.id, apiKey: "synthetic-stale-secret" } });
        expect(stale.status()).toBe(409);
        await expect(page.getByRole("form", { name: "Connect Codex to continue" })).toHaveCount(0);
      });
    } finally {
      await cleanupJourney(page, fixture);
      await stub.stop();
      await page.request.delete(`${apiBaseUrl()}/api/specialists/${specialist.id}`, { headers });
    }
  });
});

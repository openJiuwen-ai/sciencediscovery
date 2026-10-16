// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, waitForRunTerminal, type JourneyFixture } from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: Keep a conversation identifiable as its main topic changes without losing a manual title.
 * Steps: 1. Create an Untitled session and ask a first question. 2. Change topic. 3. Manually rename and continue. 4. Request a rename.
 * Environment: Isolated local API, Runner and JiuwenSwarm stack.
 * Type: mocked
 * LLM: Local scripted model emits rename_session calls.
 * WebSearch: none.
 * PaperSources: none.
 * MCP: none.
 * ModelDependency: Tool orchestration and visible persistence, not semantic title quality.
 * OtherExternal: none.
 * Credentials: E2E_API_TOKEN for the isolated stack only.
 * CostSideEffects: Temporary model, project and session are removed; no paid calls.
 */
test("session titles follow topics and respect manual edits", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap", "@mocked"] }, async ({ page, journey }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en-US"));
  const stub = await scriptedModel([
    [{ text: "I can help analyze Iris data." }],
    [{ tool: "rename_session", arguments: { title: "Enzyme kinetics", expected_title: "Journey session", reason: "topic_change" } }, { text: "Let us discuss enzyme kinetics." }],
    [{ tool: "rename_session", arguments: { title: "Unwanted replacement", expected_title: "My lab notebook", reason: "initial_topic" } }, { text: "Continuing the same discussion." }],
    [{ tool: "rename_session", arguments: { title: "Kinetics report", expected_title: "My lab notebook", reason: "user_request" } }, { text: "Renamed as requested." }],
  ]);
  let fixture: JourneyFixture | undefined;
  journey.scenario({ goal: "See useful session titles while retaining control over manual names.", preconditions: ["Isolated product stack", "Local scripted model only"] });
  try {
    await journey.step("Create a session and ask a question", "Untitled becomes a short automatic title after the first question.", async () => {
      fixture = await createProjectAndSession(page, { projectName: `Session titles ${Date.now()}`, sessionTitle: "Untitled session", model: { ...stub, name: `Title model ${Date.now()}` } });
      await openProjectSession(page, fixture);
      const run = await sendUserMessage(page, fixture.session.id, "Help analyze Iris data.");
      expect((await waitForRunTerminal(page, fixture.session.id, run.id)).status).toBe("completed");
      await expect(page.getByRole("heading", { name: "Journey session", exact: true })).toBeVisible();
    });
    await journey.step("Change the primary topic", "The agent tool updates the visible session title.", async () => {
      const run = await sendUserMessage(page, fixture!.session.id, "Switch topics to enzyme kinetics.");
      expect((await waitForRunTerminal(page, fixture!.session.id, run.id)).status).toBe("completed");
      await expect(page.getByRole("heading", { name: "Enzyme kinetics", exact: true })).toBeVisible();
    });
    await journey.step("Keep a manual title", "An initial-topic rename cannot overwrite a user-chosen title.", async () => {
      const response = await page.request.patch(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}`, { headers: authorizationHeader(), data: { title: "My lab notebook" } });
      expect(response.ok()).toBeTruthy();
      await page.reload();
      const run = await sendUserMessage(page, fixture!.session.id, "Continue with the same topic.");
      expect((await waitForRunTerminal(page, fixture!.session.id, run.id)).status).toBe("completed");
      await expect(page.getByRole("heading", { name: "My lab notebook", exact: true })).toBeVisible();
    });
    await journey.step("Request a new title", "An explicit rename persists after reloading the page.", async () => {
      const run = await sendUserMessage(page, fixture!.session.id, "Rename this session to Kinetics report.");
      expect((await waitForRunTerminal(page, fixture!.session.id, run.id)).status).toBe("completed");
      await page.reload();
      await expect(page.getByRole("heading", { name: "Kinetics report", exact: true })).toBeVisible();
    });
  } finally {
    if (fixture) await cleanupJourney(page, fixture);
    await stub.close();
  }
});

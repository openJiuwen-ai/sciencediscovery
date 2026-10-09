// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel,
  sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: A custom Specialist receives its instructions and dedicated MCP tool in a real Swarm child.
 * Steps:
 *   1. Register a local MCP server and a custom Specialist bound to that connector.
 *   2. Delegate through task; inspect actual child LLM requests and execute the MCP tool.
 *   3. Verify persisted child completion, parent receipt of the result and browser rendering.
 * Environment: Isolated Swarm stack with platform task delegation and E2E_SWARM_TASK=1.
 * Type: mocked
 * LLM: Local scripted OpenAI-compatible model; actual Swarm main/child loops.
 * WebSearch: none
 * PaperSources: none; synthetic echo data only.
 * MCP: Real SDK stdio echo fixture and real platform-to-Swarm bridge.
 * OtherExternal: none; local API and browser only.
 * Credentials: E2E_API_TOKEN; local model fixture token only.
 * CostSideEffects: Temporary MCP server, Specialist, model and project; cleaned up in finally.
 */
test("Custom Specialist receives dedicated MCP and returns results through Swarm", { tag: ["@mocked","@category:e2e","@os:linux","@arch:amd64","@model:mock","@sandbox:bubblewrap","@fixture:research"] }, async ({ page, journey }, testInfo) => {
  expect(process.env.E2E_SWARM_TASK !== "1", "BLOCKED: requires Swarm with platform task delegation").toBe(false);
  test.setTimeout(240_000);
  const headers = authorizationHeader();
  const marker = `specialist-mcp-${Date.now()}`;
  const instructions = `SPECIALIST_INSTRUCTIONS_${marker}: Use the assigned local echo connector and return its exact result.`;
  let serverId: string | undefined;
  let specialistId: string | undefined;
  let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  let stub: Awaited<ReturnType<typeof scriptedModel>> | undefined;
  journey.scenario({ goal: "A custom Specialist executes its dedicated MCP tool and hands results back to the parent",
    preconditions: ["Real Swarm stack", "Platform task delegation", "Local MCP fixture; no paid APIs"] });
  try {
    const saved = await page.request.post(`${apiBaseUrl()}/api/mcp/servers`, { headers, data: {
      name: marker, command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/mcp-echo.mjs", import.meta.url))], enabled: true,
    } });
    expect(saved.ok()).toBe(true);
    serverId = (await saved.json()).id;
    const tools = await page.request.get(`${apiBaseUrl()}/api/mcp/sources/${serverId}/tools`, { headers });
    expect(tools.ok()).toBe(true);
    const echo = (await tools.json() as Array<{ id: string; mcpToolName: string }>).find(t => t.mcpToolName === "echo");
    expect(echo).toBeDefined();
    const toolName = `mcp__${serverId}__${echo!.id}`;
    const savedSpecialist = await page.request.post(`${apiBaseUrl()}/api/specialists`, { headers, data: {
      name: marker, description: "Synthetic dedicated MCP Specialist", instructions,
      connectorIds: [serverId], enabledSkillIds: [],
    } });
    expect(savedSpecialist.ok()).toBe(true);
    specialistId = (await savedSpecialist.json()).id;
    stub = await scriptedModel([
      { tool: "task", arguments: { specialistId, description: "Use the custom echo Specialist",
        prompt: `Return the echo connector result for ${marker}.`, max_turns: 6, timeout_seconds: 120 } },
      { text: `Parent received specialist result: ${marker.toUpperCase()}` },
    ], [
      { tool: toolName, arguments: { text: marker } },
      { text: `Specialist MCP result: ${marker.toUpperCase()}` },
    ], { captureContext: true });
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow",
      projectName: marker, sessionTitle: "Custom Specialist MCP handoff",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: marker } });
    await openProjectSession(page, fixture);
    const run = await sendUserMessage(page, fixture.session.id, "Delegate to the custom Specialist and return its MCP result.");
    const terminal = await waitForRunTerminal(page, fixture.session.id, run.id, 180_000);
    expect(terminal.status, terminal.error).toBe("completed");
    const childrenResponse = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/subagents`, { headers });
    expect(childrenResponse.ok()).toBe(true);
    const children = await childrenResponse.json();
    expect(children).toHaveLength(1);
    expect(children[0].specialistId).toBe(specialistId);
    expect(children[0].status).toBe("completed");
    expect(children[0].steps.some((s: { toolName?: string; status?: string; content?: string }) =>
      s.toolName === toolName && s.status === "completed" && s.content?.includes(marker.toUpperCase()))).toBe(true);
    const childCalls = stub.calls.filter(c => c.route === "subagent");
    expect(childCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of childCalls) expect(call.systemPrompt).toContain(instructions);
    expect(childCalls.find(c => c.tool === toolName)?.offeredTools).toContain(toolName);
    expect(childCalls.some(c => c.toolResults?.some(r => r.includes(marker.toUpperCase())))).toBe(true);
    expect(stub.calls.some(c => c.route === "main" && !c.tool &&
      c.toolResults?.some(r => r.includes(marker.toUpperCase())))).toBe(true);
    const card = page.locator("section[aria-label='Subagent activity'] details.process-agent-record");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveClass(/completed/);
    await expect(page.locator(".message.assistant").last()).toContainText(`Parent received specialist result: ${marker.toUpperCase()}`);
    await card.locator(":scope > summary").click();
    await card.getByRole("button", { name: /^Open SubAgent: / }).click();
    await expect(page.locator("section.subagent-conversation")).toContainText(`Specialist MCP result: ${marker.toUpperCase()}`);
  } finally {
    try { if (fixture) await cleanupJourney(page, fixture); }
    finally {
      await stub?.stop();
      if (specialistId) await page.request.delete(`${apiBaseUrl()}/api/specialists/${specialistId}`, { headers });
      if (serverId) await page.request.delete(`${apiBaseUrl()}/api/mcp/servers/${serverId}`, { headers });
    }
  }
});

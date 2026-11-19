// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import type { TrajectoryDetail, TrajectoryIndex } from "../packages/trajectory/src/index.js";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession,
  sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";
import { researchModel } from "./helpers/research-model.ts";

/**
 * E2E-META
 * Purpose: A custom Specialist receives its instructions and dedicated MCP tool in a real Swarm child.
 * Steps:
 *   1. Register a local MCP server and a custom Specialist bound to that connector.
 *   2. Delegate two concurrent tasks; observe a failed MCP result in one child and verify its successful retry.
 *   3. Verify child-owned MCP trajectory details and score the parent citations against the tool results.
 * Environment: Isolated Swarm stack with platform task delegation and E2E_SWARM_TASK=1.
 * Type: mocked
 * LLM: Local scripted OpenAI-compatible model; actual Swarm main/child loops.
 * WebSearch: none
 * PaperSources: none; synthetic echo data only.
 * MCP: Real SDK local HTTP echo fixture and real platform-to-Swarm bridge.
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
  let mcp: ReturnType<typeof spawn> | undefined;
  let serverId: string | undefined;
  let specialistId: string | undefined;
  let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  let stub: Awaited<ReturnType<typeof researchModel>> | undefined;
  journey.scenario({ goal: "A custom Specialist executes its dedicated MCP tool and hands results back to the parent",
    preconditions: ["Real Swarm stack", "Platform task delegation", "Local MCP fixture; no paid APIs"] });
  try {
    // Keep one MCP process alive across discovery and calls. The API's stdio
    // transport starts a new Node process for each connection.
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("./fixtures/mcp-echo.mjs", import.meta.url)), "--http", "0",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    mcp = child;
    const port = await new Promise<number>((resolve, reject) => {
      const lines = createInterface({ input: child.stderr });
      const timer = setTimeout(() => reject(new Error("Local MCP did not start")), 30_000);
      const onExit = () => reject(new Error("Local MCP exited before readiness"));
      child.once("error", reject);
      child.once("exit", onExit);
      lines.on("line", (line) => {
        const match = line.match(/^\{"port":(\d+)\}$/);
        if (!match) return;
        lines.close();
        child.off("exit", onExit);
        resolve(Number(match[1]));
      });
      lines.once("close", () => clearTimeout(timer));
    });
    const saved = await page.request.post(`${apiBaseUrl()}/api/mcp/servers`, { headers, data: {
      name: marker, transport: "http", url: `http://127.0.0.1:${port}/mcp`, enabled: true,
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
    const lanes = ["alpha", "beta"] as const;
    const source = (lane: typeof lanes[number]) => `${marker}-${lane}`;
    const evidence = (lane: typeof lanes[number]) => source(lane).toUpperCase();
    const task = (lane: typeof lanes[number]) => ({ name: "task", arguments: {
      specialistId, description: `Inspect source ${lane}`, prompt: `LR_CHILD_${lane}: inspect ${source(lane)}.`,
      max_turns: 6, timeout_seconds: 120,
    } });
    const echoCall = (text: string) => ({ name: toolName, arguments: { text } });
    const synthesis = `Parent received both sources: [${evidence("alpha")}] and [${evidence("beta")}]`;
    stub = await researchModel({
      main: [{ tools: lanes.map(task) }, ({ results }) => {
        for (const lane of lanes) expect(results.join("\n")).toContain(evidence(lane));
        return { text: synthesis };
      }],
      alpha: [
        { tools: [echoCall("error")], gate: "children-started" },
        ({ results }) => {
          expect(results.join("\n")).toContain("Requested fixture error");
          return { tools: [echoCall(source("alpha"))] };
        },
        ({ results }) => {
          expect(results.at(-1)).toContain(evidence("alpha"));
          return { text: `Specialist source [${evidence("alpha")}]` };
        },
      ],
      beta: [
        { tools: [echoCall(source("beta"))], gate: "children-started" },
        ({ results }) => {
          expect(results.at(-1)).toContain(evidence("beta"));
          return { text: `Specialist source [${evidence("beta")}]` };
        },
      ],
    });
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow",
      projectName: marker, sessionTitle: "Custom Specialist MCP handoff",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: marker } });
    await openProjectSession(page, fixture);
    const run = await sendUserMessage(page, fixture.session.id, "Delegate to the custom Specialist and return its MCP result.");
    const listChildren = async () => {
      const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/subagents`, { headers });
      expect(response.ok()).toBe(true);
      return await response.json() as Array<{
        id: string; specialistId: string; status: string; input: { prompt: string };
        steps: Array<{ toolName?: string; status?: string; content?: string }>;
      }>;
    };
    await expect.poll(() => [...new Set(stub!.calls.map(({ route }) => route).filter((route) => route === "alpha" || route === "beta"))].sort(),
      { timeout: 60_000 }).toEqual(lanes);
    expect((await listChildren()).filter(({ status }) => status === "running")).toHaveLength(2);
    stub.release("children-started");
    const terminal = await waitForRunTerminal(page, fixture.session.id, run.id, 180_000);
    expect(terminal.status, terminal.error).toBe("completed");
    expect(stub.errors).toEqual([]);
    const children = await listChildren();
    expect(children).toHaveLength(2);
    expect(new Set(children.map(({ id }) => id)).size).toBe(2);
    const trajectoryUrl = `${apiBaseUrl()}/api/sessions/${fixture.session.id}/trajectory`;
    const indexResponse = await page.request.get(trajectoryUrl, { headers });
    expect(indexResponse.ok()).toBe(true);
    const trajectory: TrajectoryIndex = await indexResponse.json();
    const mcpEntries = trajectory.entries.filter(({ eventType, runId }) => eventType === "mcp.invocation" && runId === run.id);
    expect(mcpEntries).toHaveLength(3);
    const toolSources: string[] = [];
    for (const lane of lanes) {
      const other = lane === "alpha" ? "beta" : "alpha";
      const child = children.find(({ input }) => input.prompt.includes(`LR_CHILD_${lane}:`));
      expect(child).toMatchObject({ specialistId, status: "completed" });
      const toolSteps = child!.steps.filter(({ toolName: name }) => name === toolName);
      expect(toolSteps).toHaveLength(lane === "alpha" ? 2 : 1);
      if (lane === "alpha") expect(toolSteps[0]).toMatchObject({ status: "failed", content: expect.stringContaining("Requested fixture error") });
      expect(toolSteps.at(-1)).toMatchObject({ status: "completed", content: expect.stringContaining(evidence(lane)) });
      expect(JSON.stringify(child!.steps)).not.toContain(evidence(other));
      const agentId = `subagent:${child!.id}`;
      expect(trajectory.agents).toContainEqual(expect.objectContaining({ id: agentId, parentId: `main:${fixture.session.id}` }));
      const entries = mcpEntries.filter(entry => entry.agentId === agentId);
      expect(entries).toHaveLength(lane === "alpha" ? 2 : 1);
      const details = await Promise.all(entries.map(async entry => {
        const response = await page.request.get(`${trajectoryUrl}/detail`, { headers, params: { id: entry.id } });
        expect(response.ok()).toBe(true);
        const detail = await response.json() as TrajectoryDetail;
        expect(detail.entry).toMatchObject({ id: entry.id, agentId, runId: run.id });
        return detail.value as { payloads?: { rawResponse?: { isError?: boolean; content?: unknown; structuredContent?: { echoed?: string } } } };
      }));
      expect(JSON.stringify(details)).not.toContain(evidence(other));
      const responses = details.map(detail => detail.payloads?.rawResponse);
      const failures = responses.filter(response => response?.isError === true);
      expect(failures).toHaveLength(lane === "alpha" ? 1 : 0);
      if (lane === "alpha") expect(JSON.stringify(failures[0]?.content)).toContain("Requested fixture error");
      const observedSources = responses.filter(response => response?.isError !== true)
        .map(response => response?.structuredContent?.echoed);
      expect(observedSources).toEqual([evidence(lane)]);
      toolSources.push(observedSources[0]!);
      for (const call of stub.calls.filter(({ route }) => route === lane)) {
        expect(call.tools).toContain(toolName);
        expect(call.messages.find(({ role }) => role === "system")?.content).toContain(instructions);
      }
    }
    const cards = page.locator("section[aria-label='Subagent activity'] details.process-agent-record");
    await expect(cards).toHaveCount(2);
    for (const card of await cards.all()) await expect(card).toHaveClass(/completed/);
    const finalReply = page.locator(".message.assistant").last();
    await expect(finalReply).toContainText(synthesis);
    const citations = [...(await finalReply.innerText()).matchAll(/\[([^\[\]]+)\]/g)].map(match => match[1]!);
    const expectedSources = new Set(toolSources);
    const correctCitations = new Set(citations.filter(citation => expectedSources.has(citation)));
    await testInfo.attach("citation-score", { contentType: "application/json", body: JSON.stringify({
      expectedSources: toolSources, citations,
      precision: correctCitations.size / Math.max(1, citations.length),
      recall: correctCitations.size / expectedSources.size,
    }) });
    expect(correctCitations.size, "both recorded sources must be cited").toBe(expectedSources.size);
    expect(correctCitations.size, "citations must be supported and unique").toBe(citations.length);
    const alpha = cards.filter({ hasText: "Inspect source alpha" });
    await alpha.locator(":scope > summary").click();
    await alpha.getByRole("button", { name: /^Open SubAgent: / }).click();
    await expect(page.locator("section.subagent-conversation")).toContainText(`Specialist source [${evidence("alpha")}]`);
  } finally {
    stub?.release("children-started");
    try { if (fixture) await cleanupJourney(page, fixture); }
    finally {
      await stub?.stop();
      if (specialistId) await page.request.delete(`${apiBaseUrl()}/api/specialists/${specialistId}`, { headers });
      mcp?.kill();
      if (serverId) await page.request.delete(`${apiBaseUrl()}/api/mcp/servers/${serverId}`, { headers });
    }
  }
});

// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect, type Page } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, sendUserMessage,
  waitForRunTerminal, type JourneyFixture } from "./helpers/journeys.ts";
import { researchModel, type ResearchScriptStep } from "./helpers/research-model.ts";

const cases = ["LR-01", "LR-02", "LR-03", "LR-04", "LR-05", "LR-06", "LR-17"] as const;
const names = { "LR-01": "invalid arguments are never executed and the model re-issues the call", "LR-02": "broken model stream does not execute a partial call",
  "LR-03": "five children roll through two lifecycle permits", "LR-04": "one failed child does not lose sibling results",
  "LR-05": "child timeout releases the queued task", "LR-06": "parent cancellation removes queued work",
  "LR-17": "repeated invalid arguments fail explicitly after bounded recovery" };
const INVALID_SHELL = { name: "run_shell", arguments: {}, rawArguments: '{"command":"printf LR_SHOULD_NOT_EXECUTE' };
const RECOVERY_FEEDBACK = "[Tool argument recovery ";
const lastUserText = (messages: Array<{ role?: string; content?: unknown }>) =>
  String(messages.filter(m => m.role === "user").at(-1)?.content ?? "");

/**
 * E2E-META
 * Purpose: A failed upstream model call does not poison the same session's later tool execution.
 * Steps:
 *   1. Start a request against a local model returning HTTP 503 and cancel it.
 *   2. Submit a healthy request in the same session and verify its shell output and final answer.
 * Environment: Isolated Swarm stack with platform task tools.
 * Type: mocked
 * LLM: Local scripted HTTP model only.
 * WebSearch: none
 * PaperSources: none
 * MCP: Actual platform execution bridge.
 * OtherExternal: Local API, Runner and browser only.
 * Credentials: E2E_API_TOKEN; no provider credentials.
 * CostSideEffects: Temporary local project and session, removed after the test.
 */
test("LR-16 upstream 503 cancellation leaves the same session and shared MCP usable", { tag: ["@mocked","@category:e2e","@os:linux","@arch:amd64","@model:mock","@sandbox:bubblewrap","@fixture:research"] }, async ({ page, journey }, info) => {
  expect(process.env.E2E_SWARM_TASK !== "1", "BLOCKED: requires Swarm task stack").toBe(false);
  test.setTimeout(180_000);
  journey.scenario({ goal: "Recover from upstream failure without restarting services", preconditions: ["Swarm task stack", "local model"] });
  const stub = await researchModel({ main: [
    ({ messages }) => messages.some(m => m.role === "user" && String(m.content).includes("LR_RECOVERY_HEALTHY"))
      ? { tools: [{ name: "run_shell", arguments: { command: "printf LR_RECOVERED_MCP" } }] }
      : { httpStatus: 503 },
    ({ results }) => { expect(results.join("\n")).toContain("LR_RECOVERED_MCP"); return { text: "LR_RECOVERY_COMPLETE" }; },
  ] });
  let fixture: JourneyFixture | undefined;
  let runId: string | undefined;
  try {
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow", model: {
      name: "LR recovery", baseUrl: stub.baseUrl, model: stub.model, apiToken: stub.apiToken,
    } });
    await openProjectSession(page, fixture);
    const first = await sendUserMessage(page, fixture.session.id, "LR_RECOVERY_FAILURE");
    runId = first.id;
    await expect.poll(() => stub.calls.filter(c => c.route === "main").length, { timeout: 60_000 }).toBeGreaterThan(0);
    await api(page, `/api/sessions/${fixture.session.id}/runs/${first.id}/cancel`, "POST");
    const stopped = await waitForRunTerminal(page, fixture.session.id, first.id, 30_000);
    expect(["cancelled", "failed", "interrupted"]).toContain(stopped.status);
    const healthy = await sendUserMessage(page, fixture.session.id, "LR_RECOVERY_HEALTHY");
    runId = healthy.id;
    const terminal = await waitForRunTerminal(page, fixture.session.id, healthy.id, 90_000);
    expect(terminal.status, terminal.error).toBe("completed");
    await expect(page.locator(".message.assistant").last()).toContainText("LR_RECOVERY_COMPLETE");
    expect(stub.errors).toEqual([]);
  } finally {
    await info.attach("recovery-model-requests", { body: JSON.stringify(stub.calls), contentType: "application/json" });
    if (fixture && runId) await page.request.post(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/runs/${runId}/cancel`, { headers: authorizationHeader() }).catch(() => undefined);
    try { if (fixture) await cleanupJourney(page, fixture); }
    finally { await stub.stop(); }
  }
});

async function api<T>(page: Page, path: string, method = "GET", data?: unknown): Promise<T> {
  const response = await page.request.fetch(`${apiBaseUrl()}${path}`, { method, headers: authorizationHeader(), ...(data === undefined ? {} : { data }) });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
  return response.json();
}
type Child = { id: string; status: string; createdAt: string; finishedAt?: string; input: { prompt: string }; steps: Array<{ toolName?: string; status?: string }> };
const delegate = (name: string, extra = {}) => ({ name: "task", arguments: { description: `Collect synthetic source ${name}`,
  prompt: `LR_CHILD_${name}: Return the synthetic source result. No external requests.`, subagent_type: "general-purpose",
  timeout_seconds: 60, max_turns: 6, ...extra } });

// Exercise both model tool-array orders for the two single-permit scenarios.
// Neither order is a promise about which parallel MCP call reaches the pool first.
for (const { id, reverseDispatch } of cases.flatMap(id =>
  (id === "LR-05" || id === "LR-06" ? [false, true] : [false]).map(reverseDispatch => ({ id, reverseDispatch })))) {
/**
 * E2E-META
 * Purpose: Verify Swarm research lifecycle under malformed model output, queueing, partial failure, deadline and cancellation.
 * Steps:
 *   1. Register the local scripted model and dispatch from the UI.
 *   2. Inspect actual task records and model inputs; cancel and restore settings.
 * Environment: Dedicated Swarm stack with E2E_SWARM_TASK=1 and E2E_SWARM_EXCLUSIVE=1; never share with live research.
 * Type: mocked
 * LLM: Loopback OpenAI SSE fixture with independent child identities and deterministic response gates.
 * WebSearch: none
 * PaperSources: none; synthetic source labels only.
 * MCP: Real Swarm-to-platform task bridge and shell tool.
 * OtherExternal: none; real local API, browser and sandbox.
 * Credentials: E2E_API_TOKEN; fixture model token only.
 * CostSideEffects: Temporary project and model; global concurrency quota restored in finally. No paid requests.
 */
test(`${id} ${reverseDispatch ? "reversed dispatch: " : ""}${names[id]}`, { tag: ["@mocked","@category:e2e","@os:linux","@arch:amd64","@model:mock","@sandbox:bubblewrap","@fixture:research"] }, async ({ page, journey }, info) => {
  expect(process.env.E2E_SWARM_TASK !== "1" || process.env.E2E_SWARM_EXCLUSIVE !== "1",
    "BLOCKED: needs an exclusive Swarm test stack; this case temporarily changes global quota settings").toBe(false);
  test.setTimeout(180_000);
  journey.scenario({ goal: names[id], preconditions: ["exclusive Swarm stack", "local scripted model", "no external sources"] });
  const scripts: Record<string, ResearchScriptStep[]> = {};
  let timeoutRoute: string | undefined;
  if (id === "LR-01") {
    // The withheld call never enters the replayed history, so the same step is
    // asked again; only the recovery feedback makes this script re-issue it.
    scripts.main = [({ messages }) => lastUserText(messages).startsWith(RECOVERY_FEEDBACK)
      ? { tools: [{ name: "run_shell", arguments: { command: "printf LR_REISSUED_CALL" } }] }
      : { tools: [INVALID_SHELL] },
    { text: "LR_RECOVERED_FINAL: the re-issued call ran." }];
  } else if (id === "LR-02" || id === "LR-17") {
    scripts.main = [{ tools: [INVALID_SHELL], ...(id === "LR-02" ? { disconnect: true } : {}) }];
  } else {
    const children = id === "LR-03" || id === "LR-06" ? ["a", "b", "c", "d", "e"] : ["a", "b"];
    if (reverseDispatch) children.reverse();
    scripts.main = [{ tools: children.map(name => delegate(name,
      name === "a" && id === "LR-04" ? { max_turns: 1 } : id === "LR-05" ? { timeout_seconds: 15 } : {})) },
    { text: "Fixture synthesis complete. Successful and failed source collection results were received." }];
    for (const child of children) scripts[child] = [{ text: `SOURCE_RESULT_${child}`, ...(id === "LR-03" || id === "LR-06" ? { gate: child } : {}) }];
    if (id === "LR-05") {
      // Parallel MCP task calls need not acquire the pool in model array order.
      // Hold whichever child actually reaches the model first. Both have the
      // same deadline; 15s leaves room for Swarm setup before the gated response.
      for (const child of children) scripts[child] = [({ route }) => {
        timeoutRoute ??= route;
        return { text: `SOURCE_RESULT_${route}`, ...(route === timeoutRoute ? { gate: "timeout" } : {}) };
      }];
    }
    if (id === "LR-04") scripts.a = [{ tools: [{ name: "run_shell", arguments: { command: "printf SOURCE_A_PARTIAL" } }] },
      { text: "UNEXPECTED_BEYOND_CHILD_TURN_LIMIT" }];
  }
  const stub = await researchModel(scripts);
  let fixture: JourneyFixture | undefined;
  let runId: string | undefined;
  let priorQuota: Record<string, unknown> | undefined;
  const children = () => api<Child[]>(page, `/api/sessions/${fixture!.session.id}/subagents`);
  try {
    priorQuota = await api(page, "/api/quota-settings");
    await api(page, "/api/quota-settings", "PUT", { ...priorQuota, maxConcurrentSubagents: id === "LR-05" || id === "LR-06" ? 1 : 2 });
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow", model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Literature ${id} local fixture` },
      projectName: `Literature ${id} ${Date.now()}`, sessionTitle: names[id] });
    await openProjectSession(page, fixture);
    const run = await sendUserMessage(page, fixture.session.id, `Run deterministic literature lifecycle fixture ${id}. Use only local synthetic data.`);
    runId = run.id;
    if (id === "LR-03") {
      // Both first children must be waiting inside real model requests. A third
      // starting here is a pool defect, not a model planning choice.
      await expect.poll(() => new Set(stub.calls.filter(c => !["main", "title"].includes(c.route)).map(c => c.route)).size,
        { timeout: 45_000 }).toBe(2);
      expect((await children()).filter(c => c.status === "running")).toHaveLength(2);
      const started = [...new Set(stub.calls.filter(c => !["main", "title"].includes(c.route)).map(c => c.route))];
      stub.release(started[0]!);
      await expect.poll(() => new Set(stub.calls.filter(c => !["main", "title"].includes(c.route)).map(c => c.route)).size,
        { timeout: 30_000 }).toBe(3);
      for (const name of ["a", "b", "c", "d", "e"]) stub.release(name);
    }
    if (id === "LR-06") {
      await expect.poll(() => stub.calls.filter(c => !["main", "title"].includes(c.route)).length,
        { timeout: 45_000 }).toBe(1);
      const started = stub.calls.find(c => !["main", "title"].includes(c.route))!.route;
      const admitted = await children();
      expect(admitted).toHaveLength(1);
      expect(admitted[0]!.status).toBe("running");
      expect(admitted[0]!.input.prompt).toContain(`LR_CHILD_${started}:`);
      await api(page, `/api/sessions/${fixture.session.id}/runs/${runId}/cancel`, "POST");
      expect((await waitForRunTerminal(page, fixture.session.id, runId, 30_000)).status).toBe("cancelled");
      await expect.poll(async () => (await children()).filter(c => c.status === "running").length, { timeout: 15_000 }).toBe(0);
      expect(stub.calls.filter(c => !["main", "title"].includes(c.route)).map(c => c.route)).toEqual([started]);
      // Refreshing must not start orphaned queued work.
      const count = stub.calls.length;
      await page.reload();
      await openProjectSession(page, fixture);
      expect((await children()).map(c => c.id)).toEqual(admitted.map(c => c.id));
      expect((await children()).every(c => c.status !== "running")).toBe(true);
      expect(stub.calls.slice(count).some(c => !["main", "title"].includes(c.route))).toBe(false);
    } else {
      const terminal = await waitForRunTerminal(page, fixture.session.id, runId, 90_000);
      const main = stub.calls.filter(c => c.route === "main");
      if (id === "LR-01") {
        expect(terminal.status, terminal.error).toBe("completed");
        const activity = await api<{ executions: unknown[] }>(page, `/api/sessions/${fixture.session.id}/agent-activity`);
        await info.attach("recovered-run-activity", { body: JSON.stringify(activity), contentType: "application/json" });
        expect(activity.executions, "Only the re-issued call may run").toHaveLength(1);
        expect(JSON.stringify(activity)).not.toContain("LR_SHOULD_NOT_EXECUTE");
        // The model was told which call failed and why, and the re-issued call's output reached it.
        expect(main).toHaveLength(3);
        expect(lastUserText(main[1]!.messages)).toMatch(/^\[Tool argument recovery 1\/2; invalid_tool_arguments\]/);
        expect(lastUserText(main[1]!.messages)).toContain("run_shell (");
        expect(main[2]!.results.join("\n")).toContain("LR_REISSUED_CALL");
        await expect(page.locator(".message.assistant").last()).toContainText("LR_RECOVERED_FINAL");
        // The withheld-response notice is for Swarm's recovery boundary, never shown to the user.
        await expect(page.locator("body")).not.toContainText("tool_calls_withheld");
      } else if (id === "LR-02" || id === "LR-17") {
        // Explicit terminal failure, NOT silent success.
        expect(terminal.status).toBe("failed");
        expect(terminal.error).toBeTruthy();
        const activity = await api<{ executions: unknown[] }>(page, `/api/sessions/${fixture.session.id}/agent-activity`);
        await info.attach("failed-run-activity", { body: JSON.stringify(activity), contentType: "application/json" });
        expect(activity.executions, "No shell execution may be created from partial/invalid JSON").toHaveLength(0);
        if (id === "LR-17") {
          // One answer plus two bounded recovery attempts, then the run names the cause.
          expect(main).toHaveLength(3);
          expect(main.slice(1).map(c => lastUserText(c.messages).slice(0, 32)))
            .toEqual(["[Tool argument recovery 1/2; inv", "[Tool argument recovery 2/2; inv"]);
          expect(terminal.error).toContain("invalid tool arguments (tools: run_shell) after 2 recovery attempts");
          await expect(page.locator("body")).toContainText(/could not be read|参数无法解析/);
          await expect(page.locator("body")).not.toContainText("tool_calls_withheld");
        } else {
          await expect(page.locator("body")).toContainText(/error|failed|错误|失败/i);
        }
      } else {
        expect(terminal.status, terminal.error).toBe("completed");
        const records = await children();
        expect(records).toHaveLength(id === "LR-03" ? 5 : 2);
        expect(records.some(c => c.status === "running")).toBe(false);
        const results = stub.calls.filter(c => c.route === "main" && c.step === 1).flatMap(c => c.results).join("\n");
        if (id === "LR-03") {
          for (const name of ["a", "b", "c", "d", "e"]) expect(results).toContain(`SOURCE_RESULT_${name}`);
          expect(records.every(c => c.status === "completed")).toBe(true);
          const events = records.flatMap(c => [{ time: Date.parse(c.createdAt), delta: 1 }, { time: Date.parse(c.finishedAt!), delta: -1 }])
            .sort((a, b) => a.time - b.time || a.delta - b.delta);
          let active = 0;
          for (const event of events) { active += event.delta; expect(active).toBeLessThanOrEqual(2); }
        } else {
          if (id === "LR-05") expect(timeoutRoute, "a child must reach the gated model request before timing out").toBeTruthy();
          const failedRoute = id === "LR-05" ? timeoutRoute! : "a";
          const healthyRoute = failedRoute === "a" ? "b" : "a";
          const failed = records.find(c => c.input.prompt.includes(`LR_CHILD_${failedRoute}:`))!;
          // Existing lifecycle contract classifies both time and turn budget
          // exhaustion as timed_out; distinguish them by the exact cause.
          expect(failed.status).toBe("timed_out");
          expect(results).toContain(`SOURCE_RESULT_${healthyRoute}`);
          expect(results).toMatch(id === "LR-05" ? /timed_out|timeout|timed out/i : /maxTurns=1/);
          if (id === "LR-04") {
            expect(stub.calls.filter(c => c.route === "a")).toHaveLength(1);
            expect(results).not.toContain("UNEXPECTED_BEYOND_CHILD_TURN_LIMIT");
          }
          if (id === "LR-05") {
            const healthy = records.find(c => c.input.prompt.includes(`LR_CHILD_${healthyRoute}:`))!;
            expect(healthy.status).toBe("completed");
            expect(stub.calls.filter(c => !["main", "title"].includes(c.route)).map(c => c.route))
              .toEqual([failedRoute, healthyRoute]);
            expect(Date.parse(healthy.createdAt)).toBeGreaterThanOrEqual(Date.parse(failed.finishedAt!));
          }
        }
        await expect(page.locator(".message.assistant").last()).toContainText("Fixture synthesis complete");
      }
    }
    expect(stub.errors).toEqual([]);
  } finally {
    await info.attach("mock-model-requests", { body: JSON.stringify(stub.calls), contentType: "application/json" });
    await info.attach("mock-model-errors", { body: JSON.stringify(stub.errors), contentType: "application/json" });
    try {
      if (fixture && runId) await page.request.post(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/runs/${runId}/cancel`, { headers: authorizationHeader() }).catch(() => undefined);
      if (fixture) await cleanupJourney(page, fixture);
    } finally {
      try { if (priorQuota) await api(page, "/api/quota-settings", "PUT", priorQuota); }
      finally { await stub.stop(); }
    }
  }
});
}

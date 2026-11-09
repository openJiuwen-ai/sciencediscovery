// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";
import { drbApi } from "./helpers/deepresearchbench.ts";
import { runTestCleanup } from "./helpers/test-failure.ts";

/**
 * E2E-META
 * Purpose: Real Python cache creation and modification finalize without hiding ordinary report outputs.
 * Steps:
 *   1. Create an isolated Session driven by a local scripted model.
 *   2. Import a real Python module twice, changing its source and report between imports.
 *   3. Verify both executions commit once, retain their logs, and deliver the ordinary report.
 * Environment: Isolated local API/Web, real Runner shell sandbox and Python.
 * Type: mocked
 * LLM: local deterministic model stub only.
 * WebSearch: none
 * PaperSources: none
 * MCP: production shell and Artifact tools through the selected backend.
 * OtherExternal: none; only loopback HTTP and real local sandbox execution.
 * Credentials: E2E_API_TOKEN for the isolated stack; the stub token has no external access.
 * CostSideEffects: no paid calls; temporary model, Project and Session removed in finally.
 */
test("Python cache changes commit once and preserve the report", {
  tag: ["@mocked", "@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"],
}, async ({ journey, page }, info) => {
  test.setTimeout(240_000);
  const command = (source: string, report: string) =>
    `mkdir -p results && printf '${source}\\n' > solution.py && python3 -c 'import solution; print(solution.value)' && find __pycache__ -type f -name '*.pyc' && printf '${report}\\n' > results/report.txt`;
  const stub = await scriptedModel([
    { tool: "run_shell", arguments: { command: command("value = 42", "original report") } },
    { tool: "run_shell", arguments: { command: command("value = 4300", "updated report") } },
    { tool: "declare_artifact", arguments: { path: "results/report.txt" } },
    { text: "The updated report is ready in results/report.txt." },
  ], undefined, { waitForShellCompletion: true });
  let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  let primaryFailure: { error: unknown } | undefined;
  journey.scenario({ goal: "Import Python modules and receive a committed report despite generated cache files.",
    preconditions: ["isolated stack", "local model stub", "real shell sandbox"] });
  try {
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Cache finalization ${Date.now()}` },
      projectName: `Cache finalization ${Date.now()}`, sessionTitle: "Python cache and report" });
    await openProjectSession(page, fixture);
    const sessionId = fixture.session.id;
    await journey.step("Run and update a Python module", "Both real imports finish and the report is delivered.", async () => {
      const run = await sendUserMessage(page, sessionId, "Import the module, update it, and deliver results/report.txt.");
      const terminal = await waitForRunTerminal(page, sessionId, run.id, 180_000);
      expect(terminal.status, terminal.error).toBe("completed");
    });
    await journey.step("Inspect committed execution evidence", "Exactly two executions commit, retain Python cache logs and expose only the declared report.", async () => {
      const prefix = `/api/sessions/${sessionId}`;
      const activity = await drbApi<{ executions: Array<{ id: string; state: string; provenance: string }> }>(page, `${prefix}/agent-activity`);
      expect(activity.executions).toHaveLength(2);
      expect(new Set(activity.executions.map(execution => execution.id)).size).toBe(2);
      const logs: string[] = [];
      for (const execution of activity.executions) {
        expect(execution).toMatchObject({ state: "completed", provenance: "committed" });
        const output = await drbApi<{ chunks: Array<{ text: string }> }>(page, `${prefix}/agent-activity/executions/${execution.id}/logs`);
        logs.push(output.chunks.map(chunk => chunk.text).join(""));
      }
      expect(logs.join("\n")).toContain("4300");
      expect(logs.every(log => /__pycache__\/solution\..*\.pyc/.test(log))).toBe(true);
      const artifacts = await drbApi<any[]>(page, `${prefix}/artifacts`);
      expect(JSON.stringify(artifacts)).toContain("results/report.txt");
      expect(JSON.stringify(artifacts)).not.toContain("__pycache__");
      await info.attach("committed-executions", { body: JSON.stringify(activity.executions), contentType: "application/json" });
    });
  } catch (error) { primaryFailure = { error }; throw error; }
  finally {
    await runTestCleanup(primaryFailure, async () => {
      try { if (fixture) await cleanupJourney(page, fixture); }
      finally { await stub.stop(); }
    });
  }
});

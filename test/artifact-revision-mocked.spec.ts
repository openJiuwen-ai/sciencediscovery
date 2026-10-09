// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession, sendUserMessage, waitForRunTerminal, type JourneyFixture } from "./helpers/journeys.ts";
import { drbApi } from "./helpers/deepresearchbench.ts";
import { researchModel } from "./helpers/research-model.ts";

/**
 * E2E-META
 * Purpose: Edit a large parent Artifact in an isolated Swarm child without retranscribing its content.
 * Steps:
 *   1. Generate and declare a large report in the parent workspace.
 *   2. Give a child only the immutable reference; import, patch and explicitly publish a revision.
 *   3. Verify both immutable versions and exact content, and short metadata-only materialization output.
 * Environment: Isolated Swarm stack, local Runner and offline research model.
 * Type: mocked
 * LLM: Scripted local provider through the real model gateway.
 * WebSearch: none
 * PaperSources: none
 * MCP: Real platform bridge and bubblewrap shell.
 * OtherExternal: none
 * Credentials: E2E_API_TOKEN; fixture model token.
 * CostSideEffects: Temporary local project and files only.
 */
test("AR-01 child edits a fixed artifact version without copying its text", {
  tag: ["@mocked", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap", "@fixture:research"],
}, async ({ page, journey }, info) => {
  expect(process.env.E2E_SWARM_TASK, "requires native task delegation into Swarm").toBe("1");
  test.setTimeout(180_000);
  journey.scenario({ goal: "Original bytes enter an isolated child; its edit creates one explicit new version", preconditions: ["Swarm task delegation", "local sandbox"] });
  let artifactId = "", baseVersionId = "";
  const stub = await researchModel({
    main: [
      { tools: [{ name: "run_shell", arguments: { command: "python3 - <<'PY'\nfrom pathlib import Path\nPath('report.md').write_text('引用 [1] — αβ\\n' * 12000, encoding='utf-8')\nPY" } }] },
      { tools: [{ name: "declare_artifact", arguments: { path: "report.md" } }] },
      request => {
        const text = request.results.join("\n");
        artifactId = text.match(/"artifact_id"\s*:\s*"([^"]+)"/)?.[1] ?? "";
        baseVersionId = text.match(/"version_id"\s*:\s*"([^"]+)"/)?.[1] ?? "";
        if (!artifactId || !baseVersionId) throw new Error("Missing real artifact receipt");
        return { tools: [{ name: "task", arguments: { description: "Edit fixed report version", subagent_type: "general-purpose",
          prompt: `LR_CHILD_editor: Materialize artifact ${artifactId} version 1 into edit.md, change the first citation only, then publish against ${baseVersionId}. Return its reference only.`,
          max_turns: 8, timeout_seconds: 90 } }] };
      },
      { text: "Delivered the revised report Artifact." },
    ],
    editor: [
      () => ({ tools: [{ name: "materialize_artifact", arguments: { artifact_id: artifactId, version: 1, path: "edit.md" } }] }),
      { tools: [{ name: "run_shell", arguments: { command: "python3 - <<'PY'\nfrom pathlib import Path\np=Path('edit.md')\np.write_bytes(p.read_bytes().replace(b'[1]', b'[2]', 1))\nPY" } }] },
      () => ({ tools: [{ name: "declare_artifact", arguments: { artifact_id: artifactId, base_version_id: baseVersionId, path: "edit.md" } }] }),
      { text: "Published version 2; only the first citation changed." },
    ],
  });
  let fixture: JourneyFixture | undefined;
  try {
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow", projectName: `Artifact revision ${Date.now()}`, sessionTitle: "Artifact edit",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: "Artifact revision fixture" } });
    await openProjectSession(page, fixture);
    const run = await sendUserMessage(page, fixture.session.id, "Generate a fixture report and delegate its citation repair via an Artifact reference.");
    const terminal = await waitForRunTerminal(page, fixture.session.id, run.id, 120_000);
    expect(terminal.status, terminal.error).toBe("completed");
    const prefix = `/api/sessions/${fixture.session.id}`;
    const versions = await drbApi<any[]>(page, `${prefix}/artifacts/${artifactId}/versions`);
    versions.sort((a, b) => a.version - b.version);
    expect(versions).toHaveLength(2);
    expect(versions[1].baseVersionId).toBe(baseVersionId);
    expect(versions[1].inputArtifactVersionIds).toContain(baseVersionId);
    // read_artifact itself is not used in the model script: inspect persisted bytes via API.
    const { apiBaseUrl, authorizationHeader } = await import("./e2e-auth.js");
    const contents = await Promise.all(versions.map(async v => {
      const r = await page.request.get(`${apiBaseUrl()}${prefix}/artifact-versions/${v.id}/content`, { headers: authorizationHeader() });
      expect(r.ok()).toBe(true); return r.text();
    }));
    const original = "引用 [1] — αβ\n".repeat(12000);
    expect(contents).toEqual([original, original.replace("[1]", "[2]")]);
    const importResult = stub.calls.find(c => c.route === "editor" && c.step === 1)?.results.join("\n") ?? "";
    expect(importResult).toContain(baseVersionId);
    expect(importResult.length).toBeLessThan(2000);
    expect(importResult).not.toContain("引用");
    expect(stub.errors).toEqual([]);
  } finally {
    await info.attach("model-input-tool-results", { body: JSON.stringify(stub.calls), contentType: "application/json" });
    await info.attach("fixture-errors", { body: JSON.stringify(stub.errors), contentType: "application/json" });
    try { if (fixture) await cleanupJourney(page, fixture); } finally { await stub.stop(); }
  }
});

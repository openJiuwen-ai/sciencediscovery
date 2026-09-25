// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { test, requireRealEnv, requireRealStack, allowRealEnvException } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";
import { drbApi, positiveNumber } from "./helpers/deepresearchbench.ts";
import { evolutionScorecard } from "./helpers/evolve-result.mjs";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";

/**
 * E2E-META
 * Purpose: Guard the documented PUCT text compression tutorial through real design, search and persisted delivery.
 * Steps:
 *   1. Read the tutorial prompt, create a session and choose PUCT in the browser.
 *   2. Submit the real task; acknowledge design checkpoints if the Agent asks.
 *   3. Wait for the main Agent and actual background search to finish; read its persisted result.
 *   4. Record the search's held-out score independently, without improvement or minimum-score assertions.
 * Environment: Linux Swarm stack with platform task delegation, bubblewrap, scientific Python and evolve sidecar.
 * Type: real
 * LLM: Real configured model designs the evaluator and generates search candidates.
 * WebSearch: Not required; text corpora are generated in the sandbox.
 * PaperSources: None.
 * MCP: Real platform tools if selected by the Agent; no scripted model or mocked execution.
 * OtherExternal: Configured model endpoint; first environment setup may download packages.
 * Credentials: E2E_API_TOKEN and E2E_LLM_MODEL_ID or E2E_LLM_BASE_URL/E2E_LLM_MODEL/E2E_LLM_TOKEN.
 * CostSideEffects: Billable model calls and sandbox evaluations; temporary project, session and model; retained score and artifacts.
 */
test("PUCT-COMPRESS documented text compression search", {
  tag: ["@real", "@category:e2e", "@os:linux", "@arch:amd64", "@model:real", "@sandbox:bubblewrap"],
}, async ({ page, journey }, info) => {
  const budget = positiveNumber("E2E_EVOLVE_RUN_TIMEOUT_MS", 7_200_000);
  test.setTimeout(budget + 240_000);
  await requireRealStack(info);
  const modelId = process.env.E2E_LLM_MODEL_ID;
  if (modelId) allowRealEnvException(info, "Use the configured real server-side model.");
  const env = modelId ? undefined : requireRealEnv(info, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
  const headers = authorizationHeader();
  const api = <T = any>(path: string) => drbApi<T>(page, path);
  const save = (name: string, data: unknown) => writeFile(info.outputPath(name), JSON.stringify(data, null, 2));
  const metrics: any = { case: "PUCT-COMPRESS", integration_status: "running", started_at: new Date().toISOString(), turns: [] };
  let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  let runId: string | undefined;
  let searches: any[] = [];
  journey.scenario({ goal: "Complete the documented PUCT compression task and report its own final score",
    preconditions: ["Real model", "Working sandbox, Python environment and evolve sidecar"] });
  try {
    const doc = await readFile(new URL("../docs/zh/domains/evolve-a-solution.md", import.meta.url), "utf8");
    const prompt = doc.match(/```text\n([\s\S]*?)\n```/)?.[1];
    if (!prompt?.startsWith("/evolve-design ")) throw new Error("Tutorial task prompt is missing");
    metrics.document = "docs/zh/domains/evolve-a-solution.md";
    metrics.prompt = prompt;
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow", projectName: `PUCT compression ${Date.now()}`,
      sessionTitle: "PUCT text compression", ...(modelId ? { modelId } : { model: {
        apiToken: env!.E2E_LLM_TOKEN!, baseUrl: env!.E2E_LLM_BASE_URL!, model: env!.E2E_LLM_MODEL!, name: "PUCT tutorial generator",
      } }) });
    const prefix = `/api/sessions/${fixture.session.id}`;
    metrics.session_id = fixture.session.id;
    await openProjectSession(page, fixture);
    const box = page.locator("form.composer").getByRole("textbox");
    await box.fill("/evolve-design ");
    await page.getByRole("option").filter({ hasText: "PUCT" }).click();
    const selectedCommand = await box.inputValue();
    expect(selectedCommand).toContain("--algorithm puct");
    await box.fill(selectedCommand.trimEnd() + " " + prompt.slice("/evolve-design ".length));
    await page.screenshot({ path: info.outputPath("selected-puct.png") });

    const send = async (text: string) => {
      const before = new Set((await api<any[]>(`${prefix}/runs`)).map(run => run.id));
      await box.fill(text);
      await page.getByRole("button", { name: /^(Run analysis|Add to queue|运行分析|加入队列)$/ }).click();
      let created: any;
      // Slash commands may expand into skill context, so compare persisted identities, not rewritten prompt text.
      await expect.poll(async () => {
        created = (await api<any[]>(`${prefix}/runs`)).find(run => !before.has(run.id));
        return created?.id;
      }, { timeout: 30_000 }).toBeTruthy();
      metrics.turns.push({ id: created.id, prompt: text });
      return created.id as string;
    };
    runId = await send(await box.inputValue());
    const deadline = Date.now() + budget;
    let confirmations = 0;
    let complete = false;
    while (Date.now() < deadline) {
      const run = (await api<any[]>(`${prefix}/runs`)).find(run => run.id === runId);
      searches = await api<any[]>(`/api/evolve/runs?sessionId=${fixture.session.id}`);
      metrics.run = run; metrics.searches = searches;
      await save("evolve-metrics.json", metrics);
      if (run && ["failed", "cancelled"].includes(run.status)) throw new Error(`Main run ${run.status}: ${run.error ?? "see trajectory"}`);
      if (run?.status === "completed") {
        if (!searches.length) {
          if (confirmations++ >= 4) throw new Error("No search started after four design-checkpoint replies");
          runId = await send("你决定，按文档推荐规模直接跑；使用 PUCT，完成余下检查点并启动搜索。");
        } else if (searches.every(search => !["pending", "running"].includes(search.status))) {
          complete = true;
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
    expect(complete, "Main run and background search must finish within the run budget").toBe(true);
    const search = [...searches].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)!;
    metrics.search = search;
    const events = await api<any[]>(`/api/evolve/runs/${search.id}/events`);
    await save("evolve-events.json", events);
    // Quality never gates completion, including absent test scores and a winner equal to the seed.
    metrics.evaluation = evolutionScorecard(search, events);
    await save("quality-scorecard.json", metrics.evaluation);
    await info.attach("quality-scorecard", { path: info.outputPath("quality-scorecard.json"), contentType: "application/json" });
    expect(search.algorithm).toBe("puct");
    expect(["succeeded", "budget_exhausted"], "Background search must complete normally").toContain(search.status);
    const finished = events.findLast(record => record.event.type === "search_finished");
    expect(finished?.event.status, "Completion event must agree with persisted search state").toBe(search.status);

    // Match the actual selected code, not a fixed filename or an intermediate seed upload.
    const bestIndex = finished?.event.bestNodeIndex;
    const expectedHash = (bestIndex === 0 ? search.goal.baselineProgramCas
      : events.findLast(record => record.event.type === "expanded" && record.event.nodeIndex === bestIndex)?.event.codeHash)?.replace(/^sha256:/, "");
    expect(expectedHash, "Completed search identifies its result code").toBeTruthy();
    let artifact: any;
    let versions: any[] = [];
    let latest: any;
    await expect.poll(async () => {
      const catalog = await api<any[]>(`${prefix}/artifacts`);
      // Prefer the search's publication. If the seed stayed best, its original artifact is also valid delivery.
      const candidates = catalog.filter(item => item.originMeta?.evolveRunId === search.id || bestIndex === 0)
        .sort((a, b) => Number(b.originMeta?.evolveRunId === search.id) - Number(a.originMeta?.evolveRunId === search.id));
      for (const item of candidates) {
        const rows = await api<any[]>(`${prefix}/artifacts/${item.id}/versions`);
        const version = rows.find(v => v.content?.hash === expectedHash);
        if (version) { artifact = item; versions = rows; latest = version; return version.id; }
      }
      return undefined;
    }, { timeout: 30_000, message: "Search result code must be persisted as an artifact" }).toBeTruthy();
    const response = await page.request.get(`${apiBaseUrl()}${prefix}/artifact-versions/${latest.id}/content`, { headers });
    expect(response.ok()).toBe(true);
    const code = await response.text();
    expect(code.trim().length).toBeGreaterThan(0);
    await writeFile(info.outputPath("result.py"), code);
    metrics.delivery = { artifact_id: artifact.id, version_id: latest.id, logical_name: artifact.logicalName, versions };
    metrics.integration_status = "passed";
    await page.screenshot({ path: info.outputPath("completed.png"), fullPage: true });
  } catch (error) {
    metrics.integration_status = "failed";
    metrics.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    metrics.finished_at = new Date().toISOString();
    if (fixture) {
      const prefix = `/api/sessions/${fixture.session.id}`;
      await save("session.json", await api(prefix).catch(() => null));
      await save("children.json", await api(`${prefix}/subagents`).catch(() => []));
      await save("artifacts.json", await api(`${prefix}/artifacts`).catch(() => []));
      searches = await api<any[]>(`/api/evolve/runs?sessionId=${fixture.session.id}`).catch(() => searches);
      for (const search of searches) {
        await save(`evolve-${search.id}.json`, { search, events: await api(`/api/evolve/runs/${search.id}/events`).catch(() => []) });
        if (["pending", "running"].includes(search.status)) await page.request.post(`${apiBaseUrl()}/api/evolve/runs/${search.id}/stop`, { headers }).catch(() => {});
      }
      if (runId) await page.request.post(`${apiBaseUrl()}${prefix}/runs/${runId}/cancel`, { headers }).catch(() => {});
    }
    await save("evolve-metrics.json", metrics);
    if (fixture && process.env.E2E_KEEP_RESEARCH_RECORDS !== "1") await cleanupJourney(page, fixture);
  }
});

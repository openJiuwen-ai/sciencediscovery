// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { collectFinalDelivery } from "./helpers/real-delivery.ts";
import { evaluateTeam } from "./helpers/research-team.ts";
import { expect } from "@playwright/test";
import { test, allowRealEnvException, requireRealEnv, requireRealStack } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, sendUserMessage } from "./helpers/journeys.ts";
import { drbApi, positiveNumber } from "./helpers/deepresearchbench.ts";
import { startDeliverableChecker } from "./fixtures/deliverable-check.mjs";

const prompt = "综述 2020—2025 年 BRCA1 致病性或可能致病性胚系变异与女性乳腺癌风险的证据。提取可追溯的风险比或效应量，按指标类型及可比研究条件分组，进行小规模描述性统计，不进行合并效应估计；提供输入数据、可复现代码和结果。输出含 Methods、Results、References 章节的证据简报，并完成团队配置的交付审核。证据不足时明确说明，不得补造数据。";
const roles = ["literature-searcher", "evidence-extractor", "code-engineer", "result-evaluator", "report-writer"];

function extension(reviewer: string) {
  return `# Research team with delivery signoff
Load the built-in science-research-team SKILL.md and read its references/workflow.md completely. Follow that workflow, including analysis-principles.md and its five built-in specialists; do not replace the workflow with your own or do their work yourself. Knowledge must feed data. max_engineer_evaluator_iterations=3 per analysis branch. Pass revision guidance verbatim.
This managed extension adds delivery signoff AFTER report-writer finishes and BEFORE final delivery. Delegate to specialistId=${reviewer}, supplying the exact FULL final report text, artifact ID and version ID. Do not summarize the text. Return the checker's actual ok/missing conclusion with the final report. If the report changes, audit the new version again. Never claim a missing/failed audit passed.
For machine-readable delivery in this test, declare these final artifacts (normal platform artifact handoff, not transient /tmp paths):
- literature_sources.json: {sources:[{id,title,doi?,pmid?,url?}]} from literature-searcher. Retain the normal source metadata as well.
- evidence.json: {observations:[{id,source_id,measure,value,group_key,population,comparison,location}]} from evidence-extractor. Numeric values must be supported by the source; location identifies the source table/paragraph. Use distinct observation IDs; don't duplicate the same estimate. If evidence is unavailable, report that rather than inventing it.
- knowledge_summary.md: integrate the knowledge results with their source and observation identifiers.
- analysis.py: executed code from code-engineer reading evidence.json; use the available Python environment and standard library where sufficient. Group by measure plus comparable population/comparison (group_key); do NOT pool unlike measures. At least one comparable group with two observations is needed for a complete statistical delivery, but never fabricate observations to meet this.
- analysis_results.json: {groups:[{group_key,measure,observation_ids,count,mean,min,max}]} produced by executing the code. Means are descriptive, not pooled clinical effects.
- evaluation-N.json (N=1..3 per branch): evaluator's original structured evaluation, including verdict or decision and revision_guidance if REVISE. The builtin evaluator uses verdict and may return CONDITIONAL; preserve it verbatim rather than fabricating decision. CONDITIONAL is an incomplete quality outcome, not unconditional acceptance. A formatting re-emission is not a new evaluation round.
- analysis_summary.md: integrate actual analysis outputs, methods, caveats and reproducibility information.
- evidence_brief.md: report-writer output consuming both summaries, with exact Markdown Methods, Results, References headings and source-linked citations. This is the report to audit.
The reviewer must not rewrite the report. Explicitly name evidence_brief.md in the final response and append the audit's ok and missing values. No silent replacement of failed specialists or invented results.`;
}

/**
 * E2E-META
 * Purpose: TC-E2E-01 validates built-in research-team reuse with a managed extension, custom Specialist and HTTP MCP signoff.
 * Steps:
 *   1. Register a local HTTP MCP checker, a custom reviewer and a managed team extension; select the extension in a Session.
 *   2. Run the BRCA1 knowledge/data task using real LLMs and Swarm, recording children and immutable artifacts.
 *   3. Assert terminal completion and nonempty final artifacts; independently score frozen evidence with tc-research-quality-v1.
 * Environment: Opt-in isolated Swarm stack, Python Runner, enabled built-in specialists/skills, live literature access.
 * Type: real
 * LLM: Configured real generator for main and children, plus independent read-only rubric Judge.
 * WebSearch: Live configured providers if selected by the Agent.
 * PaperSources: Live built-in literature MCP sources, not fixtures.
 * MCP: Real local HTTP deliverable_check and live literature MCPs.
 * OtherExternal: Real model endpoint and literature sites; local API, Runner and browser.
 * Credentials: E2E_API_TOKEN and E2E_LLM_MODEL_ID or E2E_LLM_BASE_URL/E2E_LLM_MODEL/E2E_LLM_TOKEN.
 * JudgeCredentials: TEAM_JUDGE_BASE_URL, TEAM_JUDGE_API_KEY, TEAM_JUDGE_MODEL (OPENAI_BASE_URL/API_KEY and RACE_MODEL fallbacks).
 * CostSideEffects: Billable LLM calls; isolated temporary project, model, Specialist, skill and MCP server; private traces retained.
 */
test("TC-E2E-01 research team with custom Specialist and MCP signoff", { tag: ["@real","@category:e2e","@os:linux","@arch:amd64","@model:real","@sandbox:bubblewrap","@judge:llm"] }, async ({ page, journey }, info) => {
  const budget = positiveNumber("E2E_TEAM_RUN_TIMEOUT_MS", 3_600_000);
  const judgeBudget = positiveNumber("E2E_TEAM_EVAL_TIMEOUT_MS", 900_000);
  test.setTimeout(budget + judgeBudget + 240_000);
  expect(process.env.E2E_SWARM_TASK !== "1", "Requires isolated Swarm platform-task stack").toBe(false);
  await requireRealStack(info);
  const modelId = process.env.E2E_LLM_MODEL_ID;
  if (modelId) allowRealEnvException(info, "Use the existing isolated real model; credentials remain server-side.");
  const real = modelId ? undefined : requireRealEnv(info, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
  const checker = await startDeliverableChecker();
  const headers = authorizationHeader();
  const api = <T = any>(path: string) => drbApi<T>(page, path);
  const save = async (name: string, value: unknown) => writeFile(info.outputPath(name), JSON.stringify(value, null, 2));
  const metrics: any = { case: "TC-E2E-01", prompt, started_at: new Date().toISOString(), integration: "running",
    quality: "not_judged", budget_ms: budget };
  let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  let connector: string | undefined, specialist: string | undefined, skill: string | undefined, runId: string | undefined;
  let terminal = false;
  let children: any[] = [];
  const artifacts: Record<string, { text: string; id: string; version: string }> = {};
  journey.scenario({ goal: "Complete dual-domain research through the built-in team plus a custom delivery reviewer",
    preconditions: ["Real LLM and Swarm", "Five built-in roles", "Live literature MCP", "Local HTTP signoff tool"] });
  try {
    const builtins = await api<any[]>("/api/specialists");
    for (const role of roles) expect(builtins.some(s => s.id === `builtin-${role}` && s.enabled !== false), role).toBe(true);
    const skills = await api<any[]>("/api/skills");
    expect(skills.some(s => s.id === "science-research-team")).toBe(true);
    const response = await page.request.post(`${apiBaseUrl()}/api/mcp/servers`, { headers, data: { name: `signoff-${Date.now()}`, transport: "http", url: checker.url, enabled: true } });
    expect(response.ok()).toBe(true); connector = (await response.json()).id;
    const tools = await api<any[]>(`/api/mcp/sources/${connector}/tools`);
    expect(tools.map(t => t.mcpToolName)).toEqual(["deliverable_check"]);
    const toolName = `mcp__${connector}__${tools[0].id}`;
    const reviewerInstructions = "Use only your mounted deliverable_check MCP for delivery audit. Pass the supplied full report unchanged as report_text. Return the actual ok/missing/message result and the supplied artifact/version identity. Do not rewrite the report or invent a passing result.";
    const specialistResponse = await page.request.post(`${apiBaseUrl()}/api/specialists`, { headers, data: {
      name: "deliverable-reviewer", description: "Final delivery section audit with custom MCP", instructions: reviewerInstructions,
      connectorIds: [connector], enabledSkillIds: [],
    } });
    expect(specialistResponse.ok()).toBe(true); specialist = (await specialistResponse.json()).id;
    const skillResponse = await page.request.post(`${apiBaseUrl()}/api/skills`, { headers, data: {
      name: "science-research-team-plus-signoff", description: "Use for combined scientific literature and data research with final delivery audit. Extends the built-in science-research-team.",
      instructions: extension(specialist!), metadata: { version: "1.0.0" },
    } });
    expect(skillResponse.ok()).toBe(true); const skillRecord = await skillResponse.json(); skill = skillRecord.id;
    metrics.configuration = { connector, specialist, toolName, skill: skillRecord, builtins: builtins.filter(s => roles.some(r => s.id === `builtin-${r}`)) };
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow", projectName: `TC-E2E-01 ${Date.now()}`, sessionTitle: "BRCA1 team signoff",
      ...(modelId ? { modelId } : { model: { apiToken: real!.E2E_LLM_TOKEN!, baseUrl: real!.E2E_LLM_BASE_URL!, model: real!.E2E_LLM_MODEL!, name: "TC-E2E-01 generator" } }) });
    const prefix = `/api/sessions/${fixture.session.id}`;
    const selection = await page.request.patch(`${apiBaseUrl()}${prefix}`, { headers, data: { enabledSkillIds: [skill, "science-research-team"] } });
    expect(selection.ok()).toBe(true);
    await openProjectSession(page, fixture);
    const started = Date.now();
    const runPrompt = process.env.E2E_TEAM_CONCURRENCY_HINT === "2"
      ? `${prompt}\n成本控制：保留全部必需专家角色，但任意时刻最多并发执行2个子agent。复用已有证据，不重复执行已完成且有效的步骤。不要跳过审核或伪造结果。`
      : prompt;
    metrics.prompt = runPrompt;
    const run = await sendUserMessage(page, fixture.session.id, runPrompt); runId = run.id;
    metrics.session_id = fixture.session.id; metrics.run_id = runId;
    await save("team-metrics.json", metrics);
    while (Date.now() - started < budget) {
      const runs = await api<any[]>(`${prefix}/runs`);
      const state = runs.find(r => r.id === runId);
      children = await api<any[]>(`${prefix}/subagents`);
      await save("team-children.json", children); await save("signoff-calls.json", checker.calls);
      if (state && ["completed", "failed", "cancelled"].includes(state.status)) {
        terminal = true; metrics.run = state; break;
      }
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
    metrics.generation_duration_ms = Date.now() - started;
    if (!terminal) {
      await page.request.post(`${apiBaseUrl()}${prefix}/runs/${runId}/cancel`, { headers }).catch(() => undefined);
    }
    const delivery = await collectFinalDelivery(page, fixture.session.id, runId);
    metrics.delivery = delivery;
    metrics.integration = delivery.status;
    await save("team-metrics.json", metrics);
    expect(delivery.status, "Main run must complete and reference a readable nonempty final artifact").toBe("passed");
    try {
      const catalog = await api<any[]>(`${prefix}/artifacts`);
      for (const a of catalog) {
        const versions = await api<any[]>(`${prefix}/artifacts/${a.id}/versions`);
        const latest = versions.sort((a, b) => b.version - a.version)[0];
        if (!latest) continue;
        const content = await page.request.get(`${apiBaseUrl()}${prefix}/artifact-versions/${latest.id}/content`, { headers });
        if (content.ok()) artifacts[a.logicalName] = { text: await content.text(), id: a.id, version: latest.id };
      }
      await save("team-artifacts.json", artifacts);
      // Score a version pinned by the final handoff rather than a newer catalog head.
      for (const a of delivery.artifacts) artifacts[a.logicalName] = { text: a.text, id: a.id, version: a.version };
      await save("team-artifacts.json", artifacts);
      await save("team-children.json", children);
      await save("signoff-calls.json", checker.calls);
      await save("team-metrics.json", metrics);
      metrics.evaluation = await evaluateTeam(dirname(info.outputPath("team-metrics.json")), info.outputPath("evaluation"), judgeBudget);
    } catch (error) {
      metrics.evaluation = { status: "error", total_score: null, gating: false, error: error instanceof Error ? error.message : String(error) };
    }
    metrics.quality = metrics.evaluation.status;
    await info.attach("quality-scorecard", { contentType: "application/json", body: JSON.stringify(metrics.evaluation, null, 2) });

  } finally {
    metrics.finished_at = new Date().toISOString();
    if (fixture) {
      const prefix = `/api/sessions/${fixture.session.id}`;
      if (runId && !terminal) await page.request.post(`${apiBaseUrl()}${prefix}/runs/${runId}/cancel`, { headers }).catch(() => undefined);
      metrics.usage = await api(`${prefix}/usage`).catch(() => null);
      children = await api<any[]>(`${prefix}/subagents`).catch(() => children);
    }
    if (metrics.integration === "running") metrics.integration = "failed";
    await save("team-metrics.json", metrics); await save("team-children.json", children); await save("signoff-calls.json", checker.calls);
    await info.attach("team-metrics", { path: info.outputPath("team-metrics.json"), contentType: "application/json" });
    try { if (fixture && process.env.E2E_KEEP_RESEARCH_RECORDS !== "1") await cleanupJourney(page, fixture); }
    finally {
      if (skill) await page.request.delete(`${apiBaseUrl()}/api/skills/${skill}`, { headers, data: { force: true } }).catch(() => undefined);
      if (specialist) await page.request.delete(`${apiBaseUrl()}/api/specialists/${specialist}`, { headers }).catch(() => undefined);
      if (connector) await page.request.delete(`${apiBaseUrl()}/api/mcp/servers/${connector}`, { headers }).catch(() => undefined);
      await checker.stop();
    }
  }
});

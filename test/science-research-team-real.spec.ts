// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import { test, allowRealEnvException, requireRealEnv, requireRealStack } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { artifactTree, cleanupJourney, createProjectAndSession, openProjectSession, sendUserMessage } from "./helpers/journeys.ts";
import { drbApi, positiveNumber } from "./helpers/deepresearchbench.ts";
import { startDeliverableChecker, checkDeliverable } from "./fixtures/deliverable-check.mjs";

const prompt = "综述 2020—2025 年 BRCA1 致病性或可能致病性胚系变异与女性乳腺癌风险的证据。提取可追溯的风险比或效应量，按指标类型及可比研究条件分组，进行小规模描述性统计，不进行合并效应估计；提供输入数据、可复现代码和结果。输出含 Methods、Results、References 章节的证据简报，并完成团队配置的交付审核。证据不足时明确说明，不得补造数据。";
const roles = ["literature-searcher", "evidence-extractor", "code-engineer", "result-evaluator", "report-writer"];
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const normalize = (s: string) => s.replace(/\r\n/g, "\n");
const strings = (value: any): string[] => typeof value === "string" ? [value]
  : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

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
 *   3. Validate roles, dependent handoffs, bounded revisions, executable analysis, recomputed statistics and exact final-report signoff; check UI persistence.
 * Environment: Opt-in isolated Swarm stack, Python Runner, enabled built-in specialists/skills, live literature access.
 * Type: real
 * LLM: Configured real generator for main and children; no scripted completions.
 * WebSearch: Live configured providers if selected by the Agent.
 * PaperSources: Live built-in literature MCP sources, not fixtures.
 * MCP: Real local HTTP deliverable_check and live literature MCPs.
 * OtherExternal: Real model endpoint and literature sites; local API, Runner and browser.
 * Credentials: E2E_API_TOKEN and E2E_LLM_MODEL_ID or E2E_LLM_BASE_URL/E2E_LLM_MODEL/E2E_LLM_TOKEN.
 * CostSideEffects: Billable LLM calls; isolated temporary project, model, Specialist, skill and MCP server; private traces retained.
 */
test("TC-E2E-01 research team with custom Specialist and MCP signoff", { tag: "@real" }, async ({ page, journey }, info) => {
  const budget = positiveNumber("E2E_TEAM_RUN_TIMEOUT_MS", 3_600_000);
  test.setTimeout(budget + 240_000);
  test.skip(process.env.E2E_SWARM_TASK !== "1", "Requires isolated Swarm platform-task stack");
  await requireRealStack(info);
  const modelId = process.env.E2E_LLM_MODEL_ID;
  if (modelId) allowRealEnvException(info, "Use the existing isolated real model; credentials remain server-side.");
  const real = modelId ? undefined : requireRealEnv(info, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
  const checker = await startDeliverableChecker();
  const headers = authorizationHeader();
  const api = <T = any>(path: string) => drbApi<T>(page, path);
  const save = async (name: string, value: unknown) => writeFile(info.outputPath(name), JSON.stringify(value, null, 2));
  const metrics: any = { case: "TC-E2E-01", prompt, started_at: new Date().toISOString(), integration: "running",
    quality: "not_judged", checks: [], budget_ms: budget };
  const check = (name: string, ok: boolean, detail?: unknown) => { metrics.checks.push({ name, ok, detail }); };
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
      ...(modelId ? { modelId } : { model: { apiToken: real!.E2E_LLM_TOKEN, baseUrl: real!.E2E_LLM_BASE_URL, model: real!.E2E_LLM_MODEL, name: "TC-E2E-01 generator" } }) });
    const prefix = `/api/sessions/${fixture.session.id}`;
    const selection = await page.request.patch(`${apiBaseUrl()}${prefix}`, { headers, data: { enabledSkillIds: [skill, "science-research-team"] } });
    expect(selection.ok()).toBe(true);
    await openProjectSession(page, fixture);
    const started = Date.now();
    const run = await sendUserMessage(page, fixture.session.id, prompt); runId = run.id;
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
    check("run completed", metrics.run?.status === "completed", metrics.run?.error);
    const catalog = await api<any[]>(`${prefix}/artifacts`);
    for (const a of catalog) {
      const versions = await api<any[]>(`${prefix}/artifacts/${a.id}/versions`);
      const latest = versions.sort((a, b) => b.version - a.version)[0];
      if (!latest) continue;
      const content = await page.request.get(`${apiBaseUrl()}${prefix}/artifact-versions/${latest.id}/content`, { headers });
      if (content.ok()) artifacts[a.logicalName] = { text: await content.text(), id: a.id, version: latest.id };
    }
    await save("team-artifacts.json", artifacts);
    const index = await api<any>(`${prefix}/trajectory`);
    await save("team-trajectory-index.json", index);
    const entries = index.entries ?? [];
    const inputs: any[] = [];
    for (const entry of entries.filter((e: any) => e.kind === "input")) {
      inputs.push(await api(`${prefix}/trajectory/detail?id=${encodeURIComponent(entry.id)}`));
    }
    await save("team-model-inputs.json", inputs);
    // Context exports may include sensitive research data: keep local, not PR attachments.
    const mainInputs = inputs.filter(d => !String(d.entry?.agentId).startsWith("subagent:"));
    const mainContext = JSON.stringify(mainInputs);
    check("A0 extension instructions reached model", mainContext.includes("This managed extension adds delivery signoff"));
    check("A0 built-in workflow loaded", mainContext.includes("Workflow: multi-domain team orchestration"));
    check("A0 analysis principles loaded", /analysis-principles|Analysis Principles/.test(mainContext));
    const byRole = (id: string) => children.filter(c => c.specialistId === id);
    for (const id of [...roles.map(r => `builtin-${r}`), specialist!]) check(`A1 completed ${id}`, byRole(id).some(c => c.status === "completed"));
    check("no unfinished child", !children.some(c => ["running", "queued", "pending", "waiting"].includes(c.status)));
    const reviewers = byRole(specialist!);
    check("A2 reviewer connector configuration", JSON.stringify((await api<any[]>("/api/specialists")).find(s => s.id === specialist)?.connectorIds) === JSON.stringify([connector]));
    check("A2 reviewer actually invoked MCP", reviewers.some(c => c.steps.some((s: any) => s.toolName === toolName && s.status === "completed")));
    const reviewerInputs = inputs.filter(d => reviewers.some(c => d.entry?.agentId === `subagent:${c.id}`));
    const toolNames = reviewerInputs.flatMap(d => (d.context?.input?.tools ?? d.value?.input?.tools ?? []).map((t: any) => t.name ?? t.function?.name));
    check("A2 actual reviewer tool exposure", toolNames.includes(toolName) && toolNames.filter((n: string) => n?.startsWith("mcp__")).every((n: string) => n.startsWith(`mcp__${connector}__`)), toolNames);
    const dependency = (down: any, upstream: any[]) => upstream.some(up => up.finishedAt && up.finishedAt <= down.createdAt &&
      (JSON.stringify(down.input).includes(up.id) || up.steps.some((s: any) => s.toolName === "declare_artifact" &&
        Object.values(s.args ?? {}).some(v => typeof v === "string" && v.length > 3 && JSON.stringify(down.input).includes(v)))));
    for (const [upRole, downRole] of [["literature-searcher", "evidence-extractor"], ["code-engineer", "result-evaluator"]])
      for (const down of byRole(`builtin-${downRole}`)) check(`A3 handoff ${down.id}`, dependency(down, byRole(`builtin-${upRole}`)));
    const engineers = byRole("builtin-code-engineer");
    const evaluations = byRole("builtin-result-evaluator");
    check("A3 knowledge feeds data", engineers.length > 0 && engineers.every(c => JSON.stringify(c.input).includes("knowledge_summary") &&
      byRole("builtin-evidence-extractor").some(e => e.finishedAt && e.finishedAt <= c.createdAt)));
    for (const c of byRole("builtin-report-writer")) check(`A3 report summaries ${c.id}`, ["knowledge_summary", "analysis_summary"].every(n => JSON.stringify(c.input).includes(n)) && evaluations.some(e => e.finishedAt && e.finishedAt <= c.createdAt));
    for (const c of reviewers) check(`A3 report before signoff ${c.id}`, dependency(c, byRole("builtin-report-writer")));
    const parse = (name: string) => { try { return JSON.parse(artifacts[name]?.text ?? ""); } catch { return null; } };
    const evaluationFiles = Object.keys(artifacts).filter(n => /^evaluation-.*\.json$/.test(n));
    check("A4 evaluations present", evaluationFiles.length > 0);
    // Current scenario has one analysis assignment; extra parallel branches must be explicit rather than silently sharing a cap.
    check("A4 single analysis loop bounded", evaluations.length >= 1 && evaluations.length <= 3, evaluations.length);
    for (const name of evaluationFiles) {
      const value = parse(name); const decision = value?.decision ?? value?.verdict;
      check(`A5 evaluator decision ${name}`, ["ACCEPT_AND_PROCEED", "REVISE_AND_RETRY", "CONDITIONAL"].includes(decision), decision);
      if (decision === "REVISE_AND_RETRY") {
        const n = Number(name.match(/(\d+)\.json$/)?.[1]);
        if (n < 3) check(`A4 verbatim guidance ${name}`, !!value.revision_guidance && engineers.slice(1).some(c => strings(c.input).some(s => s.includes(typeof value.revision_guidance === "string" ? value.revision_guidance : JSON.stringify(value.revision_guidance)))));
        else check("A4 iteration cap disclosed", artifacts["analysis_summary.md"]?.text.includes("[DATA INCOMPLETE — iteration cap]") ?? false);
      }
    }
    const steps = engineers.flatMap(c => c.steps);
    check("A5 actual code execution", steps.some((s: any) => ["run_shell", "run_python"].includes(s.toolName) && s.status === "completed" &&
      /analysis\.py/.test(JSON.stringify(s.args)) && /exitCode\D+0/.test(JSON.stringify(s.details ?? s.content))));
    check("A5 code artifact", (artifacts["analysis.py"]?.text.length ?? 0) > 50);
    const evidence = parse("evidence.json"), results = parse("analysis_results.json"), sources = parse("literature_sources.json");
    check("A7 structured evidence", Array.isArray(evidence?.observations) && evidence.observations.length >= 2);
    check("A7 structured sources", Array.isArray(sources?.sources) && sources.sources.length > 0);
    const observations = evidence?.observations ?? [];
    check("A7 evidence source traceability", observations.length > 0 && observations.every((o: any) => typeof o.value === "number" && Number.isFinite(o.value) && o.location &&
      sources?.sources?.some((s: any) => s.id === o.source_id && (s.doi || s.pmid || s.url))));
    check("A7 unique observations", new Set(observations.map((o: any) => o.id)).size === observations.length);
    const groups = results?.groups ?? [];
    check("A5 meaningful group", groups.some((g: any) => g.count >= 2));
    for (const g of groups) {
      const selected = observations.filter((o: any) => o.group_key === g.group_key && o.measure === g.measure);
      const values = selected.map((o: any) => o.value);
      const equal = (a: number, b: number) => Number.isFinite(a) && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
      check(`A5 recompute ${g.group_key}/${g.measure}`, values.length > 0 && g.count === values.length &&
        JSON.stringify([...g.observation_ids ?? []].sort()) === JSON.stringify(selected.map((o: any) => o.id).sort()) &&
        equal(g.mean, values.reduce((a: number, b: number) => a + b, 0) / values.length) && equal(g.min, Math.min(...values)) && equal(g.max, Math.max(...values)));
    }
    const report = artifacts["evidence_brief.md"];
    check("A6 report exists", !!report);
    check("A6 required headings", !!report && checkDeliverable(report.text).ok);
    check("A6 exact report audited", !!report && checker.calls.some(c => normalize(c.report_text) === normalize(report.text) && c.result.ok));
    check("A6 source identifiers in report", !!report && (sources?.sources ?? []).some((s: any) => [s.doi, s.pmid, s.url].some(x => x && report.text.includes(x))));
    metrics.report = report ? { id: report.id, version: report.version, sha256: hash(report.text) } : null;
    const tree = await artifactTree(page);
    await expect(tree.catalog.getByRole("button", { name: "Open evidence_brief.md", exact: true })).toBeVisible({ timeout: 15_000 });
    await tree.catalog.getByRole("button", { name: "Open evidence_brief.md", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Artifact: evidence_brief.md" })).toBeVisible();
    await page.reload(); await openProjectSession(page, fixture);
    const answer = await page.locator(".message.assistant").last().innerText();
    check("A6 final handoff names report and audit", answer.includes("evidence_brief.md") && /ok|missing|通过|缺项/i.test(answer));
    const restored = report && await page.request.get(`${apiBaseUrl()}${prefix}/artifact-versions/${report.version}/content`, { headers });
    check("report persists across reload", !!restored && await restored.text() === report!.text);
    metrics.integration = metrics.checks.every((c: any) => c.ok) ? "passed" : "failed";
    expect(metrics.checks.filter((c: any) => !c.ok), "TC-E2E-01 contract violations").toEqual([]);
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

// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";

import { expect, type Page, type TestInfo } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { allowRealEnvException, requireRealEnv, requireRealStack, test } from "./helpers/e2e.ts";
import {
  API_ORIGIN,
  cleanupDesktopFixture,
  createDesktopFixture,
  openDesktopSession,
  seedDesktopOrigin,
  sendMessage,
  startDesktopEntry,
  stopDesktopEntry,
  type DesktopFixture,
} from "./helpers/desktop-evolve.ts";
import {
  cancelActiveSessionRuns,
  RunChainTimeoutError,
  waitForRunChainTerminal,
  type JourneyRun,
} from "./helpers/journeys.ts";
import { realModelApiVariant, realModelThinking } from "./helpers/real-model-thinking.ts";
import { collectFinalDelivery } from "./helpers/real-delivery.ts";
import { deliveryFailureMessage, requiredArtifacts } from "./helpers/real-delivery.mjs";
import { mainRunChain } from "./helpers/run-chain.ts";
import { drbApi, positiveNumber } from "./helpers/deepresearchbench.ts";

const researchQuestion = [
  "Search PubMed and bioRxiv for papers published 2023-2025 comparing gene expression in adult vs pediatric liver parenchymal cells.",
  "Focus on immune-related pathways.",
  "Generate a pathway enrichment bar chart showing gene count comparison between the two populations for the top 14 enriched pathways.",
  "Flag any contradictory findings across studies.",
].join(" ");

const deliveryRequirements = [
  "Delivery requirements for this run:",
  "- Use only the enabled literature MCP tools. You must call the PubMed search tool and the bioRxiv preprint search tool at least once each, and cite only records those searches actually returned.",
  "- The bioRxiv tool searches a trailing window of at most 365 days, not an arbitrary year range. Call it with a broad query and its largest supported window, and if it returns no matching preprints, state that in Methods and cite no bioRxiv preprint instead of inventing one.",
  "- Include only papers published in 2023, 2024 or 2025.",
  "- Declare exactly these three final artifacts through the normal artifact handoff (not transient paths):",
  "  1. literature_review.md — Markdown with ATX headings named exactly Methods, Results, Contradictory findings and References. Methods must name the databases, queries and year range. Results must compare adult and pediatric liver parenchymal cells and the immune-related pathways. Every substantive claim must carry a PMID or DOI citation, and every reference must be a 2023-2025 paper.",
  "  2. pathway_enrichment_counts.csv — the exact table behind the chart. Header: pathway,adult_gene_count,pediatric_gene_count. Exactly 14 data rows for the top 14 enriched pathways. Counts must be non-negative integers derived from the retrieved papers. Use 0 only when a source reports no count for that population, explain any 0 in the review, and never invent a nonzero count. Apply one counting rule to both columns: for each population, count the genes the cited studies report as enriched, differentially expressed or explicitly listed for that pathway in that population. Both columns must contain at least one nonzero count — the chart must compare the two populations, so a column of 14 zeros does not answer the question; keep retrieving from the 2023-2025 adult-comparator studies until the table stands for both populations.",
  "  3. pathway_enrichment_bar_chart.png — a grouped bar chart of the same 14 pathways with one bar per population, a legend naming adult and pediatric, and axis labels \"Pathway\" and \"Gene count\". If PNG rendering is impossible, declare pathway_enrichment_bar_chart.svg instead.",
  "- Under \"Contradictory findings\", compare the studies explicitly and name each contradiction (pathway, direction and studies). If none are found, state \"No contradictory findings were identified\" and explain which comparisons support that conclusion.",
  "- Name the three artifacts exactly and mention them in the final answer. Do not claim an artifact or a finding you did not actually produce.",
].join("\n");

const prompt = `${researchQuestion}\n\n${deliveryRequirements}`;

const literatureSourceIds = ["arxiv", "biorxiv", "europe-pmc", "medrxiv", "pubmed"] as const;
const requiredSourceIds = ["pubmed", "biorxiv"] as const;
const reviewName = "literature_review.md";
const countsName = "pathway_enrichment_counts.csv";
const chartNamePattern = /(^|\/)pathway_enrichment_bar_chart\.(png|svg)$/i;

interface Specialist {
  builtIn?: boolean;
  enabled?: boolean;
  id: string;
  name: string;
}

interface McpSource {
  manifest: { displayName: string; id: string; kinds: string[] };
  status: { availableTools: string[]; status: string };
}

interface McpInvocation {
  errorCode?: string;
  resultCount: number;
  sourceId: string;
  status: "cancelled" | "failed" | "succeeded";
  toolId: string;
}

interface SessionSettings {
  effective: {
    enabledConnectorIds: string[];
    enabledSkillIds: string[];
    enabledSkillLibraries: unknown[];
    skillSelectionMode: string;
  };
}

interface SessionDetail {
  reviewerAutomaticReviewEnabled: boolean;
  specialistId?: string;
}

async function requestJson<T>(
  page: Pick<Page, "request">,
  path: string,
  method: "GET" | "PATCH" | "POST" | "PUT" = "GET",
  data?: unknown,
): Promise<T> {
  const response = await page.request.fetch(`${apiBaseUrl()}${path}`, {
    ...(data === undefined ? {} : { data }),
    headers: authorizationHeader(),
    method,
  });
  if (!response.ok()) {
    throw new Error(`${method} ${path} -> ${response.status()}: ${await response.text()}`);
  }
  return await response.json() as T;
}

/** A small CSV reader that keeps quoted pathway names intact. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === "\"") {
        if (text[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === "\"") {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function headingName(raw: string): string {
  return raw
    .replace(/\s+#*\s*$/u, "")
    .replace(/^\d+(?:\.\d+)*[.)]?\s+/u, "")
    .trim()
    .toLocaleLowerCase();
}

function sectionText(markdown: string, name: string): string | undefined {
  // A section runs until the next heading of the same or a higher level, so
  // sub-headings inside Results or Methods stay part of their section.
  const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/gmu)];
  const index = headings.findIndex((heading) => headingName(heading[2]!) === name);
  if (index < 0) return undefined;
  const level = headings[index]![1]!.length;
  const start = headings[index]!.index! + headings[index]![0].length;
  const next = headings.slice(index + 1).find((heading) => heading[1]!.length <= level);
  return markdown.slice(start, next?.index ?? markdown.length).trim();
}

function citationSummary(text: string): { biorxivDois: number; dois: number; pmids: number; total: number } {
  const pmids = new Set<string>();
  for (const match of text.matchAll(/\bPMID[:\s]*(\d{6,9})\b/giu)) pmids.add(match[1]!);
  for (const match of text.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{6,9})/giu)) pmids.add(match[1]!);
  const dois = new Set<string>();
  for (const match of text.matchAll(/\b10\.\d{4,9}\/[^\s)\]"'<>]+/gu)) {
    dois.add(match[0].replace(/[.,;]+$/u, ""));
  }
  return {
    biorxivDois: [...dois].filter((doi) => doi.toLocaleLowerCase().startsWith("10.1101/")).length,
    dois: dois.size,
    pmids: pmids.size,
    total: new Set([...pmids, ...dois]).size,
  };
}

async function artifactBytes(page: Page, sessionId: string, versionId: string): Promise<Buffer> {
  const response = await page.request.get(
    `${apiBaseUrl()}/api/sessions/${encodeURIComponent(sessionId)}/artifact-versions/${encodeURIComponent(versionId)}/content`,
    { headers: authorizationHeader() },
  );
  if (!response.ok()) throw new Error(`Artifact content HTTP ${response.status()}`);
  return await response.body();
}

function sourceStatusText(sources: McpSource[]): Array<{ id: string; status: string }> {
  return sources.map((source) => ({ id: source.manifest.id, status: source.status.status }));
}

let desktop: ChildProcess | undefined;

test.beforeAll(async () => {
  desktop = await startDesktopEntry();
});

test.afterAll(async () => {
  await stopDesktopEntry(desktop);
});

/**
 * E2E-META
 * Purpose: A real literature review run must answer an adult-versus-pediatric liver immune-pathway question from live
 *   PubMed and bioRxiv evidence, then hand off a 14-pathway count table, a grouped bar chart, and a report that flags
 *   contradictions. The run is driven through the desktop entry, which is the new front end, with every skill and
 *   every specialist switched off.
 * Steps:
 *   1. Disable every built-in specialist and detach the Session's specialist and Reviewer, then set the Session to an
 *      empty skill whitelist and enable every literature MCP source.
 *   2. Open the Session in the desktop entry and submit the fixed research question with machine-checkable delivery
 *      instructions, then wait for the main Run chain.
 *   3. Assert a successful PubMed MCP search with records and a successful bioRxiv preprint search, a readable
 *      14-row CSV, a PNG or SVG bar chart, and a report with Methods, Results, Contradictory findings and
 *      References plus at least four distinct citations. bioRxiv only searches a trailing window of up to 365 days,
 *      so the review may report no matching preprints as long as Methods names both databases.
 * Environment: Opt-in isolated real E2E stack at E2E_BASE_URL with a Runner scientific environment (Python and
 *   matplotlib) and live literature MCP sources, plus the desktop Vite entry on 4178 proxied to that stack.
 * Type: real
 * LLM: Live generator through E2E_LLM_MODEL_ID or E2E_LLM_BASE_URL/E2E_LLM_MODEL/E2E_LLM_TOKEN. No judge model.
 * WebSearch: None. The Session's connector set contains only literature MCP sources; the Web connector is off.
 * PaperSources: Live arXiv, bioRxiv, Europe PMC, medRxiv and PubMed metadata/abstracts through their MCP tools.
 *   PubMed and bioRxiv must be ready; their records, rate limits and coverage vary.
 * MCP: All installed MCP sources whose manifest kind is "literature", exposed through the product's MCP flow.
 * OtherExternal: Local ScienceDiscovery API, Runner code execution and matplotlib rendering, the desktop entry and
 *   Artifact store.
 * Credentials: E2E_API_TOKEN; E2E_LLM_MODEL_ID or E2E_LLM_BASE_URL/E2E_LLM_MODEL/E2E_LLM_TOKEN.
 * CostSideEffects: Billable generation tokens, live literature API traffic, a temporary Project/Session/model, and
 *   local Artifact evidence. The Project and model are deleted and built-in specialist toggles are restored in finally.
 */
test("desktop literature review: adult vs pediatric liver immune pathways with a 14-pathway chart", {
  tag: ["@real", "@category:e2e", "@os:linux", "@arch:amd64", "@model:real", "@tier:l4", "@sandbox:bubblewrap"],
}, async ({ journey, page }, info: TestInfo) => {
  const runBudget = positiveNumber("E2E_LIT_REVIEW_RUN_TIMEOUT_MS", 3_600_000);
  test.setTimeout(runBudget + 300_000);

  // Gate credentials and the stack before the first outbound or API action.
  const existingModelId = process.env.E2E_LLM_MODEL_ID?.trim();
  if (existingModelId) {
    allowRealEnvException(info, "Explicit live model already registered on the isolated stack; credentials stay server-side.");
  }
  if (!existingModelId) requireRealEnv(info, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
  // Same origin the helper talks to: a health probe against a different port
  // would gate on one stack and then drive another.
  await requireRealStack(info, API_ORIGIN);
  // The desktop app reads its token from localStorage, not from the shared
  // storage state, so it has to be seeded before the first navigation.
  await seedDesktopOrigin(page);

  const startedAt = new Date().toISOString();
  const metrics: Record<string, any> = {
    schema_version: 1,
    case: "desktop-literature-immune-liver-real",
    entry: "desktop",
    question: researchQuestion,
    prompt,
    started_at: startedAt,
    run_budget_ms: runBudget,
    configuration: {
      literature_sources: [] as Array<{ id: string; status: string }>,
      required_sources: [...requiredSourceIds],
      disabled_specialists: [] as string[],
      session_specialist: null as string | null,
      session_reviewer_automatic: false,
      skill_selection_mode: "selected",
      enabled_skill_ids: [] as string[],
      enabled_skill_libraries: [] as unknown[],
      enabled_connector_ids: [] as string[],
    },
    run_chain: [] as Array<Record<string, unknown>>,
    invocations: [] as Array<Record<string, unknown>>,
    delivery: null as unknown,
    csv: null as unknown,
    chart: null as unknown,
    report: null as unknown,
    integration_status: "running",
  };

  let fixture: DesktopFixture | undefined;
  let runId: string | undefined;
  let initialRunId: string | undefined;
  let terminal = false;
  let budgetExceeded = false;
  let configuredLitSources: string[] = [];
  let originallyEnabledSpecialists: string[] = [];
  let finalDelivery: Awaited<ReturnType<typeof collectFinalDelivery>> | undefined;
  // A cleanup failure must be reported on its own, never in place of the
  // assertion or run error that actually made the case fail.
  let primaryError: unknown;

  journey.scenario({
    goal: "Run the fixed adult-versus-pediatric liver immune-pathway literature review from the desktop entry with every "
      + "skill and specialist off, and verify that live PubMed/bioRxiv evidence reaches a 14-pathway CSV, a bar chart and "
      + "a contradiction-aware report.",
    preconditions: [
      "Opt-in isolated real stack with a registered live model",
      "Desktop Vite entry on 4178 proxied to that stack",
      "PubMed and bioRxiv MCP sources ready",
      "All built-in specialists and every skill disabled",
    ],
  });

  try {
    await journey.step(
      "Turn skills, specialists and the Reviewer off, and enable every literature MCP source",
      "The Session has no skill whitelist entries, no attached specialist, automatic review off, and only literature "
        + "MCP connectors enabled; PubMed and bioRxiv are ready.",
      async () => {
        let sources = await requestJson<McpSource[]>(page, "/api/mcp/sources");
        let literature = sources.filter((source) => (source.manifest.kinds ?? []).includes("literature"));
        const missing = requiredSourceIds.filter((id) => !literature.some((source) => source.manifest.id === id));
        expect(missing, `Literature MCP sources are not installed: ${missing.join(", ")}`).toEqual([]);

        const notReady = () => requiredSourceIds.filter((id) =>
          literature.find((source) => source.manifest.id === id)?.status.status !== "ready");
        if (notReady().length) {
          await requestJson(page, "/api/mcp/sources/reload", "POST", {});
          sources = await requestJson<McpSource[]>(page, "/api/mcp/sources");
          literature = sources.filter((source) => (source.manifest.kinds ?? []).includes("literature"));
        }
        const unavailable = notReady();
        if (unavailable.length) {
          info.skip(true, `BLOCKED: literature MCP source(s) not ready: ${unavailable.join(", ")}`);
          return;
        }

        const literatureIds = literature.map((source) => source.manifest.id);
        expect(literatureIds).toEqual(expect.arrayContaining([...literatureSourceIds]));
        configuredLitSources = literatureIds;
        metrics.configuration.literature_sources = sourceStatusText(literature);

        const specialists = await requestJson<Specialist[]>(page, "/api/specialists");
        const custom = specialists.filter((specialist) => !specialist.builtIn);
        if (custom.length) {
          info.skip(true, `BLOCKED: custom specialists cannot be switched off for this prerequisite: ${custom.map((s) => s.id).join(", ")}`);
          return;
        }
        originallyEnabledSpecialists = specialists
          .filter((specialist) => specialist.builtIn && specialist.enabled !== false)
          .map((specialist) => specialist.id);
        metrics.configuration.disabled_specialists = originallyEnabledSpecialists;
        for (const specialistId of originallyEnabledSpecialists) {
          await requestJson(page, `/api/specialists/${encodeURIComponent(specialistId)}`, "PUT", { enabled: false });
        }

        const remaining = await requestJson<Specialist[]>(page, "/api/specialists");
        expect(remaining.filter((specialist) => specialist.enabled !== false), "Every specialist must be off").toEqual([]);

        const thinking = realModelThinking();
        fixture = await createDesktopFixture(page, {
          name: "Literature immune liver",
          // A pre-registered model is reused as it is; otherwise the desktop
          // entry reaches the same endpoint the web journeys use, so the owned
          // profile carries the same wire variant and thinking policy.
          ...(existingModelId
            ? { modelId: existingModelId }
            : { model: { apiVariant: realModelApiVariant(), ...thinking } }),
          session: thinking,
        });
        metrics.session_id = fixture.session.id;
        metrics.generator_model_id = fixture.model?.id ?? existingModelId ?? null;

        const prefix = `/api/sessions/${encodeURIComponent(fixture.session.id)}`;
        const configured = await requestJson<{ enabledConnectorIds: string[]; enabledSkillIds: string[] }>(
          page, prefix, "PATCH", {
            enabledConnectorIds: literatureIds,
            enabledSkillIds: [],
            enabledSkillLibraries: [],
            semanticReviewEnabled: false,
            skillSelectionMode: "selected",
            specialistId: null,
          });
        expect(new Set(configured.enabledConnectorIds)).toEqual(new Set(literatureIds));
        expect(configured.enabledSkillIds).toEqual([]);

        const reviewer = await requestJson<{ level: string }>(
          page, `${prefix}/reviewer-specialist/settings`);
        await requestJson(page, `${prefix}/reviewer-specialist/settings`, "PUT", {
          automaticReviewEnabled: false,
          level: reviewer.level,
        });

        const settings = await requestJson<SessionSettings>(page, `${prefix}/settings`);
        expect(settings.effective.skillSelectionMode).toBe("selected");
        expect(settings.effective.enabledSkillIds).toEqual([]);
        expect(settings.effective.enabledSkillLibraries ?? []).toEqual([]);
        expect(new Set(settings.effective.enabledConnectorIds)).toEqual(new Set(literatureIds));
        const detail = await requestJson<SessionDetail>(page, prefix);
        expect(detail.specialistId, "The Session must not attach a specialist").toBeUndefined();
        expect(detail.reviewerAutomaticReviewEnabled).toBe(false);

        metrics.configuration.session_specialist = detail.specialistId ?? null;
        metrics.configuration.session_reviewer_automatic = detail.reviewerAutomaticReviewEnabled;
        metrics.configuration.enabled_skill_ids = settings.effective.enabledSkillIds;
        metrics.configuration.enabled_skill_libraries = settings.effective.enabledSkillLibraries;
        metrics.configuration.enabled_connector_ids = settings.effective.enabledConnectorIds;
      });

    // A skipped readiness gate unwinds through the finally block below; an
    // empty connector list cannot satisfy the run.
    if (!configuredLitSources.length || !fixture) return;

    await journey.step(
      "Ask the fixed liver immune-pathway question from the desktop composer and wait for the main Run chain",
      "The desktop entry opens the Session, the live model runs the prompt with literature-only MCP tools from the "
        + "composer, and the main-Run chain reaches a terminal state.",
      async () => {
        await openDesktopSession(page, fixture!);
        const run = await sendMessage(page, fixture!.session.id, prompt);
        runId = run.id;
        initialRunId = run.id;
        metrics.initial_run_id = run.id;
        metrics.run_id = run.id;

        try {
          const finished = await waitForRunChainTerminal(page, fixture!.session.id, run.id, { timeout: runBudget });
          terminal = true;
          runId = finished.run.id;
          metrics.run_id = runId;
          metrics.run_status = finished.run.status;
          metrics.run_error = finished.run.error ?? null;
          metrics.run_chain = finished.runs.map(({ automaticWake, error, id, queueOrder, status }) => ({
            automatic_wake: Boolean(automaticWake), error, id, queue_order: queueOrder, status,
          }));
        } catch (error) {
          if (!(error instanceof RunChainTimeoutError)) throw error;
          budgetExceeded = true;
          metrics.run_status = "budget_exhausted";
          metrics.run_error = error.message;
          const stopped = await cancelActiveSessionRuns(page, fixture!.session.id);
          metrics.shutdown = { ...stopped, runs: undefined };
          terminal = stopped.status === "stopped";
          const chain = mainRunChain(stopped.runs ?? [], run.id);
          const latest = chain.at(-1) as JourneyRun | undefined;
          runId = latest?.id ?? run.id;
          metrics.run_id = runId;
          metrics.run_chain = chain.map(({ automaticWake, error: runError, id, queueOrder, status }) => ({
            automatic_wake: Boolean(automaticWake), error: runError, id, queue_order: queueOrder, status,
          }));
        }

        if (!runId) throw new Error("The run chain produced no final Run");
        const result = await collectFinalDelivery(page, fixture!.session.id, runId, run.id, [
          reviewName, countsName, "pathway_enrichment_bar_chart.png", "pathway_enrichment_bar_chart.svg",
        ]);
        finalDelivery = result;
        metrics.delivery = {
          artifacts: result.artifacts.map(({ bytes, id, logicalName, version }) => ({ bytes, id, logicalName, version })),
          errors: result.errors,
          run_error: result.run_error,
          run_status: result.run_status,
          status: result.status,
        };
      });

    await journey.step(
      "Verify live PubMed and bioRxiv searches and the 14-pathway delivery",
      "PubMed returned records and the bioRxiv preprint search ran successfully; the CSV has 14 unique pathways with "
        + "two integer count columns that each hold a nonzero count; the declared chart is a real PNG or SVG; and the "
        + "review has all four sections, names both databases in Methods and cites at least four distinct papers.",
      async () => {
        expect(budgetExceeded, `The run exceeded its ${runBudget}ms budget`).toBe(false);
        if (!finalDelivery) throw new Error("The run produced no delivery to verify");

        const invocations = await drbApi<McpInvocation[]>(page,
          `/api/sessions/${encodeURIComponent(fixture!.session.id)}/mcp/invocations`);
        metrics.invocations = invocations.map(({ errorCode, resultCount, sourceId, status, toolId }) => ({
          error_code: errorCode, result_count: resultCount, source: sourceId, status, tool: toolId,
        }));
        const succeeded = invocations.filter((invocation) => invocation.status === "succeeded");
        const sourceInvocations = (sourceId: string) => succeeded.filter((invocation) => invocation.sourceId === sourceId);
        const recordsFor = (sourceId: string) => sourceInvocations(sourceId)
          .reduce((total, invocation) => total + (invocation.resultCount ?? 0), 0);
        const biorxivRecords = recordsFor("biorxiv");
        metrics.searches = {
          biorxiv: { invocations: sourceInvocations("biorxiv").length, records: biorxivRecords },
          pubmed: { invocations: sourceInvocations("pubmed").length, records: recordsFor("pubmed") },
        };

        const required = requiredArtifacts(finalDelivery.artifacts, [reviewName, countsName]);
        const chart = finalDelivery.artifacts.find((artifact) => chartNamePattern.test(artifact.logicalName));

        // Preserve whatever was delivered before judging it, so a partial or
        // failed handoff still leaves the real files in the test report.
        const countsArtifact = required.found.get(countsName);
        const reportArtifact = required.found.get(reviewName);
        const chartBytes = chart ? await artifactBytes(page, fixture!.session.id, chart.version) : undefined;
        if (chart && chartBytes) {
          const chartFileName = chart.logicalName.split("/").at(-1)!;
          const chartPath = info.outputPath(chartFileName);
          await writeFile(chartPath, chartBytes);
          await info.attach("pathway-enrichment-chart", {
            path: chartPath,
            contentType: /\.svg$/iu.test(chart.logicalName) ? "image/svg+xml" : "image/png",
          });
        }
        if (countsArtifact) {
          await writeFile(info.outputPath(countsName), countsArtifact.text);
          await info.attach("pathway-enrichment-counts", { path: info.outputPath(countsName), contentType: "text/csv" });
        }
        if (reportArtifact) {
          await writeFile(info.outputPath(reviewName), reportArtifact.text);
          await info.attach("literature-review", { path: info.outputPath(reviewName), contentType: "text/markdown" });
        }

        expect(recordsFor("pubmed"), "The pubmed MCP search returned no records").toBeGreaterThan(0);
        // bioRxiv's preprint search only accepts a trailing window of days <= 365,
        // so a question pinned to 2023-2025 can legitimately return nothing. The
        // search must have run; the review is judged on how it reports the result.
        expect(metrics.searches.biorxiv.invocations, "The bioRxiv preprint MCP search was never invoked successfully")
          .toBeGreaterThan(0);

        if (required.missing.length || !chart) {
          finalDelivery.status = "failed";
          finalDelivery.errors.push(
            `Missing required artifacts: ${[
              ...required.missing,
              ...(!chart ? ["pathway_enrichment_bar_chart.png|.svg"] : []),
            ].join(", ")}`,
          );
        }
        metrics.integration_status = budgetExceeded ? "timed_out" : finalDelivery.status;
        expect(finalDelivery.status, deliveryFailureMessage(finalDelivery)).toBe("passed");
        expect(required.missing, "The final handoff must declare the review and the count table").toEqual([]);
        if (!chart || !chartBytes) throw new Error("The final handoff must declare the pathway enrichment bar chart");

        // The status assertion above already fails when either named file is
        // absent; from here both are present and readable.
        const counts = countsArtifact!;
        const report = reportArtifact!.text;
        const rows = parseCsv(counts.text);
        const header = (rows[0] ?? []).map((cell) => cell.replace(/^﻿/u, "").trim().toLocaleLowerCase());
        expect(header, "The count table header must be exactly pathway,adult_gene_count,pediatric_gene_count")
          .toEqual(["pathway", "adult_gene_count", "pediatric_gene_count"]);
        const data = rows.slice(1);
        expect(data.length, "Exactly 14 pathway rows are required").toBe(14);
        const pathways = new Set<string>();
        let adultNonzero = 0;
        let pediatricNonzero = 0;
        for (const [index, row] of data.entries()) {
          expect(row.length, `CSV row ${index + 2} must have three columns`).toBe(3);
          const pathway = row[0]!.trim();
          expect(pathway, `CSV row ${index + 2} must name a pathway`).not.toBe("");
          expect(pathways.has(pathway.toLocaleLowerCase()), `Duplicate pathway: ${pathway}`).toBe(false);
          pathways.add(pathway.toLocaleLowerCase());
          for (const [column, value] of [[1, row[1]!], [2, row[2]!]] as const) {
            expect(value.trim(), `CSV row ${index + 2} column ${column + 1} must be an integer`).toMatch(/^\d+$/u);
          }
          if (Number(row[1]) > 0) adultNonzero += 1;
          if (Number(row[2]) > 0) pediatricNonzero += 1;
        }
        expect(adultNonzero, "The adult series must contain at least one reported gene count").toBeGreaterThan(0);
        expect(pediatricNonzero, "The pediatric series must contain at least one reported gene count").toBeGreaterThan(0);
        metrics.csv = { rows: data.length, pathways: [...pathways], adult_nonzero: adultNonzero, pediatric_nonzero: pediatricNonzero };

        if (/\.png$/iu.test(chart.logicalName)) {
          expect(chartBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
            "The PNG artifact must start with the PNG signature").toBe(true);
          expect(chartBytes.length, "The chart PNG is implausibly small").toBeGreaterThan(5_000);
        } else {
          const svg = chartBytes.toString("utf8");
          expect(svg).toMatch(/<svg[\s>]/iu);
          expect(svg.toLocaleLowerCase()).toContain("adult");
          expect(svg.toLocaleLowerCase()).toMatch(/p(?:a)?ediatric/u);
        }
        metrics.chart = { name: chart.logicalName, bytes: chartBytes.length, version: chart.version };

        const methods = sectionText(report, "methods");
        const results = sectionText(report, "results");
        const contradictions = sectionText(report, "contradictory findings");
        const references = sectionText(report, "references");
        expect(methods, "The review must have a Methods heading").toBeDefined();
        expect(results, "The review must have a Results heading").toBeDefined();
        expect(contradictions, "The review must have a Contradictory findings heading").toBeDefined();
        expect(references, "The review must have a References heading").toBeDefined();
        expect(methods!.length, "Methods must describe how the evidence was gathered").toBeGreaterThan(80);
        // Naming both databases in Methods is what proves bioRxiv was actually
        // considered, whether its window returned records or not.
        expect(methods!.toLocaleLowerCase(), "Methods must name the PubMed search").toContain("pubmed");
        expect(methods!.toLocaleLowerCase(), "Methods must name the bioRxiv search").toContain("biorxiv");
        expect(results!.length, "Results must report the comparison").toBeGreaterThan(120);
        expect(contradictions!.length, "Contradictory findings must contain an explicit finding").toBeGreaterThan(40);
        expect(references!.length, "References must not be empty").toBeGreaterThan(40);
        expect(report).toMatch(/\b2023\b/u);
        expect(report).toMatch(/\b2025\b/u);
        expect(report.toLocaleLowerCase()).toMatch(/adult/u);
        expect(report.toLocaleLowerCase()).toMatch(/p(?:a)?ediatric/u);
        expect(report.toLocaleLowerCase()).toMatch(/immune/u);
        const citations = citationSummary(report);
        expect(citations.total, "The review must cite at least four distinct papers by PMID or DOI").toBeGreaterThanOrEqual(4);
        metrics.report = { citations, has_contradiction_section: true, references_chars: references!.length };
      });
  } catch (error) {
    primaryError = error;
    const message = error instanceof Error ? error.message : String(error);
    metrics.error = message;
    // A missing precondition is a blocked case, not a broken product.
    if (message.includes("BLOCKED:")) {
      metrics.integration_status = "blocked";
    } else if (!["passed", "partial"].includes(metrics.integration_status)) {
      metrics.integration_status = "failed";
    }
    throw error;
  } finally {
    if (fixture) {
      if (runId && !terminal) {
        metrics.shutdown = { ...await cancelActiveSessionRuns(page, fixture.session.id).catch(() => ({ status: "error" })), runs: undefined };
        if (metrics.shutdown.status !== "stopped") metrics.cleanup_error = `Session cleanup ${metrics.shutdown.status}`;
      }
      metrics.generation_usage = await drbApi(page, `/api/sessions/${encodeURIComponent(fixture.session.id)}/usage`)
        .catch(() => null);
    }
    // Restore the built-in specialist toggles even when the run or an
    // assertion failed, so the shared catalog is left as it was found.
    for (const specialistId of originallyEnabledSpecialists) {
      await requestJson(page, `/api/specialists/${encodeURIComponent(specialistId)}`, "PUT", { enabled: true })
        .catch((error) => { metrics.specialist_restore_error = String(error); });
    }
    metrics.finished_at = new Date().toISOString();
    const path = info.outputPath("literature-immune-liver-metrics.json");
    await writeFile(path, JSON.stringify(metrics, null, 2));
    await info.attach("literature-immune-liver-metrics", { path, contentType: "application/json" });
    if (fixture && process.env.E2E_KEEP_RESEARCH_RECORDS !== "1") {
      await cleanupDesktopFixture(fixture).catch((error) => { metrics.cleanup_error = String(error); });
    }
    if (metrics.cleanup_error && !primaryError) throw new Error(metrics.cleanup_error);
  }
});

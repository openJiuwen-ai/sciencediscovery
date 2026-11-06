// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exactSum, sessionUsageTokens } from '../test/helpers/case-measurements.mjs';
import { realShards } from '../test/support/tagged/execution.mjs';
import { validatePlan } from '../test/support/tagged/plan.mjs';

export const columns = [
  ['order', '#'], ['case', 'case'], ['status', 'status'], ['score', 'score'],
  ['peak_memory_gb', 'peak memory GB'], ['generated_tokens', 'generated tokens'],
  ['judge_tokens', 'judge tokens'], ['total_tokens', 'total tokens'],
  ['tool_calls', 'tool calls'], ['duration_min', 'duration min'],
].map(([key, label]) => ({ key, label }));
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const number = value => finite(value) !== undefined && value >= 0 ? value : undefined;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const first = (...values) => values.find(value => value !== undefined);

// Retain numbers only, never usage ledgers, provider payloads or judge text.
// The generator's output is distinct from its input+output token total.
export function executionMeasurements(doc) {
  const m = doc.measurements, stored = doc.execution_metrics;
  const usage = doc.generation_usage ?? doc.usage;
  // A Session usage summary is read call by call: its bucket totals skip
  // unreported calls, which would publish a partial sum.
  const session = Array.isArray(usage?.invocations) ? sessionUsageTokens(usage) : undefined;
  const generator = session ? undefined : usage?.totals ?? usage;
  const judge = doc.judge_usage?.totals ?? doc.judge_usage;
  // Every recorded judge call must report its total, or there is no total.
  const calls = doc.evaluation?.judge_calls;
  const judgeCalls = Array.isArray(calls) ? exactSum(calls.map(call => call?.usage?.total_tokens)) : undefined;
  const values = {
    generated_tokens: first(count(stored?.generated_tokens), count(m?.generation_output_tokens), session?.generation_output_tokens, count(generator?.outputTokens), count(generator?.completion_tokens)),
    judge_tokens: first(count(stored?.judge_tokens), count(m?.judge_tokens), count(judge?.totalTokens), count(judge?.total_tokens), judgeCalls),
    total_tokens: first(count(stored?.total_tokens), count(m?.total_tokens), session?.total_tokens, count(generator?.total_tokens), count(generator?.totalTokens)),
    tool_calls: first(count(stored?.tool_calls), count(m?.tool_calls), count(doc.tool_calls)),
    peak_rss_bytes: first(number(stored?.peak_rss_bytes), number(m?.peak_rss_bytes), number(doc.peak_rss_bytes)),
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

export function compactTokens(value) {
  if (count(value) === undefined) return 'n/a';
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}
function caseId(entry) {
  const title = decodeURIComponent(entry.id);
  return title.match(/\bBiomniBench-(da-\d+-\d+)\b/)?.[1]
    ?? title.match(/\b(?:DRB-\d+|TC-E2E-01|PUCT-COMPRESS)\b/)?.[0] ?? entry.id;
}
function matches(doc, entry, id) {
  if (doc.key) return doc.key === entry.key;
  return doc.case === id || String(doc.case_id) === id
    || (entry.source.includes('deepresearchbench') && `DRB-${doc.case_id}` === id);
}
function metricDocuments(root) {
  const docs = [];
  function visit(directory) {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /^(benchmark|team|evolve|case)-metrics\.json$/.test(entry.name)) {
        try {
          const doc = JSON.parse(readFileSync(path, 'utf8'));
          if (doc && typeof doc === 'object' && !Array.isArray(doc)) docs.push(doc);
        } catch { /* Incomplete optional evidence leaves n/a cells. */ }
      }
    }
  }
  visit(root);
  return docs;
}
const outcomeStatus = { PASS: 'passed', FAIL: 'failed', SKIPPED: 'skipped', PROVIDER_FAULT: 'provider_fault' };
const status = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value) ? value : undefined;

export function caseExecutionSummary(plan, root, verdict) {
  if (!['daily', 'release'].includes(plan.profile)) return undefined;
  const results = new Map((verdict.results ?? []).map(result => [result.key, result]));
  const rows = [];
  for (const shard of realShards(plan)) {
    const docs = metricDocuments(join(root, `real-e2e-results-${shard.name}`));
    for (const entry of plan.entries.filter(entry => shard.keys.includes(entry.key))) {
      const id = caseId(entry), candidates = docs.filter(doc => matches(doc, entry, id));
      // Ambiguous evidence cannot supply a measurement for this identity.
      const doc = candidates.length === 1 ? candidates[0] : {};
      const m = executionMeasurements(doc), evaluation = doc.evaluation;
      const score = first(finite(evaluation?.overall_score), finite(evaluation?.total_score), finite(evaluation?.score));
      const duration = number(doc.generation_duration_ms);
      const started = typeof doc.started_at === 'string' ? Date.parse(doc.started_at) : NaN;
      const result = results.get(entry.key);
      rows.push({ started: Number.isFinite(started) ? started : Infinity, row: {
        case: id,
        status: outcomeStatus[result?.outcome] ?? status(doc.integration_status) ?? status(doc.integration) ?? 'not_run',
        score: score === undefined ? 'n/a' : String(score),
        peak_memory_gb: m.peak_rss_bytes === undefined ? 'n/a' : (m.peak_rss_bytes / 1024 ** 3).toFixed(2),
        generated_tokens: compactTokens(m.generated_tokens), judge_tokens: compactTokens(m.judge_tokens),
        total_tokens: compactTokens(m.total_tokens), tool_calls: m.tool_calls === undefined ? 'n/a' : String(m.tool_calls),
        duration_min: duration === undefined ? 'n/a' : (duration / 60000).toFixed(1),
      } });
    }
  }
  rows.sort((a, b) => a.started - b.started || a.row.case.localeCompare(b.row.case));
  const table = { title: 'case execution', columns, rows: rows.map(({ row }, i) => ({ order: String(i + 1), ...row })) };
  // Like tagged summaries, all selected but unverified cases count as failed.
  // These display counts do not change the gate's verdict or retry semantics.
  const tests = plan.entries.length, passed = verdict.passed;
  const selectedKeys = new Set(plan.entries.map(entry => entry.key));
  const skipped = Math.min(tests - passed, [...results.values()].filter(result => selectedKeys.has(result.key) && result.outcome === 'SKIPPED').length);
  return { tests, passed, failed: tests - passed - skipped, skipped, flaky: 0, table };
}

export function renderCaseExecution(table) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replace(/[\r\n]/g, ' ');
  return [`### ${table.title}`, '', `| ${table.columns.map(c => c.label).join(' | ')} |`,
    `| ${table.columns.map(() => '---').join(' | ')} |`,
    ...table.rows.map(row => `| ${table.columns.map(c => escape(row[c.key])).join(' | ')} |`), '', ''].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [planPath, root, output] = process.argv.slice(2);
  const plan = validatePlan(JSON.parse(readFileSync(planPath, 'utf8')));
  if (['daily', 'release'].includes(plan.profile)) {
    const verdict = JSON.parse(readFileSync(join(root, 'verdict.json'), 'utf8'));
    if (verdict.planDigest !== plan.digest) throw new Error('CASE_EXECUTION_PLAN_MISMATCH');
    const summary = caseExecutionSummary(plan, root, verdict);
    const markdown = renderCaseExecution(summary.table);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'dashboard-summary.json'), JSON.stringify(summary, null, 2) + '\n');
    writeFileSync(join(output, 'case-execution-details.md'), markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
}

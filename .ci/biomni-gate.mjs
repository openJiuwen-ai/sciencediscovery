// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical } from '../test/support/tagged/plan.mjs';
import { biomniCase, realShards } from '../test/support/tagged/execution.mjs';
import { MEASUREMENT_VERSION } from '../test/benchmarks/biomnibench-da/metrics.mjs';

const manifestBytes = readFileSync(new URL('../test/benchmarks/biomnibench-da/manifest.json', import.meta.url));
export const dataset = JSON.parse(manifestBytes);
export const manifestHash = createHash('sha256').update(manifestBytes).digest('hex');
const resourceKeys = ['tool_calls', 'tool_rounds', 'peak_rss_bytes', 'e2e_ms', 'generation_tokens', 'judge_tokens', 'total_tokens'];
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const pick = (doc, keys) => Object.fromEntries(keys.filter(k => doc?.[k] !== undefined).map(k => [k, doc[k]]));

export function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function aggregateMetrics(results) {
  if (!results.length) return null;
  const measurements = results.map(r => r.measurements);
  const sum = key => measurements.reduce((s, m) => s + m[key], 0);
  return { mean_score: sum('score') / results.length, min_score: Math.min(...measurements.map(m => m.score)),
    total_tokens: sum('total_tokens'), generation_tokens: sum('generation_tokens'), judge_tokens: sum('judge_tokens'),
    tool_rounds: sum('tool_rounds'), tool_calls: sum('tool_calls'), sum_e2e_ms: sum('e2e_ms'),
    max_peak_rss_bytes: Math.max(...measurements.map(m => m.peak_rss_bytes)),
    p95_peak_rss_gib: percentile(measurements.map(m => m.peak_rss_bytes / 1024 ** 3), 0.95) };
}

export function temporaryVerdict(summary, policy) {
  const warnings = [], problems = [], metrics = [];
  for (const key of ['mean_score', 'total_tokens', 'tool_rounds', 'sum_e2e_ms', 'p95_peak_rss_gib']) {
    const base = policy.temporary_baseline?.[key], rule = policy.thresholds?.[key === 'mean_score' ? 'score_drop' : key];
    if (!positive(base) || !rule || ![rule.warning, rule.block].every(positive) || rule.block <= rule.warning
        || (key === 'p95_peak_rss_gib' && ![rule.warning_min_gib, rule.block_min_gib].every(positive))) {
      problems.push('INVALID_TEMPORARY_BASELINE_POLICY'); continue;
    }
    const memory = key === 'p95_peak_rss_gib';
    const limit = level => key === 'mean_score' ? base - rule[level]
      : base + Math.max(base * rule[level], memory ? rule[`${level}_min_gib`] : 0);
    const warning = limit('warning'), block = limit('block'), actual = summary?.[key];
    const crossed = value => key === 'mean_score' ? actual <= value + 1e-9 : actual >= value - 1e-9;
    const status = actual === undefined ? 'incomplete' : crossed(block) ? 'blocked' : crossed(warning) ? 'warning' : 'passed';
    metrics.push({ metric: key, baseline: base, warning, block, actual: actual ?? null, status });
    if (status === 'blocked') problems.push(`${key.toUpperCase()}_REGRESSION`);
    else if (status === 'warning') warnings.push(`${key.toUpperCase()}_WARNING`);
  }
  return { warnings, problems, metrics };
}

// This is the only Biomni projection published as the score artifact. Never
// copy arbitrary diagnostics, prompts, judge explanations or provider objects.
export function projectMetrics(doc) {
  const out = pick(doc, ['schema_version', 'benchmark', 'case_id', 'key', 'revision', 'integration_status']);
  out.identity = pick(doc.identity, ['dataset_revision', 'manifest_sha256', 'evaluator_revision', 'measurement_version', 'generator_model', 'judge_model', 'backend', 'run_budget_ms', 'workspace_budget_bytes']);
  out.identity.machine = pick(doc.identity?.machine, ['os', 'arch', 'kernel', 'cpu', 'cores', 'memory_bytes', 'node']);
  out.measurements = pick(doc.measurements, ['score', ...resourceKeys, 'memory_samples', 'memory_interval_ms', 'memory_scope', 'judge_ms', 'generation_input_tokens', 'generation_output_tokens', 'judge_input_tokens', 'judge_output_tokens']);
  out.evaluation = pick(doc.evaluation, ['status', 'score', 'gating']);
  if (doc.judge_usage) out.judge_usage = pick(doc.judge_usage, ['complete', 'unknown_attempts', 'reported_attempts', 'scope']);
  return out;
}

export function validateMetrics(doc, entry, plan) {
  if (doc?.judge_usage?.complete === false) throw new Error('UNREPORTED_JUDGE_TOKENS');
  if (doc?.schema_version !== 2 || doc.benchmark !== 'biomnibench-da' || doc.case_id !== biomniCase(entry)
      || doc.key !== entry.key || doc.revision !== plan.revision || doc.integration_status !== 'passed') throw new Error('METRIC_IDENTITY_OR_DELIVERY');
  const id = doc.identity, m = doc.measurements;
  if (id?.dataset_revision !== dataset.revision || id.manifest_sha256 !== manifestHash || id.measurement_version !== MEASUREMENT_VERSION
      || id.evaluator_revision !== plan.evaluatorRevision || id.backend !== plan.execution?.backend
      || !id.generator_model || id.generator_model !== plan.execution?.model || !id.judge_model || id.judge_model !== plan.execution?.judge
      || !positive(id.run_budget_ms) || !positive(id.workspace_budget_bytes) || !positive(id.machine?.memory_bytes) || !positive(id.machine?.cores)
      || id.machine.os !== 'linux' || id.machine.arch !== ({ amd64: 'x64', arm64: 'arm64' }[entry.target.arch]) || !id.machine.cpu || !id.machine.kernel || !id.machine.node) throw new Error('METRIC_CONFIGURATION');
  if (doc.evaluation?.status !== 'scored' || doc.evaluation.gating !== true || typeof m?.score !== 'number' || !Number.isFinite(m.score)
      || m.score < 0 || m.score > 100 || doc.evaluation.score !== m.score) throw new Error('MISSING_VALID_SCORE');
  if (resourceKeys.some(k => !positive(m[k])) || !positive(m.memory_samples) || !positive(m.memory_interval_ms)
      || m.memory_scope !== 'isolated-local-worker-rss-sum' || m.tool_rounds > m.tool_calls
      || m.total_tokens !== m.generation_tokens + m.judge_tokens) throw new Error('MISSING_RESOURCE_METRICS');
  if (!positive(m.judge_ms) || ['generation_input_tokens', 'generation_output_tokens', 'judge_input_tokens', 'judge_output_tokens']
      .some(k => !Number.isSafeInteger(m[k]) || m[k] < 0)) throw new Error('INCOMPLETE_TOKEN_OR_JUDGE_METRICS');
  for (const k of ['tool_calls', 'tool_rounds', 'peak_rss_bytes', 'generation_tokens', 'judge_tokens', 'total_tokens', 'memory_samples']) {
    if (!Number.isSafeInteger(m[k])) throw new Error('INVALID_METRIC_COUNT');
  }
  return projectMetrics(doc);
}

export function evaluateSuite(plan, documents, policy, baseline) {
  const expected = plan.entries.filter(e => biomniCase(e));
  if (!expected.length && !['release', 'l5', 'l5-only'].includes(plan.profile)) return undefined;
  const problems = [], results = [], caseStatuses = [], ids = expected.map(biomniCase);
  if (canonical([...ids].sort()) !== canonical(dataset.tasks.map(t => t.id).sort())) problems.push('BIOMNI_PUBLIC_50_PLAN_REQUIRED');
  if (!['candidate', 'compare', 'temporary'].includes(policy?.mode)) problems.push('INVALID_BASELINE_POLICY');
  if (policy?.mode === 'candidate' && (policy.baseline !== null || baseline)) problems.push('CANDIDATE_MUST_NOT_USE_BASELINE');
  for (const entry of expected) {
    const matches = documents.filter(doc => doc.case_id === biomniCase(entry));
    const state = { case_id: biomniCase(entry), status: 'incomplete', delivery: matches[0]?.integration_status ?? 'missing',
      evaluation: matches[0]?.evaluation?.status ?? 'missing', measurements: matches.length === 1 ? projectMetrics(matches[0]).measurements : {}, reason: null };
    caseStatuses.push(state);
    if (matches.length !== 1) { state.reason = 'MISSING_OR_DUPLICATE_METRICS'; problems.push(`${biomniCase(entry)}: ${state.reason}`); continue; }
    try { results.push(validateMetrics(matches[0], entry, plan)); state.status = 'completed'; }
    catch (error) { state.reason = error.message; problems.push(`${biomniCase(entry)}: ${error.message}`); }
  }
  if (documents.some(doc => !ids.includes(doc.case_id))) problems.push('UNEXPECTED_BIOMNI_METRICS');
  if (policy?.mode === 'compare') {
    if (baseline?.status !== 'approved' || baseline?.benchmark !== 'biomnibench-da' || !baseline?.approved_by || !baseline?.approved_at
        || canonical(baseline.cases?.map(c => c.case_id).sort()) !== canonical([...ids].sort())) problems.push('APPROVED_COMPLETE_BASELINE_REQUIRED');
    if (![policy.score_drop_points, policy.resource_increase_ratio].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) problems.push('INVALID_BASELINE_TOLERANCE');
    if (!problems.length) for (const current of results) {
      const previous = baseline.cases.find(c => c.case_id === current.case_id);
      // Baseline product revision differs; input/evaluator/model/machine/budgets must not.
      try { validateMetrics({ ...previous, key: current.key, revision: plan.revision }, expected.find(e => biomniCase(e) === current.case_id), plan); }
      catch { problems.push(`${current.case_id}: INVALID_BASELINE_METRICS`); continue; }
      if (canonical(current.identity) !== canonical(previous.identity)) { problems.push(`${current.case_id}: INCOMPARABLE_BASELINE`); continue; }
      if (current.measurements.score < previous.measurements.score - policy.score_drop_points) problems.push(`${current.case_id}: SCORE_REGRESSION`);
      for (const key of resourceKeys) if (current.measurements[key] > previous.measurements[key] * (1 + policy.resource_increase_ratio)) problems.push(`${current.case_id}: ${key.toUpperCase()}_REGRESSION`);
    }
  }
  const summary = aggregateMetrics(results);
  const thresholds = policy?.mode === 'temporary' ? temporaryVerdict(results.length === dataset.tasks.length ? summary : null, policy) : { warnings: [], problems: [], metrics: [] };
  problems.push(...thresholds.problems);
  const complete = problems.length === 0;
  return { schema_version: 1, benchmark: 'biomnibench-da', scope: dataset.scope, revision: plan.revision,
    status: complete ? policy.mode === 'candidate' ? 'baseline_candidate' : policy.mode === 'temporary' ? thresholds.warnings.length ? 'temporary_baseline_warning' : 'temporary_baseline_passed' : 'non_regression_passed' : 'failed',
    non_regression_certified: complete && policy.mode === 'compare', expected: dataset.tasks.length, measured: results.length,
    problems, warnings: thresholds.warnings, thresholds: thresholds.metrics, case_statuses: caseStatuses,
    baseline_kind: policy?.mode, cases: results, summary,
    summary_complete: results.length === dataset.tasks.length };
}

export function renderSuite(report) {
  const format = value => Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '—';
  const limits = report.thresholds.map(m => `| ${m.metric} | ${format(m.actual)} | ${format(m.baseline)} | ${format(m.warning)} | ${format(m.block)} | ${m.status} |`).join('\n');
  const rows = report.case_statuses.map(c => {
    const m = c.measurements, value = (key, scale = 1) => Number.isFinite(m[key]) ? (m[key] / scale).toFixed(2) : '—';
    return `| ${c.case_id} | ${c.status} | ${c.delivery} | ${c.evaluation} | ${value('score')} | ${value('total_tokens')} | ${value('peak_rss_bytes', 1024 ** 3)} | ${value('e2e_ms', 60000)} | ${value('tool_calls')} / ${value('tool_rounds')} | ${c.reason ?? ''} |`;
  });
  return `### Biomni public-50: ${report.status}\n\nCompleted metrics: ${report.measured}/${report.expected}. Partial means are diagnostic only. Baseline: ${report.baseline_kind}.\n\n| Metric (time in ms) | Actual | Baseline | Warning | Block | Status |\n|---|---|---|---|---|---|\n${limits}\n\n| Case | Status | Delivery | Evaluation | Score | Tokens | Peak RSS GiB | Research min | Tool calls / rounds | Reason |\n|---|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n${report.warnings.map(w => `- ${w}`).join('\n')}\n`;
}

export function collectSuite(plan, root, policy, baseline) {
  const documents = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name === 'benchmark-metrics.json') {
        const doc = JSON.parse(readFileSync(target, 'utf8'));
        if (doc.benchmark === 'biomnibench-da') documents.push(doc);
      }
    }
  }
  for (const shard of realShards(plan)) {
    if (!plan.entries.some(e => shard.keys.includes(e.key) && biomniCase(e))) continue;
    try { visit(join(root, `real-e2e-results-${shard.name}`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return evaluateSuite(plan, documents, policy, baseline);
}

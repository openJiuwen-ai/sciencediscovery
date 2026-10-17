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
  if (!expected.length && !['release', 'l5'].includes(plan.profile)) return undefined;
  const problems = [], results = [], ids = expected.map(biomniCase);
  if (canonical([...ids].sort()) !== canonical(dataset.tasks.map(t => t.id).sort())) problems.push('BIOMNI_PUBLIC_50_PLAN_REQUIRED');
  if (!['candidate', 'compare'].includes(policy?.mode)) problems.push('INVALID_BASELINE_POLICY');
  if (policy?.mode === 'candidate' && (policy.baseline !== null || baseline)) problems.push('CANDIDATE_MUST_NOT_USE_BASELINE');
  for (const entry of expected) {
    const matches = documents.filter(doc => doc.case_id === biomniCase(entry));
    if (matches.length !== 1) { problems.push(`${biomniCase(entry)}: MISSING_OR_DUPLICATE_METRICS`); continue; }
    try { results.push(validateMetrics(matches[0], entry, plan)); }
    catch (error) { problems.push(`${biomniCase(entry)}: ${error.message}`); }
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
  const complete = problems.length === 0;
  return { schema_version: 1, benchmark: 'biomnibench-da', scope: dataset.scope, revision: plan.revision,
    status: complete ? policy.mode === 'candidate' ? 'baseline_candidate' : 'non_regression_passed' : 'failed',
    non_regression_certified: complete && policy.mode === 'compare', expected: dataset.tasks.length, measured: results.length,
    problems, cases: results, summary: results.length ? {
      mean_score: results.reduce((s, r) => s + r.measurements.score, 0) / results.length,
      min_score: Math.min(...results.map(r => r.measurements.score)),
      total_tokens: results.reduce((s, r) => s + r.measurements.total_tokens, 0),
      sum_e2e_ms: results.reduce((s, r) => s + r.measurements.e2e_ms, 0),
      max_peak_rss_bytes: Math.max(...results.map(r => r.measurements.peak_rss_bytes)),
    } : null };
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

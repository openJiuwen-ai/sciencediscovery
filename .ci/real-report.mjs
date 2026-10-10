// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { globSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, validatePlan, verifyResults } from '../test/support/tagged/plan.mjs';
import { realShards } from '../test/support/tagged/execution.mjs';

const valueAt = (value, path) => path.split('.').reduce((v,k) => v?.[k], value);
export function qualityProblems(plan, rows, baseline) {
  const problems = [];
  if (baseline?.status !== 'calibrated' || !baseline.reference || !baseline.evaluatorRevision) return ['QUALITY_BASELINE_NOT_CALIBRATED'];
  if (baseline.evaluatorRevision !== plan.evaluatorRevision) problems.push('QUALITY_EVALUATOR_MISMATCH');
  if (canonical(baseline.execution) !== canonical(plan.execution)) problems.push('QUALITY_CONFIGURATION_MISMATCH');
  const judged = plan.entries.filter(e => e.tags.includes('judge:llm'));
  if (!judged.length) problems.push('QUALITY_MANIFEST_EMPTY');
  for (const entry of judged) {
    const rules = baseline.cases?.[entry.id];
    const metrics = rows.get(entry.key);
    if (!rules?.length) { problems.push(`QUALITY_BASELINE_MISSING: ${entry.id}`); continue; }
    if (!metrics) { problems.push(`QUALITY_EVIDENCE_MISSING: ${entry.id}`); continue; }
    for (const rule of rules) {
      if (typeof rule?.path !== 'string' || typeof rule.statusPath !== 'string') { problems.push(`QUALITY_RULE_INVALID: ${entry.id}`); continue; }
      const score = valueAt(metrics, rule.path);
      const status = valueAt(metrics, rule.statusPath);
      const valid = [rule.minimum,rule.reference,rule.maxDrop].every(Number.isFinite) && rule.maxDrop >= 0
        && Array.isArray(rule.acceptedStatuses) && rule.acceptedStatuses.length;
      if (!valid || !Number.isFinite(score) || !rule.acceptedStatuses.includes(status)) {
        problems.push(`QUALITY_UNKNOWN: ${entry.id} ${rule.path}`);
      } else if (score < rule.minimum || score < rule.reference - rule.maxDrop) {
        problems.push(`QUALITY_REGRESSION: ${entry.id} ${rule.path}`);
      }
    }
  }
  return problems;
}

export function reconcile(plan, root, baseline) {
  validatePlan(plan);
  const results = [], errors = [], scores = new Map();
  for (const shard of realShards(plan)) {
    const directory = join(root, `real-e2e-results-${shard.name}`);
    try {
      const workerPlan = validatePlan(JSON.parse(readFileSync(join(directory, 'e2e-real/tagged/plan.json'))));
      const summary = JSON.parse(readFileSync(join(directory, 'e2e-real/tagged/summary.json')));
      if (workerPlan.revision !== plan.revision || workerPlan.profile !== plan.profile || workerPlan.evaluatorRevision !== plan.evaluatorRevision || canonical(workerPlan.execution) !== canonical(plan.execution)
        || canonical(workerPlan.entries.map(e=>e.key)) !== canonical(shard.keys)) throw new Error('SHARD_IDENTITY_MISMATCH');
      const verified = verifyResults(workerPlan, summary.results);
      if (summary.status !== 'PASS' || summary.planDigest !== workerPlan.digest || verified.exitCode) throw new Error('SHARD_FAILED');
      results.push(...summary.results);
      if (shard.keys.length === 1) {
        const paths = [...globSync('**/{benchmark,team,evolve}-metrics.json', {cwd:directory})];
        if (paths.length === 1) scores.set(shard.keys[0], JSON.parse(readFileSync(join(directory, paths[0]))));
      }
    } catch (error) { errors.push(`${shard.name}: ${error.code === 'ENOENT' ? 'SHARD_EVIDENCE_MISSING' : error.message}`); }
  }
  if (['release','l5'].includes(plan.profile)) errors.push(...qualityProblems(plan, scores, baseline));
  return verifyResults(plan, results, errors);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [planPath,root,baselinePath] = process.argv.slice(2);
  const plan = JSON.parse(readFileSync(planPath));
  const baseline = JSON.parse(readFileSync(baselinePath));
  const verdict = reconcile(plan, root, baseline);
  writeFileSync(join(root,'verdict.json'), JSON.stringify(verdict,null,2)+'\n');
  // Retain the existing dashboard artifact name and a single suite-level plan.
  // Only score-projected worker artifacts enter this assembly.
  const combined='.ci-results';
  for(const shard of realShards(plan)) {
    const source=join(root,`real-e2e-results-${shard.name}`);
    if(existsSync(source)) cpSync(source,join(combined,shard.name),{recursive:true});
  }
  mkdirSync(join(combined,'e2e-real/tagged'),{recursive:true});
  writeFileSync(join(combined,'e2e-real/tagged/plan.json'),JSON.stringify(plan));
  writeFileSync(join(combined,'e2e-real/tagged/summary.json'),JSON.stringify(verdict));
  const report = `### Real E2E: ${verdict.status}\n\n${plan.profile}, backend=${plan.execution.backend}, revision=${plan.revision}\n\nPlanned ${verdict.planned}; executed ${verdict.executed}; passed ${verdict.passed}.\n\n${verdict.problems.map(p=>`- ${p}`).join('\n')}\n`;
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  process.exitCode = verdict.exitCode;
}

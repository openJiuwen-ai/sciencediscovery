// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, validatePlan, verifyResults } from '../test/support/tagged/plan.mjs';
import { mockedBatches, mockedShards } from '../test/support/tagged/execution.mjs';

export function reconcileMocked(plan, root) {
  validatePlan(plan);
  const results = [], errors = [];
  for (const shard of mockedShards(plan)) {
    const directory = join(root, `mocked-e2e-results-${shard.name}`);
    try {
      const worker = validatePlan(JSON.parse(readFileSync(join(directory, 'e2e/tagged/plan.json'))));
      const summary = JSON.parse(readFileSync(join(directory, 'e2e/tagged/summary.json')));
      if (worker.revision !== plan.revision || worker.profile !== plan.profile || worker.evaluatorRevision !== plan.evaluatorRevision || canonical(worker.execution) !== canonical(plan.execution)
        || canonical(worker.entries) !== canonical(plan.entries.filter(e => shard.keys.includes(e.key)))) throw new Error('SHARD_IDENTITY_MISMATCH');
      if (summary.planDigest !== worker.digest) throw new Error('SHARD_RESULT_PLAN_MISMATCH');
      // Keep validly identified failures in the totals: a failed worker ran
      // its cases, whereas an absent or mismatched artifact proves no run.
      results.push(...summary.results);
      if (summary.status !== 'PASS' || verifyResults(worker, summary.results).exitCode) errors.push(`${shard.name}: SHARD_FAILED`);
      // The checks run in one batch of a shard, and shared.mjs names that
      // batch's results directory by its mockedBatches key — `-global` only
      // where the partition is split. Locate the file through the same
      // projection instead of guessing a per-shard suffix.
      const batches = mockedBatches(plan).filter(batch => batch.shard === shard.name);
      const evidence = batch => join(directory, batch.key, 'e2e/jiuwenswarm-checks.json');
      // A checks file outside the designated batch proves they ran on the
      // wrong stack, or more than once.
      if (batches.some(batch => !batch.checks.length && existsSync(evidence(batch)))) throw new Error('UNEXPECTED_SWARM_CHECKS');
      if (shard.checks.length) {
        const checkBatches = batches.filter(batch => batch.checks.length);
        if (checkBatches.length !== 1) throw new Error('SWARM_CHECKS_BATCH_UNDEFINED');
        const checks = JSON.parse(readFileSync(evidence(checkBatches[0])));
        if (canonical(checks) !== canonical(shard.checks.map(name => ({ name, outcome: 'PASS' })))) throw new Error('SWARM_CHECKS_INCOMPLETE');
      }
    } catch (error) { errors.push(`${shard.name}: ${error.code === 'ENOENT' ? 'SHARD_EVIDENCE_MISSING' : error.message}`); }
  }
  return verifyResults(plan, results, errors);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [planPath, root, combined] = process.argv.slice(2);
  const plan = JSON.parse(readFileSync(planPath));
  const verdict = reconcileMocked(plan, root);
  // Preserve each worker's relative HTML/image links and the dashboard's
  // suite-level artifact. The existing merge gate owns this reconciliation.
  if (combined) {
    for (const shard of mockedShards(plan)) {
      const source = join(root, `mocked-e2e-results-${shard.name}`);
      if (existsSync(source)) cpSync(source, join(combined, shard.name), { recursive: true });
    }
    mkdirSync(join(combined, 'e2e/tagged'), { recursive: true });
    writeFileSync(join(combined, 'e2e/tagged/plan.json'), JSON.stringify(plan));
    writeFileSync(join(combined, 'e2e/tagged/summary.json'), JSON.stringify(verdict));
  }
  const report = `### Mocked E2E: ${verdict.status}\n\nPlanned ${verdict.planned}; executed ${verdict.executed}; passed ${verdict.passed}.\n\n${verdict.problems.map(p => `- ${p}`).join('\n')}\n`;
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  process.exitCode = verdict.exitCode;
}

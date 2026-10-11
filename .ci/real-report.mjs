// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, validatePlan, verifyResults } from '../test/support/tagged/plan.mjs';
import { realShards } from '../test/support/tagged/execution.mjs';

export function reconcile(plan, root) {
  validatePlan(plan);
  const results = [], errors = [];
  for (const shard of realShards(plan)) {
    const directory = join(root, `real-e2e-results-${shard.name}`);
    try {
      const workerPlan = validatePlan(JSON.parse(readFileSync(join(directory, 'e2e-real/tagged/plan.json'))));
      const summary = JSON.parse(readFileSync(join(directory, 'e2e-real/tagged/summary.json')));
      if (workerPlan.revision !== plan.revision || workerPlan.profile !== plan.profile || workerPlan.evaluatorRevision !== plan.evaluatorRevision || canonical(workerPlan.execution) !== canonical(plan.execution)
        || canonical(workerPlan.entries) !== canonical(plan.entries.filter(e=>shard.keys.includes(e.key)))) throw new Error('SHARD_IDENTITY_MISMATCH');
      const verified = verifyResults(workerPlan, summary.results);
      if (summary.status !== 'PASS' || summary.planDigest !== workerPlan.digest || verified.exitCode) throw new Error('SHARD_FAILED');
      results.push(...summary.results);
    } catch (error) { errors.push(`${shard.name}: ${error.code === 'ENOENT' ? 'SHARD_EVIDENCE_MISSING' : error.message}`); }
  }
  return verifyResults(plan, results, errors);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [planPath,root] = process.argv.slice(2);
  const plan = JSON.parse(readFileSync(planPath));
  const verdict = reconcile(plan, root);
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

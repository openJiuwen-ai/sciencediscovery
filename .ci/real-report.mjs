// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, validatePlan, verifyResults } from '../test/support/tagged/plan.mjs';
import { realShards } from '../test/support/tagged/execution.mjs';
import { isProviderFaultProblem, PROVIDER_FAULT } from '../test/support/tagged/provider-fault.mjs';
import { collectSuite, renderSuite } from './biomni-gate.mjs';

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
      if (summary.planDigest !== workerPlan.digest) throw new Error('SHARD_RESULT_PLAN_MISMATCH');
      // A valid failed shard still executed its cases. Retain those results so
      // suite accounting distinguishes FAIL from NOT_RUN while the gate fails.
      results.push(...summary.results);
      // A shard whose cases only faulted at the model gateway is still valid
      // evidence: the identity checks above apply, and its results are folded
      // into the suite's accounting. It does not certify the suite — the
      // suite's own accounting decides the exit code, and a remaining provider
      // fault makes that exit non-zero. Turning it into an opaque shard
      // failure instead would lose the provider-fault problems it carries.
      // A product failure in the same shard still fails the shard.
      if (summary.status !== 'PASS' && summary.status !== 'PROVIDER_FAULT') throw new Error('SHARD_FAILED');
      // The shard's own claim has to agree with the results it carries: a
      // shard cannot hide a fault behind a `PASS` it did not earn.
      if ((summary.providerFaults ?? 0) !== verifyResults(workerPlan, summary.results).providerFaults) throw new Error('SHARD_RESULT_ACCOUNTING_MISMATCH');
      // The audit codes a failed repeat leaves behind are not implied by the
      // case results, so the suite's accounting takes them over: a repeat
      // that did not work is still an unverified case.
      for (const problem of summary.problems ?? []) {
        if (isProviderFaultProblem(problem) && !problem.startsWith(`${PROVIDER_FAULT}: `)) errors.push(`${PROVIDER_FAULT}: ${shard.name}: ${problem}`);
      }
    } catch (error) { errors.push(`${shard.name}: ${error.code === 'ENOENT' ? 'SHARD_EVIDENCE_MISSING' : error.message}`); }
  }
  return verifyResults(plan, results, errors);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [planPath,root,policyPath] = process.argv.slice(2);
  const plan = JSON.parse(readFileSync(planPath));
  // No worker artifacts exist when every job fails during preparation.
  mkdirSync(root, { recursive: true });
  const verdict = reconcile(plan, root);
  let biomniReport = '';
  rmSync(join(root, 'biomni-baseline-candidate.json'), { force: true });
  try {
    const policy = JSON.parse(readFileSync(policyPath ?? new URL('./biomni-gate.json', import.meta.url)));
    const baseline = policy.mode === 'compare' ? JSON.parse(readFileSync(policy.baseline)) : undefined;
    const biomni = collectSuite(plan, root, policy, baseline);
    if (biomni) {
      // A provider fault is not a product regression: it does not invalidate
      // the biomni accounting, while a real failure does.
      if (verdict.problems.some(problem => !isProviderFaultProblem(problem))) {
        biomni.problems.push('BIOMNI_EXECUTION_ACCOUNTING_FAILED');
        biomni.status = 'failed'; biomni.non_regression_certified = false;
      }
      writeFileSync(join(root, 'biomni-gate.json'), JSON.stringify(biomni, null, 2) + '\n');
      biomniReport = renderSuite(biomni);
      writeFileSync(join(root, 'biomni-gate.md'), biomniReport);
      if (biomni.status === 'baseline_candidate' && verdict.status === 'PASS') {
        writeFileSync(join(root, 'biomni-baseline-candidate.json'), JSON.stringify(biomni, null, 2) + '\n');
      }
      verdict.problems.push(...biomni.problems);
      verdict.biomni = { status: biomni.status, non_regression_certified: biomni.non_regression_certified, expected: biomni.expected, measured: biomni.measured, summary: biomni.summary };
    }
  } catch { verdict.problems.push('BIOMNI_GATE_EVIDENCE_OR_POLICY_INVALID'); }
  // A provider fault stays distinguishable: it keeps its own status and its
  // own problems, and it is never read as a product failure. It does not
  // pass the gate either — a planned case that only faulted is unverified, so
  // the suite exits non-zero. Only a product problem turns the verdict into a
  // hard `FAIL`.
  const productProblems = verdict.problems.filter(problem => !isProviderFaultProblem(problem));
  if (productProblems.length) { verdict.status = 'FAIL'; verdict.exitCode = 1; }
  else if (verdict.problems.some(problem => isProviderFaultProblem(problem))) { verdict.status = 'PROVIDER_FAULT'; verdict.exitCode = 1; }
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
  const report = `### Real E2E: ${verdict.status}\n\n${plan.profile}, backend=${plan.execution.backend}, revision=${plan.revision}\n\nPlanned ${verdict.planned}; executed ${verdict.executed}; passed ${verdict.passed}; provider faults ${verdict.providerFaults ?? 0}.\n\n${verdict.biomni ? `Biomni public tasks: ${verdict.biomni.measured}/${verdict.biomni.expected}; ${verdict.biomni.status}; non-regression certified: ${verdict.biomni.non_regression_certified}.\n\n` : ''}${verdict.problems.map(p=>`- ${p}`).join('\n')}\n`;
  console.log(report);
  console.log(biomniReport);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, biomniReport);
  process.exitCode = verdict.exitCode;
}

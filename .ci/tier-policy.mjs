// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { backendName } from '../test/support/tagged/execution.mjs';

export function route(event, requested = 'pr', backend = 'jiuwenswarm') {
  if (!['pr', 'merge', 'daily', 'release'].includes(requested)) throw new Error(`Unknown CI profile: ${requested}`);
  // A fork cannot obtain credentials by changing a profile input. Queue
  // candidates always receive L3, even when there is just one queued PR.
  const profile = event === 'pull_request' ? 'pr' : event === 'merge_group' ? 'merge' : requested;
  return { profile, backend: backendName(backend), real: profile !== 'pr', distribution: profile !== 'pr' };
}

export function gate(profile, needs) {
  const required = ['l1', 'ut', 'st', 'e2e-plan', 'e2e'];
  if (profile !== 'pr') required.push('real-plan', 'real-e2e', 'real-report', 'binary', 'docker');
  const problems = required.filter(name => needs[name]?.result !== 'success').map(name => `${name}: ${needs[name]?.result ?? 'missing'}`);
  // A scheduled job may not quietly run (or fail) outside the selected policy.
  for (const name of ['real-plan', 'real-e2e', 'real-report', 'binary', 'docker']) {
    if (profile === 'pr' && needs[name]?.result !== 'skipped') problems.push(`${name}: expected skipped in PR policy`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'gate') {
    const problems = gate(process.env.CI_PROFILE, JSON.parse(process.env.CI_JOB_RESULTS));
    if (problems.length) throw new Error(`CI gate failed: ${problems.join('; ')}`);
    console.log(`PASS: ${process.env.CI_PROFILE} at ${process.env.GITHUB_SHA}`);
  } else {
    const result = route(process.env.GITHUB_EVENT_NAME, process.env.CI_REQUESTED_PROFILE || 'pr', process.env.CI_REQUESTED_BACKEND || 'jiuwenswarm');
    for (const [key,value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

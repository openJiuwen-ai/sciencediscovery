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
  const required = ['policy', 'l1', 'ut', 'st', 'e2e-plan', 'e2e'];
  const realJob = profile === 'merge' ? 'real-merge' : profile === 'pr' ? null : 'real-scheduled';
  if (realJob) required.push(realJob, 'binary', 'docker');
  const problems = required.filter(name => needs[name]?.result !== 'success').map(name => `${name}: ${needs[name]?.result ?? 'missing'}`);
  // A scheduled job may not quietly run (or fail) outside the selected policy.
  const inactive = ['real-merge', 'real-scheduled'].filter(name => name !== realJob);
  if (profile === 'pr') inactive.push('binary', 'docker');
  for (const name of inactive) {
    if (needs[name]?.result !== 'skipped') problems.push(`${name}: expected skipped in ${profile} policy`);
  }
  return problems;
}

export function mergeGroupPullRequestNumber(headRef = '') {
  const match = /^refs\/heads\/gh-readonly-queue\/.+\/pr-([1-9]\d*)-[^/]+$/.exec(headRef);
  const number = Number(match?.[1]);
  return Number.isSafeInteger(number) ? number : null;
}

export function claGate(event, { statuses, user, error } = {}) {
  if (!['pull_request', 'merge_group'].includes(event)) {
    return { ok: true, message: `license/cla: not applicable to ${event}` };
  }
  // An unreadable response must never look like an absent context, even for bots.
  if (error || !Array.isArray(statuses)) {
    return { ok: false, message: `license/cla: could not read commit statuses: ${error || 'missing response'}` };
  }
  // GitHub lists statuses newest first; the workflow supplies every page.
  const status = statuses.find(item => item.context === 'license/cla');
  if (!status) return { ok: true, message: 'license/cla: context absent' };
  if (status.state === 'success') return { ok: true, message: 'license/cla: success' };
  if (user?.type === 'Bot') {
    return { ok: true, message: `license/cla: ${status.state}; allowed for Bot PR author ${user.login}` };
  }
  return { ok: false, message: `license/cla: ${status.state}; no Bot PR author exemption` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'gate') {
    const problems = gate(process.env.CI_PROFILE, JSON.parse(process.env.CI_JOB_RESULTS));
    if (problems.length) throw new Error(`CI gate failed: ${problems.join('; ')}`);
    console.log(`PASS: ${process.env.CI_PROFILE} at ${process.env.GITHUB_SHA}`);
  } else if (process.argv[2] === 'cla') {
    const result = claGate(process.env.GITHUB_EVENT_NAME, JSON.parse(process.env.CI_CLA_RESULT || '{}'));
    if (!result.ok) throw new Error(`CI gate failed: ${result.message}`);
    console.log(result.message);
  } else {
    const result = route(process.env.GITHUB_EVENT_NAME, process.env.CI_REQUESTED_PROFILE || 'pr', process.env.CI_REQUESTED_BACKEND || 'jiuwenswarm');
    for (const [key,value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { backendName } from '../test/support/tagged/execution.mjs';
import { changedPaths, documentationOnly } from './changed-paths.mjs';

const distributionProfiles = ['pr', 'daily', 'release'];
const windowsDesktopProfiles = ['daily', 'release'];
const packageJobs = new Map([
  ['linux-windows', ['binary', 'windows-desktop']],
  ['macos', ['macos-desktop']],
  ['all', ['binary', 'windows-desktop', 'macos-desktop']],
]);
const testJobs = ['ut', 'st', 'e2e-plan', 'e2e', 'real-merge', 'real-scheduled'];
const distributionJobs = ['binary', 'docker', 'windows-desktop', 'macos-desktop'];

export function route(event, requested = 'pr', backend = 'jiuwenswarm', paths = null, packagePlatform = 'linux-windows') {
  if (!['pr', 'merge', 'daily', 'release', 'package'].includes(requested)) throw new Error(`Unknown CI profile: ${requested}`);
  // A fork cannot obtain credentials by changing a profile input. Queue
  // candidates always receive L3, even when there is just one queued PR.
  const profile = event === 'pull_request' ? 'pr' : event === 'merge_group' ? 'merge' : requested;
  const packaging = profile === 'package';
  const selected = packaging ? packageJobs.get(packagePlatform) : [];
  if (!selected) throw new Error(`Unknown package platform: ${packagePlatform}`);
  const docs_only = !packaging && ['pull_request', 'push', 'merge_group'].includes(event) && documentationOnly(paths);
  const distribution = distributionProfiles.includes(profile);
  return {
    profile, backend: backendName(backend), test_layers: !packaging,
    mocked: !packaging && profile !== 'pr', real: !packaging && profile !== 'pr',
    package_platform: packaging ? packagePlatform : '',
    binary: distribution || selected.includes('binary'), distribution,
    windows_desktop: windowsDesktopProfiles.includes(profile) || selected.includes('windows-desktop'),
    macos_desktop: selected.includes('macos-desktop'), docs_only,
  };
}

export function gate(profile, needs) {
  if (profile === 'package') {
    const platform = needs.policy?.outputs?.package_platform;
    const selected = packageJobs.get(platform);
    if (!selected) return [`policy: invalid or missing package platform (${platform ?? 'missing'})`];
    const required = ['policy', 'l1', ...selected];
    const inactive = [...testJobs, ...distributionJobs.filter(name => !selected.includes(name))];
    return [
      ...required.filter(name => needs[name]?.result !== 'success')
        .map(name => `${name}: ${needs[name]?.result ?? 'missing'}`),
      ...inactive.filter(name => needs[name]?.result !== 'skipped')
        .map(name => `${name}: expected skipped in package/${platform} policy`),
    ];
  }
  if (needs.policy?.outputs?.docs_only === 'true') {
    const problems = ['policy', 'l1'].filter(name => needs[name]?.result !== 'success')
      .map(name => `${name}: ${needs[name]?.result ?? 'missing'}`);
    for (const name of [...testJobs, ...distributionJobs]) {
      if (needs[name]?.result !== 'skipped') problems.push(`${name}: expected skipped for documentation-only changes`);
    }
    return problems;
  }
  const required = ['policy', 'l1', 'ut', 'st'];
  if (profile !== 'pr') required.push('e2e-plan', 'e2e');
  const realJob = profile === 'merge' ? 'real-merge' : profile === 'pr' ? null : 'real-scheduled';
  if (realJob) required.push(realJob);
  // Linux/Docker distributions run on PRs and nightly/release; the Windows
  // desktop installer is reserved for nightly/release and never repeats in the queue.
  if (distributionProfiles.includes(profile)) required.push('binary', 'docker');
  if (windowsDesktopProfiles.includes(profile)) required.push('windows-desktop');
  const problems = required.filter(name => needs[name]?.result !== 'success').map(name => `${name}: ${needs[name]?.result ?? 'missing'}`);
  // A scheduled job may not quietly run (or fail) outside the selected policy.
  const inactive = ['real-merge', 'real-scheduled', 'macos-desktop'].filter(name => name !== realJob);
  if (profile === 'pr') inactive.push('e2e-plan', 'e2e');
  if (!distributionProfiles.includes(profile)) inactive.push('binary', 'docker');
  if (!windowsDesktopProfiles.includes(profile)) inactive.push('windows-desktop');
  for (const name of inactive) {
    if (needs[name]?.result !== 'skipped') problems.push(`${name}: expected skipped in ${profile} policy`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'gate') {
    const problems = gate(process.env.CI_PROFILE, JSON.parse(process.env.CI_JOB_RESULTS));
    if (problems.length) throw new Error(`CI gate failed: ${problems.join('; ')}`);
    console.log(`PASS: ${process.env.CI_PROFILE} at ${process.env.GITHUB_SHA}`);
  } else {
    let paths = null;
    try {
      paths = changedPaths(process.env.GITHUB_EVENT_NAME, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
        { enabled: process.env.CI_DIFF_ENABLED === 'true' });
    } catch { /* Unreadable event data keeps the full profile. */ }
    const result = route(process.env.GITHUB_EVENT_NAME, process.env.CI_REQUESTED_PROFILE || 'pr',
      process.env.CI_REQUESTED_BACKEND || 'jiuwenswarm', paths, process.env.CI_REQUESTED_PACKAGE_PLATFORM || undefined);
    for (const [key,value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { backendName } from '../test/support/tagged/execution.mjs';
import { changedPaths, documentationOnly } from './changed-paths.mjs';

import { webUiStSelection } from './web-ui-st.mjs';

const sourceTestMap = JSON.parse(readFileSync(new URL('../test/source-test-map.json', import.meta.url), 'utf8'));
const mockedDesktopSpec = /^apps\/desktop\/e2e\/[\w-]+\.spec\.ts$/u;

export function desktopSelection(paths) {
  if (!paths?.length) return 'all';
  const selected = new Set();
  for (const file of paths) {
    if (mockedDesktopSpec.test(file)) {
      // A rename/deletion leaves the old path in the diff. Fall back to the
      // full suite when the selector cannot resolve a spec in this checkout.
      selected.add(file);
    } else if (file.startsWith('apps/desktop/src/')) {
      const mapped = sourceTestMap.entries.find(entry => entry.source === file)?.tests
        ?.map(evidence => evidence.source).filter(source => mockedDesktopSpec.test(source));
      if (!mapped?.length) return 'all';
      for (const source of mapped) selected.add(source);
    } else if (/^(?:apps\/desktop\/|packages\/|config\/|test\/(?:fixtures|helpers|support)\/|\.ci\/|\.github\/workflows\/)|^(?:package\.json|pnpm-.*\.yaml|tsconfig\..*|test\/(?:source-test-map\.json|check-e2e-meta|sync-e2e|e2e\.package))/u.test(file)) {
      return 'all';
    }
  }
  return selected.size ? JSON.stringify([...selected].sort()) : 'none';
}

const distributionProfiles = ['pr', 'daily', 'release'];
const windowsDesktopProfiles = ['daily', 'release'];

export function route(event, requested = 'pr', backend = 'jiuwenswarm', paths = null) {
  if (!['pr', 'merge', 'daily', 'release'].includes(requested)) throw new Error(`Unknown CI profile: ${requested}`);
  // A fork cannot obtain credentials by changing a profile input. Queue
  // candidates always receive L3, even when there is just one queued PR.
  const profile = event === 'pull_request' ? 'pr' : event === 'merge_group' ? 'merge' : requested;
  const docs_only = ['pull_request', 'push', 'merge_group'].includes(event) && documentationOnly(paths);
  const desktop_specs = docs_only ? 'none' : profile === 'pr' ? desktopSelection(paths) : 'all';
  const web_ui_st_specs = docs_only || profile !== 'pr' ? 'none' : webUiStSelection(paths);
  return { profile, desktop_specs, web_ui_st_specs, backend: backendName(backend), mocked: profile !== 'pr' || web_ui_st_specs !== 'none', real: profile !== 'pr', distribution: distributionProfiles.includes(profile), windows_desktop: windowsDesktopProfiles.includes(profile), docs_only };
}

export function gate(profile, needs) {
  if (needs.policy?.outputs?.docs_only === 'true') {
    const problems = ['policy', 'l1'].filter(name => needs[name]?.result !== 'success')
      .map(name => `${name}: ${needs[name]?.result ?? 'missing'}`);
    for (const name of ['ut', 'st', 'e2e-plan', 'e2e', 'desktop-mocked', 'real-merge', 'real-scheduled', 'binary', 'docker', 'windows-desktop']) {
      if (needs[name]?.result !== 'skipped') problems.push(`${name}: expected skipped for documentation-only changes`);
    }
    return problems;
  }
  const required = ['policy', 'l1', 'ut', 'st'];
  const expectsWeb = profile !== 'pr' || (needs.policy?.outputs?.web_ui_st_specs ?? 'none') !== 'none';
  if (expectsWeb) required.push('e2e-plan', 'e2e');
  if (profile !== 'pr' || (needs.policy?.outputs?.desktop_specs ?? 'none') !== 'none') required.push('desktop-mocked');
  const realJob = profile === 'merge' ? 'real-merge' : profile === 'pr' ? null : 'real-scheduled';
  if (realJob) required.push(realJob);
  // Linux/Docker distributions run on PRs and nightly/release; the Windows
  // desktop installer is reserved for nightly/release and never repeats in the queue.
  if (distributionProfiles.includes(profile)) required.push('binary', 'docker');
  if (windowsDesktopProfiles.includes(profile)) required.push('windows-desktop');
  const problems = required.filter(name => needs[name]?.result !== 'success').map(name => `${name}: ${needs[name]?.result ?? 'missing'}`);
  // A scheduled job may not quietly run (or fail) outside the selected policy.
  const inactive = ['real-merge', 'real-scheduled'].filter(name => name !== realJob);
  if (profile === 'pr') {
    if (!expectsWeb) inactive.push('e2e-plan', 'e2e');
    if ((needs.policy?.outputs?.desktop_specs ?? 'none') === 'none') inactive.push('desktop-mocked');
  }
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
    const result = route(process.env.GITHUB_EVENT_NAME, process.env.CI_REQUESTED_PROFILE || 'pr', process.env.CI_REQUESTED_BACKEND || 'jiuwenswarm', paths);
    for (const [key,value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { backendName } from '../test/support/tagged/execution.mjs';
import { changedPaths, documentationOnly } from './changed-paths.mjs';
import { assessVersionChange, RELEASE_METADATA, VERSION_FILE, versionOf } from './release-version.mjs';

const distributionProfiles = ['pr', 'daily', 'release'];
const windowsDesktopProfiles = ['daily', 'release'];

export function route(event, requested = 'pr', backend = 'jiuwenswarm', paths = null) {
  if (!['pr', 'merge', 'daily', 'release'].includes(requested)) throw new Error(`Unknown CI profile: ${requested}`);
  // A fork cannot obtain credentials by changing a profile input. Queue
  // candidates always receive L3, even when there is just one queued PR.
  const profile = event === 'pull_request' ? 'pr' : event === 'merge_group' ? 'merge' : requested;
  const docs_only = ['pull_request', 'push', 'merge_group'].includes(event) && documentationOnly(paths);
  return { profile, backend: backendName(backend), mocked: profile !== 'pr', real: profile !== 'pr', distribution: distributionProfiles.includes(profile), windows_desktop: windowsDesktopProfiles.includes(profile), docs_only };
}

/**
 * A version bump is a release change (#1254).
 *
 * Kept here because the policy job is the only one that checks out the pull
 * request's history: the version it moved *from* lives in a commit a shallow
 * clone does not have. The rule itself is `release-version.mjs`, and its cases
 * run in the UT slice with the rest of `.ci`.
 *
 * Only a pull request is checked. A push to `main` and the merge queue re-verify
 * a commit whose pull request already answered this.
 */
export function versionProblems({ baseVersion, event, files, headVersion, title }) {
  if (event !== 'pull_request') return [];
  const verdict = assessVersionChange({ baseVersion, files, headVersion, title });
  return verdict.ok ? [] : [verdict.reason];
}

/**
 * Reads what `versionProblems` needs from this checkout.
 *
 * The readers and Git command are injectable so a case can drive this without
 * a repository, and assert that every metadata path is actually read — a
 * mapping that quietly skipped one would leave that file unchecked while the
 * rule still looked in place.
 */
export function versionProblemsFromEvent({
  event,
  payload,
  git = args => execFileSync('git', args, { encoding: 'utf8' }),
  readFile = path => readFileSync(path, 'utf8'),
  showFile = (sha, path) => git(['show', `${sha}:${path}`]),
}) {
  if (event !== 'pull_request') return [];
  const head = payload?.pull_request?.head?.sha;
  if (typeof head !== 'string' || !/^[a-f\d]{40}$/i.test(head)) {
    throw new Error('release version: the event carries no usable pull_request.head.sha');
  }
  // checkout checks out the synthetic PR merge, whose first parent is the
  // target revision actually used. The event's base.sha can predate that merge;
  // comparing it to the checkout would attribute main's release to this PR.
  // Verify the other parent before trusting this relationship, so a raw branch
  // checkout or a different candidate cannot silently bypass the version gate.
  const [, base, mergedHead, ...extraParents] = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/u);
  if (!base || !/^[a-f\d]{40}$/i.test(base) || mergedHead !== head || extraParents.length) {
    throw new Error('release version: checkout must be a two-parent PR merge with pull_request.head.sha as its second parent');
  }
  const headVersion = versionOf(readFile(VERSION_FILE));
  const baseVersion = versionOf(showFile(base, VERSION_FILE));
  // Compare first, read the metadata after: a pull request that deletes or
  // renames one of those files has nothing to do with this rule, and must not be
  // stopped by it. A missing file then becomes `undefined` rather than a throw,
  // and the rule reports it by name if a version really did move.
  if (headVersion === baseVersion) return [];
  const readOrUndefined = path => {
    try { return readFile(path); } catch { return undefined; }
  };
  const files = Object.fromEntries(RELEASE_METADATA.map(path => [path, readOrUndefined(path)]));
  return versionProblems({
    baseVersion,
    event,
    files,
    headVersion,
    title: payload?.pull_request?.title ?? '',
  });
}

export function gate(profile, needs) {
  if (needs.policy?.outputs?.docs_only === 'true') {
    const problems = ['policy', 'l1'].filter(name => needs[name]?.result !== 'success')
      .map(name => `${name}: ${needs[name]?.result ?? 'missing'}`);
    for (const name of ['ut', 'st', 'e2e-plan', 'e2e', 'real-merge', 'real-scheduled', 'binary', 'docker', 'windows-desktop']) {
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
  const inactive = ['real-merge', 'real-scheduled'].filter(name => name !== realJob);
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
    let event = {};
    try {
      event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      paths = changedPaths(process.env.GITHUB_EVENT_NAME, event, { enabled: process.env.CI_DIFF_ENABLED === 'true' });
    } catch { /* Unreadable event data keeps the full profile. */ }
    // Before anything is selected: a version bump that is not a release change
    // fails the policy job, and every job downstream depends on it.
    const version = versionProblemsFromEvent({ event: process.env.GITHUB_EVENT_NAME, payload: event });
    if (version.length) throw new Error(`CI policy failed: ${version.join('; ')}`);
    // Said out loud even when it passes: a gate that is only visible on failure
    // can be half-wired and still look green (#1254).
    if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
      console.log(`release version OK: ${VERSION_FILE} at ${versionOf(readFileSync(VERSION_FILE, 'utf8'))}`);
    }
    const result = route(process.env.GITHUB_EVENT_NAME, process.env.CI_REQUESTED_PROFILE || 'pr', process.env.CI_REQUESTED_BACKEND || 'jiuwenswarm', paths);
    for (const [key,value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

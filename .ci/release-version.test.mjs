// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTest } from '../test/support/tagged/compat.mjs';
import {
  assessVersionChange,
  SEMVER,
  semverSuggestion,
  VERSION_FILE,
  versionOf,
} from './release-version.mjs';
import { versionProblems, versionProblemsFromEvent } from './tier-policy.mjs';

// Same tags as every other `.ci` case, so this file is collected by the shared
// plan and run in the UT slice rather than being a step of its own.
const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), '..');
const TITLE = 'chore(release): ship 0.4.0';
const PR_HEAD = 'd'.repeat(40);
const checkoutParents = base => () => `${'e'.repeat(40)} ${base} ${PR_HEAD}\n`;

function versionHistory(t) {
  const parent = join(REPOSITORY, '.tmp/r');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '--initial-branch=main']);
  git(['config', 'user.name', 'Version Policy Test']);
  git(['config', 'user.email', 'version-policy@example.test']);
  const writeVersion = version => {
    mkdirSync(join(root, 'application'), { recursive: true });
    writeFileSync(join(root, VERSION_FILE), JSON.stringify({ version }));
  };
  const commit = message => {
    git(['add', '.']);
    git(['-c', 'commit.gpgsign=false', 'commit', '-m', message]);
    return git(['rev-parse', 'HEAD']).trim();
  };
  writeVersion('0.4.1');
  const oldBase = commit('initial version');
  git(['checkout', '-b', 'feature']);
  writeFileSync(join(root, 'feature.txt'), 'feature');
  const head = commit('functional change');
  git(['checkout', 'main']);
  writeVersion('0.4.0-rc1');
  const currentBase = commit('release version reset');
  git(['-c', 'commit.gpgsign=false', 'merge', '--no-ff', 'feature', '-m', 'merge candidate']);
  return {
    commit, currentBase, git, head, oldBase, writeVersion,
    readFile: path => readFileSync(join(root, path), 'utf8'),
  };
}

test('an old PR does not own a version change inherited from the current target branch', t => {
  const history = versionHistory(t);
  for (const base of [history.oldBase, history.currentBase]) {
    assert.deepEqual(versionProblemsFromEvent({
      event: 'pull_request',
      payload: { pull_request: { base: { sha: base }, head: { sha: history.head }, title: 'feat: functional change' } },
      git: history.git,
      readFile: history.readFile,
      showFile: (sha, path) => history.git(['show', `${sha}:${path}`]),
    }), []);
  }
});

test('the merge comparison still rejects a functional PR that changes the version', t => {
  const history = versionHistory(t);
  history.git(['checkout', '-b', 'version-feature', history.currentBase]);
  history.writeVersion('0.5.0');
  const head = history.commit('functional change with a version bump');
  history.git(['checkout', '--detach', history.currentBase]);
  history.git(['-c', 'commit.gpgsign=false', 'merge', '--no-ff', head, '-m', 'version candidate']);
  const problems = versionProblemsFromEvent({
    event: 'pull_request',
    payload: { pull_request: { base: { sha: history.oldBase }, head: { sha: head }, title: 'feat: functional change' } },
    git: history.git,
    readFile: history.readFile,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /moves 0\.4\.0-rc1 -> 0\.5\.0/u);
  assert.match(problems[0], /does not start with "chore\(release\):"/u);
});

test('a raw PR checkout or an unrelated merge cannot stand in for the tested merge', () => {
  const base = 'a'.repeat(40);
  const candidate = 'e'.repeat(40);
  for (const parents of [
    `${PR_HEAD} ${base}`,
    `${candidate} ${base} ${'f'.repeat(40)}`,
    `${candidate} ${base} ${PR_HEAD} ${'f'.repeat(40)}`,
  ]) {
    assert.throws(() => versionProblemsFromEvent({
      event: 'pull_request',
      payload: { pull_request: { head: { sha: PR_HEAD }, title: 'feat: functional change' } },
      git: () => parents,
      readFile: () => { throw new Error('an unverified checkout must not be read'); },
    }), /checkout must be a two-parent PR merge/u);
  }
});

/** The default is the 0.4.0-rc1 -> 0.4.0 release currently being shipped. */
function verdict(over = {}) {
  return assessVersionChange({
    baseVersion: '0.4.0-rc1',
    headVersion: '0.4.0',
    title: TITLE,
    ...over,
  });
}

test('a pull request that leaves the version alone is never blocked', () => {
  assert.equal(verdict({ headVersion: '0.4.0-rc1', title: 'fix(mcp): reconnect' }).ok, true);
  assert.equal(verdict({ headVersion: '0.4.0-rc1' }).ok, true);
});

test('a release change moves the version with a release title', () => {
  const result = verdict();
  assert.equal(result.ok, true);
  assert.match(result.reason, /0\.4\.0-rc1 -> 0\.4\.0/u);
});

test('a functional change that bumps the version is rejected, like #1197 was', () => {
  const result = verdict({ baseVersion: '0.4.0', headVersion: '0.4.1', title: 'fix(mcp): repair backend discovery' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not start with "chore\(release\):"/u);
});

test('a release title needs only the prefix, not a matching number', () => {
  // The title says "ship 0.4.0" while the version moves to 0.4.1. The gate asks
  // for the release prefix and a SemVer-shaped version, not a number repeated in
  // the title, so this is still a valid release change.
  const result = verdict({ baseVersion: '0.4.0', headVersion: '0.4.1' });
  assert.equal(result.ok, true);
});

test('the release prefix has to start the title', () => {
  assert.equal(verdict({ title: 'fix: chore(release): sneak it in' }).ok, false);
  assert.equal(verdict({ title: '  chore(release): leading space is fine' }).ok, true);
  assert.equal(verdict({ title: '' }).ok, false);
});

test('the dot spelling is rejected with a suggestion that differs from it', () => {
  for (const [given, wanted] of [
    ['0.4.0.rc1', '0.4.0-rc1'],
    ['0.4.0.1', '0.4.0-1'],
    ['v0.4.0', '0.4.0'],
    // Both rewrites, in order: a leading `v` and then an inner dot. Running only
    // one of them is what echoed `0.4.0.rc1` back for this input.
    ['v0.4.0.rc1', '0.4.0-rc1'],
    ['v0.4.0.1', '0.4.0-1'],
  ]) {
    assert.equal(semverSuggestion(given), wanted);
    const result = verdict({ headVersion: given });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not a SemVer version/u);
    // The suggestion clause must name a different string: an earlier version of
    // this check told `0.4.0.1` to write `0.4.0.1`.
    const suggestion = /write it "([^"]+)"/u.exec(result.reason);
    assert.ok(suggestion, `${given}: the message carries no suggestion`);
    assert.equal(suggestion[1], wanted, `${given} should be told to use ${wanted}`);
    assert.notEqual(suggestion[1], given, `${given} must not be told to use itself`);
  }
});

test('an unrecognizable spelling gets the shape to write, not itself', () => {
  assert.equal(semverSuggestion('0.4.0 rc1'), '<major>.<minor>.<patch>[-<suffix>]');
});

test('SemVer shapes the field may take', () => {
  for (const value of ['0.4.0', '0.4.0-rc1', '1.2.3-beta.2', '1.2.3+build.5', '1.2.3-rc.1+abc']) {
    assert.equal(SEMVER.test(value), true, `${value} should be accepted`);
  }
  for (const value of ['0.4.0.rc1', '0.4', 'v0.4.0-rc1', '0.4.0-', '', '0.4.0 rc1']) {
    assert.equal(SEMVER.test(value), false, `${value} should be rejected`);
  }
});

test('the version is read from the field, not from the text around it', () => {
  assert.equal(versionOf('{"name":"sd-shell","version":"0.4.0-rc1"}'), '0.4.0-rc1');
});

test('the installer name still derives from the version field', () => {
  // The ${version} macro is the whole single-source property: a future edit
  // pinning a literal artifact name here would pass the gate and reintroduce
  // the #1197 drift, so pin the macro directly.
  const eb = readFileSync(join(REPOSITORY, 'application/electron-builder.yml'), 'utf8');
  assert.match(eb, /artifactName: ScienceDiscovery-\$\{version\}-win-x64-setup\.\$\{ext\}/u);
});

// ---- the policy job's own half of the rule --------------------------------

test('the policy verdict is the rule, and only for pull requests', () => {
  assert.deepEqual(versionProblems({
    baseVersion: '0.4.1', event: 'pull_request', headVersion: '0.4.1', title: 'fix(mcp): reconnect',
  }), []);

  const rejected = versionProblems({
    baseVersion: '0.4.0', event: 'pull_request', headVersion: '0.4.1', title: 'fix(mcp): reconnect',
  });
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /does not start with "chore\(release\):"/u);

  for (const event of ['push', 'merge_group', 'workflow_dispatch']) {
    assert.deepEqual(versionProblems({
      baseVersion: '0.4.0', event, headVersion: '0.4.1', title: 'fix(mcp): reconnect',
    }), [], `${event} must not be checked`);
  }
});

test('the policy job actually calls the rule', () => {
  // The success line makes a working gate visible, but a dropped call would leave
  // every case above green. This is the wiring, pinned the way the repository
  // pins the payload-identity wiring: read the source and require the call.
  const policy = readFileSync(join(REPOSITORY, '.ci/tier-policy.mjs'), 'utf8');
  assert.match(policy, /versionProblemsFromEvent\(/u, 'the policy CLI no longer calls the version check');
  assert.match(policy, /CI policy failed: /u, 'a violation no longer fails the policy job');
  assert.match(policy, /release version OK: /u, 'a passing gate is no longer reported');
  assert.match(policy, /versionProblemsFromEvent\(\{ event: process\.env\.GITHUB_EVENT_NAME, payload: event \}\)/u);
});

test('the checkout read covers the version file and the base commit', () => {
  const asked = [];
  const problems = versionProblemsFromEvent({
    event: 'pull_request',
    payload: { pull_request: { base: { sha: 'a'.repeat(40) }, head: { sha: PR_HEAD }, title: 'fix(mcp): reconnect' } },
    git: checkoutParents('a'.repeat(40)),
    readFile: path => { asked.push(path); return '{"version": "0.4.0-rc1"}'; },
    showFile: (sha, path) => { asked.push(`${sha.slice(0, 7)}:${path}`); return '{"version": "0.4.0"}'; },
  });
  assert.equal(problems.length, 1, 'the version moved, so the rule applies');
  assert.ok(asked.includes(VERSION_FILE), 'the head version file was never read');
  assert.equal(asked.filter(entry => entry.includes(':')).length, 1, 'the base commit is read once');
});

test('a pull request that changes only other files is not stopped when the version did not move', () => {
  const problems = versionProblemsFromEvent({
    event: 'pull_request',
    payload: { pull_request: { base: { sha: 'b'.repeat(40) }, head: { sha: PR_HEAD }, title: 'docs: drop a stale README' } },
    git: checkoutParents('b'.repeat(40)),
    readFile: () => '{"version": "0.4.0-rc1"}',
    showFile: () => '{"version": "0.4.0-rc1"}',
  });
  assert.deepEqual(problems, [], 'an unchanged version applies no rule');
});

test('the checkout read refuses an event it cannot compare against', () => {
  assert.throws(
    () => versionProblemsFromEvent({
      event: 'pull_request', payload: { pull_request: { title: 'chore(release): x' } },
      readFile: () => '{}', showFile: () => '{}',
    }),
    /no usable pull_request\.head\.sha/u,
  );
});

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
  dotForm,
  RELEASE_METADATA,
  requirementsFor,
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
const TITLE = 'chore(release): reset the Windows desktop package to the 0.4.0-rc1 line';
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

function readme(version, dot) {
  return `[![Release](https://img.shields.io/badge/Release-${dot}-1f6feb)](https://github.com/o/r/releases/tag/v${version})\n`;
}

/** The repository as a pre-release leaves it: the artifact name is the literal. */
function files(version = '0.4.0-rc1') {
  const dot = dotForm(version);
  return {
    'application/electron-builder.yml': `win:\n  artifactName: ScienceDiscovery-${dot}-win-x64-setup.\${ext}\n`,
    'application/build/nsh-syntax-check-stub.nsi': `!define VERSION "${dot}"\n`,
    'README.md': readme(version, dot),
    'README_zh.md': readme(version, dot),
  };
}

/** The repository as the documented GA policy leaves it: the macro is back. */
function gaFiles(version = '0.4.0') {
  return {
    'application/electron-builder.yml': 'win:\n  artifactName: ScienceDiscovery-${version}-win-x64-setup.${ext}\n',
    'application/build/nsh-syntax-check-stub.nsi': `!define VERSION "${version}"\n`,
    'README.md': readme(version, version),
    'README_zh.md': readme(version, version),
  };
}

function verdict(over = {}) {
  return assessVersionChange({
    baseVersion: '0.4.1',
    files: files(),
    headVersion: '0.4.0-rc1',
    title: TITLE,
    ...over,
  });
}

test('a pull request that leaves the version alone is never blocked', () => {
  assert.equal(verdict({ headVersion: '0.4.1', title: 'fix(mcp): reconnect' }).ok, true);
  assert.equal(verdict({ headVersion: '0.4.1' }).ok, true);
});

test('a release change moves the version with every place it is spelled', () => {
  const result = verdict();
  assert.equal(result.ok, true);
  assert.match(result.reason, /0\.4\.1 -> 0\.4\.0-rc1/u);
});

test('the GA shape passes: the macro is the documented form for a final release', () => {
  // `scripts/package-sd-windows.sh` says the literal is pinned only for the rc
  // cycle, and that at GA `artifactName` goes back to `${version}`.
  const result = verdict({ baseVersion: '0.4.0-rc1', files: gaFiles(), headVersion: '0.4.0' });
  assert.equal(result.ok, true, result.reason);
  // A GA release that keeps the literal is fine too: same string, same file name.
  assert.equal(verdict({ baseVersion: '0.4.0-rc1', files: files('0.4.0'), headVersion: '0.4.0' }).ok, true);
});

test('a GA bump that leaves the rc metadata in place fails', () => {
  // The substring trap: `0.4.0` is a prefix of `0.4.0.rc1`, so a plain includes()
  // check passed while the installer was still named for the pre-release.
  const result = verdict({ baseVersion: '0.4.0-rc1', files: files('0.4.0-rc1'), headVersion: '0.4.0' });
  assert.equal(result.ok, false, result.reason);
  assert.match(result.reason, /electron-builder\.yml does not carry ScienceDiscovery-0\.4\.0- or ScienceDiscovery-\$\{version\}-/u);
  assert.match(result.reason, /nsh-syntax-check-stub\.nsi does not carry !define VERSION "0\.4\.0"/u);
  assert.match(result.reason, /README\.md does not carry Release-0\.4\.0-/u);
  assert.match(result.reason, /README_zh\.md does not carry releases\/tag\/v0\.4\.0/u);
});

test('a version that merely starts with the expected one does not satisfy it', () => {
  // Same class as `0.4.0` / `0.4.0.rc1`: `0.4.0.rc10` must not pass for `0.4.0-rc1`.
  const rc10 = {
    'application/electron-builder.yml': 'win:\n  artifactName: ScienceDiscovery-0.4.0.rc10-win-x64-setup.${ext}\n',
    'application/build/nsh-syntax-check-stub.nsi': '!define VERSION "0.4.0.rc10"\n',
    'README.md': readme('0.4.0-rc10', '0.4.0.rc10'),
    'README_zh.md': readme('0.4.0-rc10', '0.4.0.rc10'),
  };
  const result = verdict({ files: rc10 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /electron-builder\.yml does not carry ScienceDiscovery-0\.4\.0\.rc1-/u);
});

test('a pre-release still needs the literal, because the macro cannot spell the dot form', () => {
  const result = verdict({ baseVersion: '0.4.1', files: gaFiles('0.5.0-rc1'), headVersion: '0.5.0-rc1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /electron-builder\.yml does not carry ScienceDiscovery-0\.5\.0\.rc1-/u);
});

test('a functional change that bumps the version is rejected, like #1197 was', () => {
  const result = verdict({
    baseVersion: '0.4.0',
    files: files('0.4.0'),
    headVersion: '0.4.1',
    title: 'fix(mcp): repair backend discovery',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not start with "chore\(release\):"/u);
  assert.match(result.reason, /electron-builder\.yml does not carry/u);
});

test('the title alone is not enough', () => {
  const result = verdict({ baseVersion: '0.4.0', files: files('0.4.0'), headVersion: '0.4.1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /README\.md does not carry Release-0\.4\.1-/u);
});

test('one file left behind is named, with the string it is missing', () => {
  const stale = files('0.5.0-rc1');
  stale['application/build/nsh-syntax-check-stub.nsi'] = '!define VERSION "0.4.0.rc1"\n';
  const result = verdict({ files: stale, headVersion: '0.5.0-rc1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /nsh-syntax-check-stub\.nsi does not carry !define VERSION "0\.5\.0\.rc1"/u);
  assert.equal(/electron-builder\.yml does not carry/u.test(result.reason), false);
});

test('the file set alone is not enough', () => {
  const result = verdict({ title: 'fix(desktop): polish the dialog' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not start with "chore\(release\):"/u);
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

test('an unreadable metadata file is reported, not ignored', () => {
  const result = verdict({ files: {} });
  assert.equal(result.ok, false);
  assert.match(result.reason, /application\/electron-builder\.yml could not be read/u);
});

test('the dot form of a version', () => {
  assert.equal(dotForm('0.4.0-rc1'), '0.4.0.rc1');
  assert.equal(dotForm('0.4.1'), '0.4.1');
  assert.equal(dotForm('1.2.3-rc.1'), '1.2.3.rc.1');
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

test('every requirement declares a delimiter and a matcher', () => {
  for (const version of ['0.4.0-rc1', '0.4.0']) {
    for (const { checks, path } of requirementsFor(version)) {
      assert.ok(checks.length > 0, `${path} declares no requirement`);
      for (const { expected, matches } of checks) {
        assert.equal(typeof expected, 'string', `${path} has a requirement without a label`);
        assert.ok(matches instanceof RegExp, `${path} has a requirement without a matcher`);
      }
    }
  }
  assert.deepEqual(RELEASE_METADATA, [
    'application/electron-builder.yml',
    'application/build/nsh-syntax-check-stub.nsi',
    'README.md',
    'README_zh.md',
  ]);
});

// ---- the policy job's own half of the rule --------------------------------

test('the policy verdict is the rule, and only for pull requests', () => {
  assert.deepEqual(versionProblems({
    baseVersion: '0.4.1', event: 'pull_request', files: files(), headVersion: '0.4.1', title: 'fix(mcp): reconnect',
  }), []);

  const rejected = versionProblems({
    baseVersion: '0.4.0', event: 'pull_request', files: files('0.4.0'), headVersion: '0.4.1', title: 'fix(mcp): reconnect',
  });
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /does not start with "chore\(release\):"/u);

  for (const event of ['push', 'merge_group', 'workflow_dispatch']) {
    assert.deepEqual(versionProblems({
      baseVersion: '0.4.0', event, files: {}, headVersion: '0.4.1', title: 'fix(mcp): reconnect',
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

test('the checkout read covers every metadata file, and the base commit', () => {
  const asked = [];
  const contents = { ...files('0.4.1'), [VERSION_FILE]: '{"version": "0.4.1"}' };
  const problems = versionProblemsFromEvent({
    event: 'pull_request',
    payload: { pull_request: { base: { sha: 'a'.repeat(40) }, head: { sha: PR_HEAD }, title: 'fix(mcp): reconnect' } },
    git: checkoutParents('a'.repeat(40)),
    readFile: path => { asked.push(path); return contents[path]; },
    showFile: (sha, path) => { asked.push(`${sha.slice(0, 7)}:${path}`); return '{"version": "0.4.0"}'; },
  });
  assert.equal(problems.length, 1, 'the version moved, so the rule applies');
  for (const { path } of requirementsFor('0.4.0')) {
    assert.ok(asked.includes(path), `${path} was never read`);
  }
  assert.equal(asked.filter(entry => entry.includes(':')).length, 1, 'the base commit is read once');
  assert.ok(asked.some(entry => entry.endsWith(':application/package.json')));
});

test('a pull request that removes a metadata file is not stopped when the version did not move', () => {
  // F11: the rule read every metadata file before comparing versions, so deleting
  // or renaming one failed the policy job on an unrelated pull request.
  const asked = [];
  const problems = versionProblemsFromEvent({
    event: 'pull_request',
    payload: { pull_request: { base: { sha: 'b'.repeat(40) }, head: { sha: PR_HEAD }, title: 'docs: drop a stale README' } },
    git: checkoutParents('b'.repeat(40)),
    readFile: path => {
      asked.push(path);
      if (path === VERSION_FILE) return '{"version": "0.4.0-rc1"}';
      const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
      error.code = 'ENOENT';
      throw error;
    },
    showFile: () => '{"version": "0.4.0-rc1"}',
  });
  assert.deepEqual(problems, [], 'an unchanged version applies no rule, so nothing may throw');
  assert.equal(asked.includes('application/build/nsh-syntax-check-stub.nsi'), false, 'the metadata is not even read');
});

test('a missing metadata file is reported by name when the version did move', () => {
  const problems = versionProblemsFromEvent({
    event: 'pull_request',
    payload: { pull_request: { base: { sha: 'c'.repeat(40) }, head: { sha: PR_HEAD }, title: 'chore(release): bump' } },
    git: checkoutParents('c'.repeat(40)),
    readFile: path => {
      if (path === VERSION_FILE) return '{"version": "0.5.0-rc1"}';
      if (path === 'application/build/nsh-syntax-check-stub.nsi') {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files('0.5.0-rc1')[path];
    },
    showFile: () => '{"version": "0.4.0-rc1"}',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /nsh-syntax-check-stub\.nsi could not be read/u);
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

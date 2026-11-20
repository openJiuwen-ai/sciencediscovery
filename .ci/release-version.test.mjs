// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTest } from '../test/support/tagged/compat.mjs';
import {
  assessVersionChange,
  dotForm,
  RELEASE_METADATA,
  requirementsFor,
  SEMVER,
  spellingOf,
  VERSION_FILE,
  versionOf,
} from './release-version.mjs';
import { versionProblems, versionProblemsFromEvent } from './tier-policy.mjs';

// Same tags as every other `.ci` case, so this file is collected by the shared
// plan and run in the UT slice rather than being a step of its own.
const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), '..');
const TITLE = 'chore(release): reset the Windows desktop package to the 0.4.0-rc1 line';

const readme = (version, dot = dotForm(version)) =>
  `[![Release](https://img.shields.io/badge/Release-${dot}-1f6feb)](https://github.com/o/r/releases/tag/v${version})\n`;

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
    'README.md': readme(version),
    'README_zh.md': readme(version),
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
  // cycle, and that at GA `artifactName` goes back to `${version}`. Requiring the
  // literal unconditionally would have blocked #1198 while following the policy.
  const result = verdict({ baseVersion: '0.4.0-rc1', files: gaFiles(), headVersion: '0.4.0' });
  assert.equal(result.ok, true, result.reason);
  // A GA release that keeps the literal is fine too: same string, same file name.
  assert.equal(verdict({ baseVersion: '0.4.0-rc1', files: files('0.4.0'), headVersion: '0.4.0' }).ok, true);
});

test('a pre-release still needs the literal, because the macro cannot spell the dot form', () => {
  const macroFiles = gaFiles('0.5.0-rc1');
  const result = verdict({ baseVersion: '0.4.1', files: macroFiles, headVersion: '0.5.0-rc1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /electron-builder\.yml does not carry "0\.5\.0\.rc1"/u);
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
  assert.match(result.reason, /electron-builder\.yml does not carry "0\.4\.1"/u);
});

test('the title alone is not enough', () => {
  const result = verdict({ baseVersion: '0.4.0', files: files('0.4.0'), headVersion: '0.4.1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /README\.md \(its spelling\) does not carry "0\.4\.1"/u);
});

test('touching the files without the new number is still the drift', () => {
  const result = verdict({ headVersion: '0.5.0' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /electron-builder\.yml does not carry "0\.5\.0" or "\$\{version\}"/u);
  assert.match(result.reason, /README_zh\.md \(its tag link\) does not carry "v0\.5\.0"/u);
});

test('one file left behind is named, with the string it is missing', () => {
  const stale = files('0.5.0-rc1');
  stale['application/build/nsh-syntax-check-stub.nsi'] = '!define VERSION "0.4.0.rc1"\n';
  const result = verdict({ files: stale, headVersion: '0.5.0-rc1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /nsh-syntax-check-stub\.nsi does not carry "0\.5\.0\.rc1"/u);
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

test('the dot spelling is rejected with the spelling to use instead', () => {
  const result = verdict({ headVersion: '0.4.0.rc1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a SemVer version/u);
  assert.match(result.reason, /"0\.4\.0-rc1"/u);
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

test('every requirement declares a spelling the checker knows', () => {
  for (const version of ['0.4.0-rc1', '0.4.0']) {
    for (const { groups, path } of requirementsFor(version)) {
      assert.ok(groups.length > 0, `${path} declares no requirement`);
      for (const alternatives of groups) {
        assert.ok(alternatives.length > 0, `${path} declares an empty group`);
        for (const kind of alternatives) {
          assert.doesNotThrow(() => spellingOf(kind, version), `${path} declares an unknown spelling: ${kind}`);
        }
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
  const failing = versionProblems({
    baseVersion: '0.4.1',
    event: 'pull_request',
    files: files(),
    headVersion: '0.4.1',
    title: 'fix(mcp): reconnect',
  });
  assert.deepEqual(failing, []);

  const rejected = versionProblems({
    baseVersion: '0.4.0',
    event: 'pull_request',
    files: files('0.4.0'),
    headVersion: '0.4.1',
    title: 'fix(mcp): reconnect',
  });
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /does not start with "chore\(release\):"/u);

  // A push or a merge group re-verifies a commit whose pull request answered this.
  for (const event of ['push', 'merge_group', 'workflow_dispatch']) {
    assert.deepEqual(versionProblems({
      baseVersion: '0.4.0',
      event,
      files: {},
      headVersion: '0.4.1',
      title: 'fix(mcp): reconnect',
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
  // It must run with the event and the checkout, not a constant.
  assert.match(policy, /versionProblemsFromEvent\(\{ event: process\.env\.GITHUB_EVENT_NAME, payload: event \}\)/u);
});

test('the checkout read covers every metadata file, and the base commit', () => {
  // A mapping that silently skipped a file would leave that file unchecked while
  // the rule still looked wired; the readers are injected so this can be seen.
  const asked = [];
  const contents = {
    ...files('0.4.0'),
    [VERSION_FILE]: '{"version": "0.4.0"}',
  };
  const problems = versionProblemsFromEvent({
    event: 'pull_request',
    payload: { pull_request: { base: { sha: 'a'.repeat(40) }, title: 'fix(mcp): reconnect' } },
    readFile: path => { asked.push(path); return contents[path]; },
    showFile: (sha, path) => { asked.push(`${sha.slice(0, 7)}:${path}`); return '{"version": "0.4.0"}'; },
  });
  assert.deepEqual(problems, [], 'an unchanged version is not blocked');
  for (const { path } of requirementsFor('0.4.0')) {
    assert.ok(asked.includes(path), `${path} was never read`);
  }
  assert.equal(asked.filter(entry => entry.includes(':')).length, 1, 'the base commit is read once');
  assert.ok(asked.some(entry => entry.endsWith(':application/package.json')), 'the base version is read from the base commit');
});

test('the checkout read refuses an event it cannot compare against', () => {
  const withoutBase = { pull_request: { title: 'chore(release): x' } };
  assert.throws(
    () => versionProblemsFromEvent({ event: 'pull_request', payload: withoutBase, readFile: () => '{}', showFile: () => '{}' }),
    /no usable pull_request\.base\.sha/u,
  );
});


// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createTest } from '../test/support/tagged/compat.mjs';
import { assessVersionChange, dotForm, RELEASE_METADATA, SEMVER, VERSION_FILE, versionOf } from './release-version.mjs';

// Same tags as every other `.ci` case, so this file is collected by the shared
// plan and run in the UT slice rather than being a step of its own.
const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });

const TITLE = 'chore(release): reset the Windows desktop package to the 0.4.0-rc1 line';

/** The repository as this change leaves it: every spelling carries `version`. */
function files(version = '0.4.0-rc1') {
  const dot = dotForm(version);
  return {
    'application/electron-builder.yml': `win:\n  artifactName: ScienceDiscovery-${dot}-win-x64-setup.\${ext}\n`,
    'application/build/nsh-syntax-check-stub.nsi': `!define VERSION "${dot}"\n`,
    'README.md': `[![Release](https://img.shields.io/badge/Release-${dot}-1f6feb)](https://github.com/o/r/releases/tag/v${version})\n`,
    'README_zh.md': `[![Release](https://img.shields.io/badge/Release-${dot}-1f6feb)](https://github.com/o/r/releases/tag/v${version})\n`,
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

test('a functional change that bumps the version is rejected, like #1197 was', () => {
  const result = verdict({
    baseVersion: '0.4.0',
    files: files('0.4.0'),
    headVersion: '0.4.1',
    title: 'fix(mcp): repair backend discovery',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not start with "chore\(release\):"/u);
  assert.match(result.reason, /application\/electron-builder\.yml does not carry "0\.4\.1"/u);
});

test('the title alone is not enough', () => {
  // A correct release title over files still holding the old number: this is the
  // half the first cut of the check missed.
  const result = verdict({ baseVersion: '0.4.0', files: files('0.4.0'), headVersion: '0.4.1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /README\.md does not carry "0\.4\.1"/u);
});

test('touching the files without the new number is still the drift', () => {
  // A bump to 0.5.0 with the old strings left behind is an installer named for a
  // version it does not have, and a badge linking a tag that 404s.
  const result = verdict({ headVersion: '0.5.0' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /application\/electron-builder\.yml does not carry "0\.5\.0"/u);
  assert.match(result.reason, /README_zh\.md does not carry "v0\.5\.0"/u);
});

test('one file left behind is named, with the string it is missing', () => {
  const stale = files('0.5.0-rc1');
  stale['application/build/nsh-syntax-check-stub.nsi'] = '!define VERSION "0.4.0.rc1"\n';
  const result = verdict({ files: stale, headVersion: '0.5.0-rc1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /nsh-syntax-check-stub\.nsi does not carry "0\.5\.0\.rc1"/u);
  // Only the file that is behind is named.
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

test('every metadata entry declares a spelling the checker knows', () => {
  for (const entry of RELEASE_METADATA) {
    assert.ok(entry.spellings.length > 0, `${entry.path} declares no spelling`);
    for (const kind of entry.spellings) {
      assert.ok(['dot', 'tag'].includes(kind), `${entry.path} declares an unknown spelling: ${kind}`);
    }
  }
});

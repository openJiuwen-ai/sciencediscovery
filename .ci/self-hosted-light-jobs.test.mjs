// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createTest } from '../test/support/tagged/compat.mjs';

const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const LIGHT_RUNNER = Object.freeze(['self-hosted', 'Linux', 'X64', 'sciencediscovery-light']);
const HEAVY_RUNNER = Object.freeze(['self-hosted', 'Linux', 'X64', 'sciencediscovery']);

function readJobs(workflowFile) {
  const text = readFileSync(join(repository, '.github/workflows', workflowFile), 'utf8').replaceAll('\r\n', '\n');
  const body = `\n${text.split('\njobs:\n')[1]}`;
  return Object.fromEntries(
    body.split(/\n(?=  [\w-]+:\n)/)
      .filter(block => /^  [\w-]+:/.test(block))
      .map(block => [block.match(/^  ([\w-]+):/)[1], block]),
  );
}

const ciJobs = readJobs('ci.yml');
const realJobs = readJobs('real-e2e.yml');

const lightJobs = [
  ['ci.yml', 'policy', ciJobs.policy],
  ['ci.yml', 'l1', ciJobs.l1],
  ['ci.yml', 'e2e-plan', ciJobs['e2e-plan']],
  ['ci.yml', 'coverage', ciJobs.coverage],
  ['ci.yml', 'merge-gate', ciJobs['merge-gate']],
  ['real-e2e.yml', 'real-plan', realJobs['real-plan']],
  ['real-e2e.yml', 'real-report', realJobs['real-report']],
];

const cachedLightJobs = [
  ['ci.yml', 'l1', ciJobs.l1],
  ['ci.yml', 'e2e-plan', ciJobs['e2e-plan']],
  ['real-e2e.yml', 'real-plan', realJobs['real-plan']],
];

const nonLightJobs = [
  ['ci.yml', 'ut', ciJobs.ut],
  ['ci.yml', 'st', ciJobs.st],
  ['ci.yml', 'e2e', ciJobs.e2e],
  ['ci.yml', 'desktop-mocked', ciJobs['desktop-mocked']],
  ['ci.yml', 'binary', ciJobs.binary],
  ['ci.yml', 'docker', ciJobs.docker],
  ['ci.yml', 'windows-desktop', ciJobs['windows-desktop']],
  ['ci.yml', 'macos-desktop', ciJobs['macos-desktop']],
  ['real-e2e.yml', 'real-e2e', realJobs['real-e2e']],
  ['real-e2e.yml', 'desktop-real', realJobs['desktop-real']],
];

function evalExpression(expression, { event = 'pull_request', flag } = {}) {
  return runInNewContext(expression, {
    github: { event_name: event },
    vars: flag === undefined ? {} : { CI_SELF_HOSTED_MERGE_QUEUE: flag },
    fromJSON: JSON.parse,
  }, { timeout: 100 });
}

test('lightweight merge-queue jobs route to dedicated light slots only when merge_group and opt-in flag are both active', () => {
  assert.notDeepEqual(LIGHT_RUNNER, HEAVY_RUNNER, 'light slot label must stay disjoint from heavy runner pool');
  for (const [file, name, block] of lightJobs) {
    assert.ok(block, `${file}: missing job ${name}`);
    const runsOnMatch = block.match(/^    runs-on: \$\{\{ (.+) \}\}$/m);
    assert.ok(runsOnMatch, `${file}: ${name} must define a dynamic runs-on expression`);
    const expr = runsOnMatch[1];

    assert.deepEqual(
      evalExpression(expr, { event: 'merge_group', flag: 'true' }),
      [...LIGHT_RUNNER],
      `${file}: ${name} merge_group + true`,
    );

    for (const flag of [undefined, '', 'false', 'TRUE', '1']) {
      assert.equal(
        evalExpression(expr, { event: 'merge_group', flag }),
        'ubuntu-latest',
        `${file}: ${name} merge_group + ${JSON.stringify(flag)}`,
      );
    }

    for (const event of ['pull_request', 'workflow_dispatch', 'workflow_call', 'schedule', 'push']) {
      for (const flag of [undefined, '', 'false', 'true']) {
        assert.equal(
          evalExpression(expr, { event, flag }),
          'ubuntu-latest',
          `${file}: ${name} ${event} + ${JSON.stringify(flag)}`,
        );
      }
    }
  }
});

test('light jobs with pnpm setup skip remote setup-node cache only when routed to light slots', () => {
  for (const [file, name, block] of cachedLightJobs) {
    const cacheMatch = block.match(/^          cache: \$\{\{ (.+) \}\}$/m);
    assert.ok(cacheMatch, `${file}: ${name} must toggle setup-node cache dynamically`);
    const expr = cacheMatch[1];

    assert.equal(
      evalExpression(expr, { event: 'merge_group', flag: 'true' }),
      '',
      `${file}: ${name} merge_group + true disables remote pnpm cache`,
    );

    for (const flag of [undefined, '', 'false', 'TRUE']) {
      assert.equal(
        evalExpression(expr, { event: 'merge_group', flag }),
        'pnpm',
        `${file}: ${name} merge_group + ${JSON.stringify(flag)}`,
      );
    }

    for (const event of ['pull_request', 'workflow_dispatch', 'workflow_call', 'schedule', 'push']) {
      assert.equal(
        evalExpression(expr, { event, flag: 'true' }),
        'pnpm',
        `${file}: ${name} ${event} + true keeps remote pnpm cache`,
      );
    }
  }
});

test('light slots stay credential-free and isolated from heavy, desktop, distribution, and real worker jobs', () => {
  for (const [file, name, block] of lightJobs) {
    assert.doesNotMatch(block, /\bsecrets\./, `${file}: ${name} must not inject secrets onto light self-hosted slots`);
  }
  for (const [file, name, block] of nonLightJobs) {
    assert.ok(block, `${file}: missing job ${name}`);
    assert.doesNotMatch(block, /sciencediscovery-light/, `${file}: ${name} must not target light slots`);
  }
  for (const name of ['real-plan', 'real-report']) {
    assert.match(realJobs[name], /^    if: .*github\.event_name != 'pull_request'/m, `real-e2e.yml: ${name} keeps PR guard`);
  }
});

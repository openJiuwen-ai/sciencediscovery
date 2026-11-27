// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createTest } from '../test/support/tagged/compat.mjs';
import { route } from './tier-policy.mjs';

const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const LIGHT_RUNNER = Object.freeze(['self-hosted', 'Linux', 'X64', 'sciencediscovery-light']);
const NON_MERGE_QUEUE_EVENTS = Object.freeze(['pull_request', 'workflow_dispatch', 'schedule', 'push']);

function readJobs(workflowFile) {
  const text = readFileSync(join(repository, '.github/workflows', workflowFile), 'utf8').replaceAll('\r\n', '\n');
  const body = `\n${text.split('\njobs:\n')[1]}`;
  return Object.fromEntries(
    body.split(/\n(?=  [\w-]+:\n)/)
      .filter(block => /^  [\w-]+:/.test(block))
      .map(block => [block.match(/^  ([\w-]+):/)[1], block]),
  );
}

const workflows = [
  ['ci.yml', readJobs('ci.yml')],
  ['real-e2e.yml', readJobs('real-e2e.yml')],
];

const allParsedJobs = workflows.flatMap(([file, jobs]) =>
  Object.entries(jobs).map(([name, block]) => ({ key: `${file}:${name}`, file, name, block })),
);

const expectedLightKeys = new Set([
  'ci.yml:policy',
  'ci.yml:l1',
  'ci.yml:e2e-plan',
  'ci.yml:coverage',
  'ci.yml:merge-gate',
  'real-e2e.yml:real-plan',
  'real-e2e.yml:real-report',
]);

const policyDependentLightKeys = new Set([
  'ci.yml:l1',
  'ci.yml:e2e-plan',
  'ci.yml:coverage',
  'ci.yml:merge-gate',
]);

const expectedCachedLightKeys = new Set([
  'ci.yml:l1',
  'ci.yml:e2e-plan',
  'real-e2e.yml:real-plan',
]);

const jobsByKey = new Map(allParsedJobs.map(job => [job.key, job]));
const lightJobs = [...expectedLightKeys].map(key => {
  const job = jobsByKey.get(key);
  assert.ok(job, `missing expected light job ${key}`);
  return job;
});

function evalExpression(expression, { event = 'pull_request', flag, policyFailed = false } = {}) {
  const policy = route(event, 'pr', 'jiuwenswarm', null, 'linux-windows', {
    selfHostedMergeQueue: flag === 'true',
  });
  return runInNewContext(expression, {
    github: { event_name: event },
    vars: flag === undefined ? {} : { CI_SELF_HOSTED_MERGE_QUEUE: flag },
    needs: {
      policy: {
        outputs: policyFailed ? {} : { self_hosted_merge_queue: String(policy.self_hosted_merge_queue) },
      },
    },
    fromJSON: JSON.parse,
  }, { timeout: 100 });
}

test('lightweight merge-queue jobs route to dedicated light slots only when merge_group and opt-in flag are both active', () => {
  for (const { key, block } of lightJobs) {
    const runsOnMatch = block.match(/^    runs-on: \$\{\{ (.+) \}\}$/m);
    assert.ok(runsOnMatch, `${key} must define a dynamic runs-on expression`);
    const expr = runsOnMatch[1];

    if (policyDependentLightKeys.has(key)) {
      assert.match(expr, /needs\.policy\.outputs\.self_hosted_merge_queue/, `${key} reuses policy output`);
      assert.doesNotMatch(block, /vars\.CI_SELF_HOSTED_MERGE_QUEUE/, `${key} does not re-read raw toggle`);
    }

    const routed = evalExpression(expr, { event: 'merge_group', flag: 'true' });
    assert.deepEqual(routed, [...LIGHT_RUNNER], `${key} merge_group + true`);
    assert.ok(routed.includes('sciencediscovery-light'), `${key} targets sciencediscovery-light`);
    assert.ok(!routed.includes('sciencediscovery'), `${key} must not target the heavy sciencediscovery pool`);

    for (const flag of [undefined, '', 'false', 'TRUE', '1']) {
      assert.equal(
        evalExpression(expr, { event: 'merge_group', flag }),
        'ubuntu-latest',
        `${key} merge_group + ${JSON.stringify(flag)}`,
      );
    }

    for (const event of NON_MERGE_QUEUE_EVENTS) {
      for (const flag of [undefined, '', 'false', 'true']) {
        assert.equal(
          evalExpression(expr, { event, flag }),
          'ubuntu-latest',
          `${key} ${event} + ${JSON.stringify(flag)}`,
        );
      }
    }
  }

  // merge-gate runs with if: always(); if policy fails and leaves outputs empty,
  // merge-gate falls back safely to ubuntu-latest.
  const gateExpr = jobsByKey.get('ci.yml:merge-gate').block.match(/^    runs-on: \$\{\{ (.+) \}\}$/m)[1];
  assert.equal(
    evalExpression(gateExpr, { event: 'merge_group', flag: 'true', policyFailed: true }),
    'ubuntu-latest',
  );
});

test('light jobs with pnpm setup skip remote setup-node cache only when routed to light slots', () => {
  for (const key of expectedCachedLightKeys) {
    const { block } = jobsByKey.get(key);
    const cacheMatch = block.match(/^          cache: \$\{\{ (.+) \}\}$/m);
    assert.ok(cacheMatch, `${key} must toggle setup-node cache dynamically`);
    const expr = cacheMatch[1];

    assert.equal(
      evalExpression(expr, { event: 'merge_group', flag: 'true' }),
      '',
      `${key} merge_group + true disables remote pnpm cache`,
    );

    for (const flag of [undefined, '', 'false', 'TRUE']) {
      assert.equal(
        evalExpression(expr, { event: 'merge_group', flag }),
        'pnpm',
        `${key} merge_group + ${JSON.stringify(flag)}`,
      );
    }

    for (const event of NON_MERGE_QUEUE_EVENTS) {
      assert.equal(
        evalExpression(expr, { event, flag: 'true' }),
        'pnpm',
        `${key} ${event} + true keeps remote pnpm cache`,
      );
    }
  }
});

test('light slots stay credential-free and isolated from every other job across both workflows', () => {
  for (const { key, block } of lightJobs) {
    assert.doesNotMatch(block, /\bsecrets\./, `${key} must not inject secrets onto light self-hosted slots`);
  }

  // Derive the full complement dynamically from every parsed job with runs-on
  // so any newly added heavy/desktop/distribution/real job is checked too.
  const nonLightWithRunsOn = allParsedJobs.filter(
    ({ key, block }) => !expectedLightKeys.has(key) && /^    runs-on:/m.test(block),
  );
  assert.ok(
    nonLightWithRunsOn.length >= 10,
    `expected at least 10 non-light jobs with runs-on, found ${nonLightWithRunsOn.length}`,
  );
  for (const { key, block } of nonLightWithRunsOn) {
    assert.doesNotMatch(block, /sciencediscovery-light/, `${key} must not target light slots`);
  }

  for (const key of ['real-e2e.yml:real-plan', 'real-e2e.yml:real-report']) {
    assert.match(
      jobsByKey.get(key).block,
      /^    if: .*github\.event_name != 'pull_request'/m,
      `${key} keeps PR guard`,
    );
  }
});

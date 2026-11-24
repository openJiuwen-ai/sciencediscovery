// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchLaunchEnvironment, ensureCleanCheckout, isolatedRetryConfig } from '../retry-runner.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

const createGitFixture = () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tagged-retry-'));
  execFileSync('git', ['init', '--quiet', fixture]);
  execFileSync('git', ['-C', fixture, 'config', 'user.email', 'ci@example.invalid']);
  execFileSync('git', ['-C', fixture, 'config', 'user.name', 'CI test']);
  writeFileSync(join(fixture, '.gitignore'), readFileSync(join(repositoryRoot, '.gitignore')));
  writeFileSync(join(fixture, 'tracked.txt'), 'clean\n');
  execFileSync('git', ['-C', fixture, 'add', '.gitignore', 'tracked.txt']);
  execFileSync('git', ['-C', fixture, 'commit', '--quiet', '-m', 'fixture']);
  return fixture;
};

const withCheckout = callback => {
  const fixture = createGitFixture();
  const logPath = join(tmpdir(), `tagged-retry-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  try {
    return callback(fixture, logPath);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(logPath, { force: true });
  }
};

const retryInputs = {
  repositoryRoot: '/repo',
  outputDir: '/results',
  resultsPath: '/results/retry',
  planPath: '/results/retry-plan.json',
  reportPath: '/results/retry-results.json',
  logPath: '/results/retry.log',
  instance: 'mocked-research-retry',
  backend: 'jiuwenswarm',
  slice: 'e2e',
};

test('isolated retry config preserves a non-standard fixture', () => {
  const config = isolatedRetryConfig({
    ...retryInputs,
    batch: { group: 'mocked', fixture: 'research', checks: [] },
  });

  assert.deepEqual(batchLaunchEnvironment(config.launchConfig), {
    CI_E2E_FIXTURE: 'research',
    CI_E2E_SWARM_CHECKS: 'off',
    E2E_SCIENTIFIC_ENVS: '1',
  });
});

test('isolated retry config preserves disabled swarm checks', () => {
  const config = isolatedRetryConfig({
    ...retryInputs,
    batch: { group: 'mocked', fixture: 'standard', checks: [] },
  });

  assert.equal(config.launchConfig.checks, 'off');
  assert.equal(batchLaunchEnvironment(config.launchConfig).CI_E2E_SWARM_CHECKS, 'off');
});

test('generated real E2E runtime files do not block isolated retry', () => {
  withCheckout((fixture, logPath) => {
    mkdirSync(join(fixture, '.ci-runtime', 'real-e2e'), { recursive: true });
    writeFileSync(join(fixture, '.ci-runtime', 'real-e2e', 'marker'), 'generated\n');

    assert.equal(ensureCleanCheckout(fixture, logPath), true);
  });
});

test('tracked checkout changes block isolated retry', () => {
  withCheckout((fixture, logPath) => {
    writeFileSync(join(fixture, 'tracked.txt'), 'changed\n');

    assert.equal(ensureCleanCheckout(fixture, logPath), false);
    assert.match(readFileSync(logPath, 'utf8'), /tracked\.txt/);
  });
});

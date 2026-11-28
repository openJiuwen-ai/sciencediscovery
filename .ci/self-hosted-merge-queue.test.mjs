// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTest } from '../test/support/tagged/compat.mjs';
import { createPlan, subplan, verifyResults } from '../test/support/tagged/plan.mjs';
import {
  mockedBatches,
  mockedExecutionLanes,
  mockedLocalConcurrency,
  mockedShards,
  mockedSlotEnvironment,
  PARALLEL_MOCKED_SHARDS,
  swarmChecks,
} from '../test/support/tagged/execution.mjs';
import { sharedCacheEnv } from '../test/support/tagged/shared.mjs';
import { SELF_HOSTED_MOCKED_SHARDS, buildMockedMatrix } from './mocked-matrix.mjs';
import { reconcileMocked } from './mocked-report.mjs';
import { SELF_HOSTED_RUNNER, route } from './tier-policy.mjs';

const { test } = createTest(import.meta.url, { tags: ['category:ut', 'os:linux', 'arch:amd64'] });
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(repository, '.github/workflows/ci.yml'), 'utf8').replaceAll('\r\n', '\n');
const jobs = Object.fromEntries(
  workflow.split('\njobs:\n')[1].split(/\n(?=  [\w-]+:\n)/).slice(1)
    .map(block => [block.match(/^  ([\w-]+):/)[1], block]),
);

const descriptor = (id, extra = []) => ({
  id,
  source: `test/${id}.spec.ts`,
  sourceHash: 'a'.repeat(64),
  runner: 'playwright',
  tags: ['category:e2e', 'os:linux', 'arch:amd64', 'model:mock', ...extra],
});

const fiveShardPlan = () => createPlan([
  descriptor('fresh', ['isolation:fresh']),
  descriptor('settings', ['isolation:global']),
  descriptor('journey', ['isolation:session']),
  descriptor('research', ['fixture:research']),
  descriptor('literature', ['fixture:literature']),
  descriptor('governed', ['fixture:governed']),
], {
  revision: 'candidate',
  profile: 'merge',
  targets: [{ os: 'linux', arch: 'amd64' }],
  execution: { backend: 'jiuwenswarm' },
});

test('only merge_group with explicit toggle routes UT to self-hosted runners', () => {
  const enabled = route('merge_group', 'pr', 'jiuwenswarm', null, 'linux-windows', {
    selfHostedMergeQueue: true,
  });
  assert.equal(enabled.profile, 'merge');
  assert.equal(enabled.self_hosted_merge_queue, true);
  assert.deepEqual(JSON.parse(enabled.ut_runner), [...SELF_HOSTED_RUNNER]);

  const disabled = route('merge_group', 'pr', 'jiuwenswarm', null, 'linux-windows', {
    selfHostedMergeQueue: false,
  });
  assert.equal(disabled.self_hosted_merge_queue, false);
  assert.equal(JSON.parse(disabled.ut_runner), 'ubuntu-latest');

  const defaultOff = route('merge_group');
  assert.equal(defaultOff.self_hosted_merge_queue, false);
  assert.equal(JSON.parse(defaultOff.ut_runner), 'ubuntu-latest');

  for (const event of ['pull_request', 'workflow_dispatch', 'workflow_call', 'schedule', 'push']) {
    for (const profile of ['pr', 'merge', 'daily', 'release', 'package']) {
      const policy = route(event, profile, 'jiuwenswarm', null, 'linux-windows', {
        selfHostedMergeQueue: true,
      });
      assert.equal(policy.self_hosted_merge_queue, false, `${event}/${profile}`);
      assert.equal(JSON.parse(policy.ut_runner), 'ubuntu-latest', `${event}/${profile}`);
    }
  }
});

test('mocked E2E matrix routes every mocked shard to self-hosted when enabled', () => {
  const plan = fiveShardPlan();
  const hosted = buildMockedMatrix(plan, { selfHostedMergeQueue: false });
  assert.equal(hosted.include.length, 5);
  for (const entry of hosted.include) {
    assert.equal(entry.runner, 'ubuntu-latest', entry.shard);
    assert.equal(entry.self_hosted, false, entry.shard);
    assert.equal(entry.local_concurrency, PARALLEL_MOCKED_SHARDS.has(entry.shard) ? 2 : 1, entry.shard);
  }

  const routed = buildMockedMatrix(plan, { selfHostedMergeQueue: true });
  assert.equal(routed.include.length, 5);
  const byShard = Object.fromEntries(routed.include.map(entry => [entry.shard, entry]));
  for (const shard of ['standard-config', 'standard-journeys', 'research', 'governed', 'literature']) {
    assert.ok(SELF_HOSTED_MOCKED_SHARDS.has(shard), shard);
    assert.deepEqual(byShard[shard].runner, [...SELF_HOSTED_RUNNER], shard);
    assert.equal(byShard[shard].self_hosted, true, shard);
    assert.equal(byShard[shard].local_concurrency, PARALLEL_MOCKED_SHARDS.has(shard) ? 2 : 1, shard);
  }
});

test('tier-policy and mocked-matrix CLIs propagate CI_SELF_HOSTED_MERGE_QUEUE accurately', t => {
  const parent = join(repository, '.tmp', 'self-hosted-merge-queue-tests');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const eventPath = join(root, 'event.json');
  writeFileSync(eventPath, JSON.stringify({}));
  for (const [name, eventName, flag, expectedSelfHosted, expectedUtRunner] of [
    ['mg-on', 'merge_group', 'true', 'true', JSON.stringify(SELF_HOSTED_RUNNER)],
    ['mg-off', 'merge_group', 'false', 'false', '"ubuntu-latest"'],
    ['dispatch-on', 'workflow_dispatch', 'true', 'false', '"ubuntu-latest"'],
  ]) {
    const out = join(root, `${name}.out`);
    const result = spawnSync(process.execPath, [join(repository, '.ci/tier-policy.mjs')], {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: out,
        CI_REQUESTED_PROFILE: 'merge',
        CI_DIFF_ENABLED: 'false',
        CI_SELF_HOSTED_MERGE_QUEUE: flag,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(out, 'utf8');
    assert.match(text, new RegExp(`^self_hosted_merge_queue=${expectedSelfHosted}$`, 'm'));
    assert.ok(text.includes(`ut_runner=${expectedUtRunner}\n`), text);
  }

  const planPath = join(root, 'plan.json');
  writeFileSync(planPath, JSON.stringify(fiveShardPlan()));
  for (const [name, flag, expectedSelfHosted] of [
    ['matrix-on', 'true', 5],
    ['matrix-off', 'false', 0],
  ]) {
    const out = join(root, `${name}.out`);
    const result = spawnSync(process.execPath, [join(repository, '.ci/mocked-matrix.mjs'), planPath], {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: out,
        CI_SELF_HOSTED_MERGE_QUEUE: flag,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const line = readFileSync(out, 'utf8').trim();
    assert.ok(line.startsWith('matrix='), line);
    const matrix = JSON.parse(line.slice('matrix='.length));
    assert.equal(matrix.include.filter(entry => entry.self_hosted).length, expectedSelfHosted);
  }
});

test('ci.yml wires merge-queue self-hosted routing, cache toggles and idempotent bwrap check', () => {
  assert.match(jobs.policy, /self_hosted_merge_queue: \$\{\{ steps\.policy\.outputs\.self_hosted_merge_queue \}\}/);
  assert.match(jobs.policy, /ut_runner: \$\{\{ steps\.policy\.outputs\.ut_runner \}\}/);
  assert.match(jobs.policy, /CI_SELF_HOSTED_MERGE_QUEUE: \$\{\{ vars\.CI_SELF_HOSTED_MERGE_QUEUE \}\}/);

  assert.match(jobs['e2e-plan'], /CI_SELF_HOSTED_MERGE_QUEUE: \$\{\{ needs\.policy\.outputs\.self_hosted_merge_queue \}\}/);
  assert.doesNotMatch(jobs['e2e-plan'], /vars\.CI_SELF_HOSTED_MERGE_QUEUE/);

  assert.match(jobs.ut, /runs-on: \$\{\{ fromJSON\(needs\.policy\.outputs\.ut_runner\) \}\}/);
  assert.match(jobs.ut, /cache: \$\{\{ needs\.policy\.outputs\.self_hosted_merge_queue != 'true' && 'pnpm' \|\| '' \}\}/);
  assert.match(jobs.ut, /enable-cache: \$\{\{ needs\.policy\.outputs\.self_hosted_merge_queue != 'true' \}\}/);
  assert.match(jobs.ut, /if ! bwrap --unshare-user --ro-bind \/ \/ --dev \/dev true 2>\/dev\/null; then/);
  assert.match(jobs.ut, /name: Cache the JiuwenSwarm install\n\s+if: \$\{\{ needs\.policy\.outputs\.self_hosted_merge_queue != 'true' \}\}/);
  assert.match(jobs.ut, /name: Use local JiuwenSwarm cache\n\s+if: \$\{\{ needs\.policy\.outputs\.self_hosted_merge_queue == 'true' \}\}[\s\S]*?run: bash \.ci\/use-local-swarm-cache\.sh/);

  assert.match(jobs.e2e, /max-parallel: 5/);
  assert.match(jobs.e2e, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(jobs.e2e, /CI_E2E_LOCAL_CONCURRENCY: \$\{\{ matrix\.local_concurrency \}\}/);
  assert.match(jobs.e2e, /cache: \$\{\{ !matrix\.self_hosted && 'pnpm' \|\| '' \}\}/);
  assert.match(jobs.e2e, /enable-cache: \$\{\{ !matrix\.self_hosted \}\}/);
  assert.match(jobs.e2e, /if ! bwrap --unshare-user --ro-bind \/ \/ --dev \/dev true 2>\/dev\/null; then/);
  assert.match(jobs.e2e, /name: Cache the pinned Chromium\n\s+if: \$\{\{ !matrix\.self_hosted \}\}/);
  assert.match(jobs.e2e, /name: Cache the JiuwenSwarm install\n\s+if: \$\{\{ !matrix\.self_hosted \}\}/);
  assert.match(jobs.e2e, /name: Use local JiuwenSwarm cache\n\s+if: \$\{\{ matrix\.self_hosted \}\}[\s\S]*?run: bash \.ci\/use-local-swarm-cache\.sh/);

  for (const jobName of ['l1', 'e2e-plan', 'coverage', 'merge-gate']) {
    assert.match(
      jobs[jobName],
      /runs-on: \$\{\{ fromJSON\(needs\.policy\.outputs\.self_hosted_merge_queue == 'true' && '\["self-hosted","Linux","X64","sciencediscovery-light"\]' \|\| '"ubuntu-latest"'\) \}\}/,
      jobName,
    );
  }
  // ST and Desktop share UT's pool, with the same cache and no-sudo adaptations.
  for (const jobName of ['st', 'desktop-mocked']) {
    assert.match(jobs[jobName], /runs-on: \$\{\{ fromJSON\(needs\.policy\.outputs\.ut_runner\) \}\}/, jobName);
    assert.match(jobs[jobName], /cache: \$\{\{ needs\.policy\.outputs\.self_hosted_merge_queue != 'true' && 'pnpm' \|\| '' \}\}/, jobName);
  }
  assert.match(jobs.st, /enable-cache: \$\{\{ needs\.policy\.outputs\.self_hosted_merge_queue != 'true' \}\}/);
  assert.match(jobs.st, /if ! bwrap --unshare-user --ro-bind \/ \/ --dev \/dev true 2>\/dev\/null; then/);
  assert.match(jobs.st, /name: Cache the pinned CPython archive\n\s+if: \$\{\{ needs\.policy\.outputs\.self_hosted_merge_queue != 'true' \}\}/);
  assert.match(jobs.st, /BINARY_CACHE_DIR: \$\{\{ needs\.policy\.outputs\.self_hosted_merge_queue == 'true' && '\/ci-cache\/binary-cache' \|\| format\('\{0\}\/binary-cache', runner\.temp\) \}\}/);
  assert.match(jobs['desktop-mocked'], /SELF_HOSTED: \$\{\{ needs\.policy\.outputs\.self_hosted_merge_queue \}\}/);
  assert.match(jobs['desktop-mocked'], /playwright install chromium\n\s+else\n\s+\.e2e\/node_modules\/\.bin\/playwright install --with-deps chromium/);
  assert.match(jobs.docker, /runs-on: ubuntu-latest/);
  assert.match(jobs.binary, /runner: ubuntu-latest/);
  assert.match(jobs.binary, /runner: ubuntu-24\.04-arm/);
  assert.doesNotMatch(jobs.binary, /self-hosted/);
});

test('sharedCacheEnv falls back to workspace caches when unset and honors container cache env vars', () => {
  const fallback = sharedCacheEnv({}, '/workspace');
  assert.deepEqual(fallback, {
    UV_CACHE_DIR: '/workspace/.tmp/cache/uv',
    UV_PYTHON_INSTALL_DIR: '/workspace/.tmp/python',
    npm_config_cache: '/workspace/.tmp/cache/npm',
    PLAYWRIGHT_BROWSERS_PATH: '/workspace/.e2e/browsers',
  });

  const container = sharedCacheEnv({
    UV_CACHE_DIR: '/ci-cache/uv-cache',
    UV_PYTHON_INSTALL_DIR: '/opt/uv-python',
    npm_config_cache: '/ci-cache/npm-cache',
    PLAYWRIGHT_BROWSERS_PATH: '/ci-cache/ms-playwright',
  }, '/workspace');
  assert.deepEqual(container, {
    UV_CACHE_DIR: '/ci-cache/uv-cache',
    UV_PYTHON_INSTALL_DIR: '/opt/uv-python',
    npm_config_cache: '/ci-cache/npm-cache',
    PLAYWRIGHT_BROWSERS_PATH: '/ci-cache/ms-playwright',
  });
});

test('use-local-swarm-cache.sh populates once, reuses warm cache, cleans failures and rejects bad keys', t => {
  const parent = join(repository, '.tmp', 'self-hosted-merge-queue-tests');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'swarm-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, '.ci'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(join(repository, '.ci/use-local-swarm-cache.sh'), join(root, '.ci/use-local-swarm-cache.sh'));
  chmodSync(join(root, '.ci/use-local-swarm-cache.sh'), 0o755);

  const callsFile = join(root, 'setup-calls.log');
  const uvCallsFile = join(root, 'uv-calls.log');
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'uv'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${uvCallsFile}"
`, { mode: 0o755 });
  const stubScript = join(root, 'scripts/jiuwenswarm.sh');
  writeFileSync(stubScript, `#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s|%s\\n' "$1" "\${SCIENCE_AGENT_JIUWENSWARM_OVERRIDES:-}" "\${JIUWENSWARM_SRC:-}" >> "${callsFile}"
if [[ "\${FAIL_STUB:-0}" == "1" ]]; then
  mkdir -p "$JIUWENSWARM_SRC/.git"
  printf 'partial' > "$JIUWENSWARM_SRC/partial.txt"
  exit 1
fi
mkdir -p "$JIUWENSWARM_SRC/.git" "$JIUWENSWARM_SRC/.venv/bin"
cat <<'EOF' > "$JIUWENSWARM_SRC/.venv/bin/jiuwenswarm-start"
#!/usr/bin/env bash
exit 0
EOF
cat <<'EOF' > "$JIUWENSWARM_SRC/.venv/bin/python"
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$JIUWENSWARM_SRC/.venv/bin/jiuwenswarm-start" "$JIUWENSWARM_SRC/.venv/bin/python"
`, { mode: 0o755 });

  const cacheDir = join(root, 'ci-cache');
  const expectedTarget = join(cacheDir, 'jiuwenswarm', 'test-key-01', 'src');
  const testPath = `${binDir}:${process.env.PATH ?? ''}`;

  // Cold cache populates target, removes .git, pre-installs pytest under lock,
  // creates .ready, and exports only JIUWENSWARM_SRC.
  const envCold = join(root, 'github-env-cold');
  writeFileSync(envCold, '');
  const cold = spawnSync('bash', [join(root, '.ci/use-local-swarm-cache.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: testPath,
      SD_CI_CACHE_DIR: cacheDir,
      CI_SWARM_CACHE_KEY: 'test-key-01',
      GITHUB_ENV: envCold,
    },
  });
  assert.equal(cold.status, 0, cold.stderr);
  assert.equal(readFileSync(callsFile, 'utf8').trim(), `setup|1|${expectedTarget}`);
  assert.equal(
    readFileSync(uvCallsFile, 'utf8').trim(),
    `pip install --python ${expectedTarget}/.venv/bin/python pytest>=8.3.5`,
  );
  assert.equal(existsSync(join(expectedTarget, '.git')), false);
  assert.equal(existsSync(join(expectedTarget, '.venv/bin/jiuwenswarm-start')), true);
  assert.equal(existsSync(join(cacheDir, 'jiuwenswarm', 'test-key-01', '.ready')), true);
  assert.equal(readFileSync(envCold, 'utf8'), `JIUWENSWARM_SRC=${expectedTarget}\n`);

  // Warm cache hits fast path without re-running setup or uv pip install.
  const envWarm = join(root, 'github-env-warm');
  writeFileSync(envWarm, '');
  const warm = spawnSync('bash', [join(root, '.ci/use-local-swarm-cache.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: testPath,
      SD_CI_CACHE_DIR: cacheDir,
      CI_SWARM_CACHE_KEY: 'test-key-01',
      GITHUB_ENV: envWarm,
    },
  });
  assert.equal(warm.status, 0, warm.stderr);
  assert.equal(readFileSync(callsFile, 'utf8').trim().split('\n').length, 1);
  assert.equal(readFileSync(uvCallsFile, 'utf8').trim().split('\n').length, 1);
  assert.equal(readFileSync(envWarm, 'utf8'), `JIUWENSWARM_SRC=${expectedTarget}\n`);

  // Failed cold build cleans partial target and leaves GITHUB_ENV untouched.
  const envFail = join(root, 'github-env-fail');
  writeFileSync(envFail, '');
  const failed = spawnSync('bash', [join(root, '.ci/use-local-swarm-cache.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SD_CI_CACHE_DIR: cacheDir,
      CI_SWARM_CACHE_KEY: 'test-key-fail',
      FAIL_STUB: '1',
      GITHUB_ENV: envFail,
    },
  });
  assert.notEqual(failed.status, 0);
  assert.equal(existsSync(join(cacheDir, 'jiuwenswarm', 'test-key-fail', 'src')), false);
  assert.equal(existsSync(join(cacheDir, 'jiuwenswarm', 'test-key-fail', '.ready')), false);
  assert.equal(readFileSync(envFail, 'utf8'), '');

  // Path traversal keys are rejected before touching the cache directory.
  const badKey = spawnSync('bash', [join(root, '.ci/use-local-swarm-cache.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SD_CI_CACHE_DIR: cacheDir,
      CI_SWARM_CACHE_KEY: '../escape',
    },
  });
  assert.notEqual(badKey.status, 0);
  assert.match(badKey.stderr, /Invalid CI_SWARM_CACHE_KEY/);
});

test('mockedExecutionLanes balances standard shards across 2 isolated lanes without splitting spec files', () => {
  assert.equal(mockedLocalConcurrency(undefined), 1);
  assert.equal(mockedLocalConcurrency('1'), 1);
  assert.equal(mockedLocalConcurrency('2'), 2);
  for (const invalid of ['0', '-1', '3', 'abc']) {
    assert.throws(() => mockedLocalConcurrency(invalid), /CI_E2E_LOCAL_CONCURRENCY/);
  }

  const makeEntry = (id, source, extra = []) => ({
    id,
    source,
    sourceHash: 'a'.repeat(64),
    runner: 'playwright',
    tags: ['category:e2e', 'os:linux', 'arch:amd64', 'model:mock', ...extra],
  });

  // standard-journeys with 4 spec files (including multi-test files) splits into 2 lanes.
  const journeysPlan = createPlan([
    makeEntry('j1a', 'test/j1.spec.ts', ['isolation:session']),
    makeEntry('j1b', 'test/j1.spec.ts', ['isolation:session']),
    makeEntry('j1c', 'test/j1.spec.ts', ['isolation:session']),
    makeEntry('j2a', 'test/j2.spec.ts', ['isolation:session']),
    makeEntry('j2b', 'test/j2.spec.ts', ['isolation:session']),
    makeEntry('j3a', 'test/j3.spec.ts', ['isolation:session']),
    makeEntry('j4a', 'test/j4.spec.ts', ['isolation:session']),
  ], {
    revision: 'candidate',
    profile: 'merge',
    targets: [{ os: 'linux', arch: 'amd64' }],
    execution: { backend: 'jiuwenswarm' },
  });
  assert.equal(mockedExecutionLanes(journeysPlan, 1).length, 1);
  const journeyLanes = mockedExecutionLanes(journeysPlan, 2);
  assert.equal(journeyLanes.length, 2);
  assert.deepEqual(journeyLanes.map(lane => lane.map(b => b.key)), [
    ['mocked-standard-journeys'],
    ['mocked-standard-journeys-2'],
  ]);
  const jSources0 = new Set(journeyLanes[0][0].entries.map(e => e.source));
  const jSources1 = new Set(journeyLanes[1][0].entries.map(e => e.source));
  for (const source of jSources0) assert.equal(jSources1.has(source), false, `split spec file: ${source}`);
  assert.deepEqual(
    journeyLanes.flat().flatMap(b => b.entries.map(e => e.key)).sort(),
    journeysPlan.entries.map(e => e.key).sort(),
  );

  // Single-file standard-journeys stays 1 lane even with concurrency=2.
  const singleFileJourneys = createPlan([
    makeEntry('only1', 'test/only.spec.ts', ['isolation:session']),
    makeEntry('only2', 'test/only.spec.ts', ['isolation:session']),
  ], {
    revision: 'candidate',
    profile: 'pr',
    targets: [{ os: 'linux', arch: 'amd64' }],
    execution: { backend: 'jiuwenswarm' },
  });
  assert.equal(mockedExecutionLanes(singleFileJourneys, 2).length, 1);

  // standard-config puts checks ONLY on lane 0 (mocked-standard-config-global) and
  // keeps mocked-standard-config-fresh in its own pristine batch on lane 1.
  const configPlan = createPlan([
    makeEntry('fresh1', 'test/fresh.spec.ts', ['isolation:fresh']),
    makeEntry('g1a', 'test/g1.spec.ts', ['isolation:global']),
    makeEntry('g1b', 'test/g1.spec.ts', ['isolation:global']),
    makeEntry('g2a', 'test/g2.spec.ts', ['isolation:global']),
    makeEntry('g2b', 'test/g2.spec.ts', ['isolation:global']),
    makeEntry('g3a', 'test/g3.spec.ts', ['isolation:global']),
    makeEntry('g4a', 'test/g4.spec.ts', ['isolation:global']),
  ], {
    revision: 'candidate',
    profile: 'merge',
    targets: [{ os: 'linux', arch: 'amd64' }],
    execution: { backend: 'jiuwenswarm' },
  });
  const configLanes = mockedExecutionLanes(configPlan, 2);
  assert.equal(configLanes.length, 2);
  assert.deepEqual(configLanes.map(lane => lane.map(b => b.key)), [
    ['mocked-standard-config-global'],
    ['mocked-standard-config-fresh', 'mocked-standard-config-global-2'],
  ]);
  assert.deepEqual(configLanes[0][0].checks, swarmChecks);
  assert.deepEqual(configLanes[1][0].checks, []);
  assert.deepEqual(configLanes[1][1].checks, []);
  assert.ok(configLanes[1][0].entries.every(e => e.tags.includes('isolation:fresh')));
  const gSources0 = new Set(configLanes[0][0].entries.map(e => e.source));
  const gSources1 = new Set(configLanes[1][1].entries.map(e => e.source));
  for (const source of gSources0) assert.equal(gSources1.has(source), false, `split global spec: ${source}`);
  assert.deepEqual(
    configLanes.flat().flatMap(b => b.entries.map(e => e.key)).sort(),
    configPlan.entries.map(e => e.key).sort(),
  );

  // research shard never splits even with concurrency=2.
  const researchPlan = createPlan([
    makeEntry('r1', 'test/r1.spec.ts', ['fixture:research']),
    makeEntry('r2', 'test/r2.spec.ts', ['fixture:research']),
  ], {
    revision: 'candidate',
    profile: 'merge',
    targets: [{ os: 'linux', arch: 'amd64' }],
    execution: { backend: 'jiuwenswarm' },
  });
  assert.equal(mockedExecutionLanes(researchPlan, 2).length, 1);
});

test('mockedSlotEnvironment assigns disjoint port blocks and reconcileMocked audits sub-lane checks', t => {
  const s0 = mockedSlotEnvironment(0, { swarmStartLock: '/tmp/lock', viteCacheDir: '/tmp/v0' });
  const s1 = mockedSlotEnvironment(1, { swarmStartLock: '/tmp/lock', viteCacheDir: '/tmp/v1' });
  const portsOf = slot => [
    Number(slot.SCIENCE_AGENT_PORT),
    Number(slot.SCIENCE_AGENT_PORT) + 5,
    Number(slot.SCIENCE_AGENT_LEGACY_PORT),
    Number(slot.SCIENCE_AGENT_RUNNER_PORT),
    Number(slot.SCIENCE_AGENT_MEMORY_GRAPH_PORT),
    Number(slot.E2E_DESKTOP_PORT),
  ];
  const allPorts = [...portsOf(s0), ...portsOf(s1)];
  assert.equal(new Set(allPorts).size, allPorts.length, 'slots must have zero port overlap');
  assert.equal(s0.CI_E2E_SWARM_START_LOCK, '/tmp/lock');
  assert.equal(s1.E2E_DESKTOP_VITE_CACHE_DIR, '/tmp/v1');

  // Verify run-e2e.sh closes fd 8 on child JiuwenSwarm commands so daemons never hold the lock.
  const runE2e = readFileSync(join(repository, '.ci/run-e2e.sh'), 'utf8');
  assert.match(runE2e, /CI_E2E_SWARM_START_LOCK/);
  assert.match(runE2e, /scripts\/jiuwenswarm\.sh" start 8>&-/);
  assert.match(runE2e, /release_swarm_lock/);

  // Verify reconcileMocked allows clean sub-lane directories and rejects stray checks inside them.
  const parent = join(repository, '.tmp', 'self-hosted-merge-queue-tests');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'reconcile-lanes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const p = fiveShardPlan();
  const pass = e => ({ key: e.key, outcome: 'PASS', actualTarget: e.target, actualBackend: e.backend });
  for (const shard of mockedShards(p)) {
    const base = join(root, `mocked-e2e-results-${shard.name}`);
    const dir = join(base, 'e2e/tagged');
    mkdirSync(dir, { recursive: true });
    const worker = subplan(p, p.entries.filter(e => shard.keys.includes(e.key)));
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(worker));
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(verifyResults(worker, worker.entries.map(pass))));
  }
  for (const batch of mockedBatches(p).filter(b => b.checks.length)) {
    const checkDir = join(root, `mocked-e2e-results-${batch.shard}`, batch.key, 'e2e');
    mkdirSync(checkDir, { recursive: true });
    writeFileSync(join(checkDir, 'jiuwenswarm-checks.json'), JSON.stringify(batch.checks.map(name => ({ name, outcome: 'PASS' }))));
  }
  // Sub-lane directory without checks passes reconciliation.
  const subLaneDir = join(root, 'mocked-e2e-results-standard-config', 'mocked-standard-config-global-2', 'e2e');
  mkdirSync(subLaneDir, { recursive: true });
  assert.equal(reconcileMocked(p, root).status, 'PASS');
  // Stray checks inside sub-lane directory fail reconciliation with UNEXPECTED_SWARM_CHECKS.
  writeFileSync(join(subLaneDir, 'jiuwenswarm-checks.json'), JSON.stringify(swarmChecks.map(name => ({ name, outcome: 'PASS' }))));
  const bad = reconcileMocked(p, root);
  assert.equal(bad.exitCode, 1);
  assert.ok(bad.problems.some(msg => msg.includes('UNEXPECTED_SWARM_CHECKS')));
});

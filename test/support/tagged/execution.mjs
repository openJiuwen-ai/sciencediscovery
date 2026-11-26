// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

// Execution settings are independent of the case selector. In particular a
// backend cannot filter out cases that it does not implement.
export function backendName(value = 'jiuwenswarm') {
  if (!['jiuwenswarm', 'legacy'].includes(value)) throw new Error(`Unknown E2E backend: ${value}; use jiuwenswarm or legacy (native)`);
  return value;
}

export function executionConfig(env = process.env, backend = env.CI_E2E_BACKEND ?? 'jiuwenswarm') {
  return {
    backend: backendName(backend),
    model: env.E2E_LLM_MODEL ?? null,
    judge: env.E2E_JUDGE_MODEL ?? null,
  };
}

// Keep short API scenarios in one serialized worker; long research cases each
// receive an isolated job. The source plan, never a workflow case list, owns
// this partition. Even a quarantined required case gets a worker and a verdict.
export function biomniCase(entry) {
  if (entry.source !== 'test/biomnibench-da-swarm.spec.ts') return undefined;
  const id = decodeURIComponent(entry.id).match(/BiomniBench-(da-\d+-\d+)\b/)?.[1];
  if (!id) throw new Error('INVALID_BIOMNI_CASE_IDENTITY');
  return id;
}

export function realShards(plan) {
  const basic = plan.entries.filter(e => e.tags.includes('tier:l3'));
  const research = plan.entries.filter(e => !e.tags.includes('tier:l3'));
  return [
    ...(basic.length ? [{ name: 'basic', keys: basic.map(e => e.key) }] : []),
    ...research.map((e, i) => ({ name: `research-${i + 1}`, keys: [e.key] })),
  ];
}

export const swarmChecks = ['history', 'history-names', 'run-shell', 'host-tools', 'approvals', 'skills', 'skill-switch', 'trajectory', 'language'];
export const PARALLEL_MOCKED_SHARDS = Object.freeze(new Set(['standard-config', 'standard-journeys']));
export const MAX_MOCKED_LOCAL_CONCURRENCY = 2;

export function mockedLocalConcurrency(value = '1') {
  const text = String(value ?? '1').trim() || '1';
  if (!/^[1-9][0-9]*$/.test(text) || Number(text) > MAX_MOCKED_LOCAL_CONCURRENCY) {
    throw new Error(`CI_E2E_LOCAL_CONCURRENCY must be an integer from 1 to ${MAX_MOCKED_LOCAL_CONCURRENCY}`);
  }
  return Number(text);
}

/**
 * Partition plan entries across `lanes` buckets without ever splitting a spec
 * file. Uses greedy longest-file-first balancing seeded by `initialWeights` so
 * a lane carrying extra work (such as fresh-stack setup or JiuwenSwarm checks)
 * receives proportionally fewer spec entries.
 */
export function splitEntriesByFile(entries, lanes, initialWeights = []) {
  const byFile = new Map();
  const order = new Map();
  entries.forEach((entry, index) => {
    order.set(entry.key, index);
    const list = byFile.get(entry.source) ?? [];
    list.push(entry);
    byFile.set(entry.source, list);
  });
  const count = Math.min(lanes, byFile.size);
  if (count <= 1) return entries.length ? [entries] : [];
  const buckets = Array.from({ length: count }, (_, index) => ({
    weight: Number(initialWeights[index] ?? 0),
    entries: [],
  }));
  const groups = [...byFile.entries()]
    .map(([source, items]) => ({ source, items }))
    .sort((a, b) => b.items.length - a.items.length || a.source.localeCompare(b.source));
  for (let idx = 0; idx < groups.length; idx++) {
    const group = groups[idx];
    const remaining = groups.length - idx;
    const empty = buckets.filter(bucket => bucket.entries.length === 0);
    const candidates = empty.length === remaining ? empty : buckets;
    let target = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].weight < target.weight) target = candidates[i];
    }
    target.entries.push(...group.items);
    target.weight += group.items.length;
  }
  return buckets
    .map(bucket => bucket.entries.sort((a, b) => order.get(a.key) - order.get(b.key)))
    .filter(bucket => bucket.length > 0);
}

/**
 * Group mocked batches into concurrent local execution lanes. Each lane owns
 * one disjoint port block and runs its batches sequentially, so every stack
 * retains full service isolation and Playwright `workers: 1`.
 */
export function mockedExecutionLanes(plan, concurrency = 1) {
  const limit = mockedLocalConcurrency(concurrency);
  const batches = mockedBatches(plan);
  if (limit <= 1 || !batches.length) return batches.length ? [batches] : [];

  const shardNames = [...new Set(batches.map(batch => batch.shard))];
  if (shardNames.length === 1) {
    const shard = shardNames[0];
    if (!PARALLEL_MOCKED_SHARDS.has(shard)) return [batches];
    if (shard === 'standard-config') {
      const fresh = batches.find(batch => batch.key === 'mocked-standard-config-fresh');
      const global = batches.find(batch => batch.key === 'mocked-standard-config-global');
      if (!global) return [batches];
      const parts = splitEntriesByFile(global.entries, limit, [
        global.checks.length,
        fresh?.entries.length ?? 0,
      ]);
      if (parts.length <= 1) return fresh ? [[global], [fresh]] : [[global]];
      const lanes = [
        [{ ...global, key: 'mocked-standard-config-global', entries: parts[0], checks: global.checks }],
        [
          ...(fresh ? [fresh] : []),
          { ...global, key: 'mocked-standard-config-global-2', entries: parts[1], checks: [] },
        ],
      ];
      return lanes.filter(lane => lane.length > 0);
    }
    const batch = batches[0];
    const parts = splitEntriesByFile(batch.entries, limit);
    if (parts.length <= 1) return [[batch]];
    return parts.map((entries, index) => [{
      ...batch,
      key: index === 0 ? batch.key : `${batch.key}-${index + 1}`,
      entries,
      checks: index === 0 ? batch.checks : [],
    }]);
  }

  // Unsharded local run with explicit concurrency > 1: spread existing batches
  // across `limit` lanes without splitting individual batches further.
  const lanes = Array.from({ length: Math.min(limit, batches.length) }, () => ({ weight: 0, items: [] }));
  for (const batch of batches) {
    let target = lanes[0];
    for (let i = 1; i < lanes.length; i++) {
      if (lanes[i].weight < target.weight) target = lanes[i];
    }
    target.items.push(batch);
    target.weight += batch.entries.length + batch.checks.length;
  }
  return lanes.map(lane => lane.items).filter(lane => lane.length > 0);
}

/** Disjoint loopback port block and lock/cache env for concurrent local stacks. */
export function mockedSlotEnvironment(slot, { swarmStartLock, viteCacheDir } = {}) {
  const offset = slot * 10;
  return {
    SCIENCE_AGENT_PORT: String(4410 + offset),
    SCIENCE_AGENT_LEGACY_PORT: String(4510 + offset),
    SCIENCE_AGENT_RUNNER_PORT: String(4411 + offset),
    SCIENCE_AGENT_MEMORY_GRAPH_PORT: String(17774 + offset),
    E2E_DESKTOP_PORT: String(4178 + slot),
    ...(swarmStartLock ? { CI_E2E_SWARM_START_LOCK: swarmStartLock } : {}),
    ...(viteCacheDir ? { E2E_DESKTOP_VITE_CACHE_DIR: viteCacheDir } : {}),
  };
}

// Tags describe isolation requirements, not a second list of CI test names.
// Keep each file together: file/suite hooks and ordered journeys share a worker.
export function mockedShards(plan) {
  const groups = new Map(), files = new Map();
  for (const entry of plan.entries) {
    if (entry.runner !== 'playwright' || !entry.tags.includes('category:e2e') || entry.tags.includes('model:real')) throw new Error(`NOT_MOCKED_BROWSER_CASE: ${entry.id}`);
    const fixture = entry.tags.find(t => t.startsWith('fixture:'))?.split(':')[1];
    const isolation = entry.tags.find(t => t.startsWith('isolation:'))?.split(':')[1];
    let name = fixture;
    if (fixture === 'standard') {
      if (!['fresh', 'global', 'session'].includes(isolation)) throw new Error(`MOCKED_ISOLATION_REQUIRED: ${entry.id}`);
      name = isolation === 'session' ? 'standard-journeys' : 'standard-config';
    } else if (!['research', 'literature', 'governed'].includes(fixture)) throw new Error(`UNKNOWN_MOCKED_FIXTURE: ${entry.id}`);
    if (files.has(entry.source) && files.get(entry.source) !== name) throw new Error(`SPLIT_MOCKED_FILE: ${entry.source}`);
    files.set(entry.source, name);
    const runsSupplementalChecks = !['web-ui-st', 'combination-browser'].includes(plan.suite) && name === 'standard-config' && plan.execution.backend === 'jiuwenswarm';
    const group = groups.get(name) ?? { name, fixture, keys: [], checks: runsSupplementalChecks ? swarmChecks : [] };
    group.keys.push(entry.key); groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// A local complete run executes the CI partitions one after another. Keeping
// this projection beside mockedShards prevents the local driver from merging
// partitions merely because they happen to share a product fixture.
export function mockedBatches(plan) {
  return mockedShards(plan).flatMap(partition => {
    const entries = plan.entries.filter(entry => partition.keys.includes(entry.key));
    const batch = (suffix, selected, checks = []) => ({
      shard: partition.name, group: 'mocked', fixture: partition.fixture,
      key: `mocked-${partition.name}${suffix}`, entries: selected, checks,
    });
    if (partition.name !== 'standard-config') return [batch('', entries, partition.checks)];
    const fresh = entries.filter(entry => entry.tags.includes('isolation:fresh'));
    const global = entries.filter(entry => entry.tags.includes('isolation:global'));
    return [
      ...(fresh.length ? [batch('-fresh', fresh)] : []),
      ...(global.length ? [batch('-global', global, partition.checks)] : []),
    ];
  });
}

// A fresh-library journey must run before other global-state journeys.
// Fail before execution if collection order or concurrency breaks that contract.
export function assertMockedOrder(catalog, config) {
  if (!catalog.some(e => e.tags.includes('isolation:fresh'))) return;
  if (config.workers !== 1 || config.fullyParallel) throw new Error('FRESH_JOURNEY_REQUIRES_SERIAL_WORKER');
  let other = false;
  for (const entry of catalog) {
    if (entry.tags.includes('isolation:fresh')) {
      if (other) throw new Error(`FRESH_JOURNEY_MUST_RUN_FIRST: ${entry.id}`);
    } else if (entry.tags.includes('isolation:global')) other = true;
  }
}

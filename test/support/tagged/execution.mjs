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
    // Fresh/global live in different stacks even though they share a CI job.
    // A file must not silently lose its shared hooks across that boundary.
    const fileGroup = fixture === 'standard' ? `${name}:${isolation}` : name;
    if (files.has(entry.source) && files.get(entry.source) !== fileGroup) throw new Error(`SPLIT_MOCKED_FILE: ${entry.source}`);
    files.set(entry.source, fileGroup);
    const group = groups.get(name) ?? { name, fixture, keys: [], checks: name === 'standard-config' && plan.execution.backend === 'jiuwenswarm' ? swarmChecks : [] };
    group.keys.push(entry.key); groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Files own beforeAll/afterAll state and sometimes ordered tests. Keep each
// file serial, but distribute independent files over two separate stacks.
// Global mutations only serialize work on the SAME stack, not other installs.
function isolatedBatches(partition, entries, suffix = '', checks = partition.checks) {
  const files = new Map();
  for (const entry of entries) {
    const file = files.get(entry.source) ?? [];
    file.push(entry); files.set(entry.source, file);
  }
  const bins = Array.from({ length: Math.min(2, files.size) }, () => []);
  for (const file of [...files.values()].sort((a, b) => b.length - a.length || a[0].source.localeCompare(b[0].source))) {
    const bin = bins.reduce((best, next) => next.length < best.length ? next : best);
    bin.push(...file);
  }
  return bins.map((bin, index) => ({
    shard: partition.name, group: 'mocked', fixture: partition.fixture,
    key: `mocked-${partition.name}${suffix}${bins.length > 1 ? `-${index + 1}` : ''}`,
    // Preserve the frozen collection order within each stack, including hooks.
    entries: entries.filter(entry => bin.includes(entry)), checks: index === 0 ? checks : [],
  }));
}

// The CI matrix and local driver use the same batches and accounting. A
// pristine-library batch precedes mutations; all other stacks are independent.
export function mockedBatches(plan) {
  return mockedShards(plan).flatMap(partition => {
    const entries = plan.entries.filter(entry => partition.keys.includes(entry.key));
    if (partition.name !== 'standard-config') return isolatedBatches(partition, entries);
    const fresh = entries.filter(entry => entry.tags.includes('isolation:fresh'));
    const global = entries.filter(entry => entry.tags.includes('isolation:global'));
    return [
      ...(fresh.length ? [{ shard: partition.name, group: 'mocked', fixture: partition.fixture,
        key: `mocked-${partition.name}-fresh`, entries: fresh, checks: [] }] : []),
      ...isolatedBatches(partition, global, '-global'),
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

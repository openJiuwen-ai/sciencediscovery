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
    } else if (!['research', 'literature'].includes(fixture)) throw new Error(`UNKNOWN_MOCKED_FIXTURE: ${entry.id}`);
    if (files.has(entry.source) && files.get(entry.source) !== name) throw new Error(`SPLIT_MOCKED_FILE: ${entry.source}`);
    files.set(entry.source, name);
    const group = groups.get(name) ?? { name, fixture, keys: [], checks: name === 'standard-config' && plan.execution.backend === 'jiuwenswarm' ? swarmChecks : [] };
    group.keys.push(entry.key); groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
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

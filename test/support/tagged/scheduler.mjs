// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

/**
 * The one UT worker count, for every machine. It is sized for the public
 * GitHub-hosted `ubuntu-latest` runner the UT job uses (4 vCPUs, 16 GB RAM),
 * never for the host it happens to run on, so a local `pnpm ci:ut` schedules
 * exactly what CI schedules. `CI_UT_WORKERS` may narrow it (1 for serial
 * diagnosis) but not exceed it.
 */
export const UT_WORKERS = 4;

export function utWorkers(value = String(UT_WORKERS)) {
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text) || Number(text) > UT_WORKERS) {
    throw new Error(`CI_UT_WORKERS must be an integer from 1 to ${UT_WORKERS}`);
  }
  return Number(text);
}

/** The tag a test carries when it needs the run's real JiuwenSwarm instance. */
export const SWARM_TAG = 'swarm:required';
/** The execution lock for that one instance; every other group needs none. */
export const SWARM = 'jiuwenswarm';
export const declaresSwarm = entry => entry.tags.includes(SWARM_TAG);

/**
 * Split executable plan entries into worker groups: one process per Node test
 * file and one per Python project, as always. A file's (or project's) tests
 * that declare `swarm:required` get a process of their own, which holds the
 * JiuwenSwarm lock, so the queue covers those tests and nothing else in the
 * file; the rest of the file runs beside other groups without the instance.
 * `name` is unique per group, so each process files its coverage separately.
 */
export function planGroups(entries) {
  const groups = new Map();
  for (const entry of entries.filter(e => e.runner === 'node' || e.runner === 'python')) {
    const source = entry.runner === 'python' ? entry.source.split('/').slice(0, 2).join('/') : entry.source;
    const swarm = declaresSwarm(entry);
    const key = `${entry.runner}:${source}:${swarm}`;
    const group = groups.get(key) ?? { name: swarm ? `${source}.${SWARM}` : source, source, runner: entry.runner, resource: swarm ? SWARM : null, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Bounded process tasks, with stable results even when completion is reordered. */
export async function schedule(tasks, { workers = 1, signal, onChange = () => {} } = {}) {
  utWorkers(workers);
  const pending = tasks.map((task, index) => ({ ...task, index }));
  // A resource is a serial lane: start it first so it overlaps everything
  // else instead of trailing the run. A serial run keeps the original order
  // for reproducible comparisons.
  if (workers > 1) pending.sort((a, b) => (a.resource ? 0 : 1) - (b.resource ? 0 : 1) || a.index - b.index);
  const running = new Set(), resources = new Set(), results = new Array(tasks.length);
  while (pending.length || running.size) {
    if (signal?.aborted) {
      for (const task of pending.splice(0)) results[task.index] = { status: 'rejected', reason: new Error('UT scheduling aborted') };
    }
    while (running.size < workers) {
      const index = pending.findIndex(task => !task.resource || !resources.has(task.resource));
      if (index < 0) break;
      const task = pending.splice(index, 1)[0];
      if (task.resource) resources.add(task.resource);
      const promise = Promise.resolve().then(task.run).then(
        value => { results[task.index] = { status: 'fulfilled', value }; },
        reason => { results[task.index] = { status: 'rejected', reason }; },
      ).finally(() => {
        running.delete(promise);
        if (task.resource) resources.delete(task.resource);
        onChange(running.size);
      });
      running.add(promise);
      onChange(running.size);
    }
    if (running.size) await Promise.race(running);
  }
  return results;
}

// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

export function utWorkers(value = '2') {
  if (!/^[1-4]$/.test(String(value))) throw new Error('CI_UT_WORKERS must be an integer from 1 to 4');
  return Number(value);
}

// These are execution locks, not selectors. All API files retain their order
// on the shared SDK/adapter; Python projects retain their order as well.
export function groupResource(group, runner) {
  if (runner === 'python') return 'python';
  return group.startsWith('services/api/') ? 'api' : null;
}

/** Bounded process tasks, with stable results even when completion is reordered. */
export async function schedule(tasks, { workers = 1, signal, onChange = () => {} } = {}) {
  utWorkers(workers);
  const pending = tasks.map((task, index) => ({ ...task, index }));
  // Start the long shared-resource lanes early so Node and Python overlap.
  // A serial run keeps the original order for reproducible comparisons.
  if (workers > 1) pending.sort((a, b) =>
    (a.resource === 'api' ? 0 : a.resource === 'python' ? 1 : 2) -
    (b.resource === 'api' ? 0 : b.resource === 'python' ? 1 : 2) || a.index - b.index);
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

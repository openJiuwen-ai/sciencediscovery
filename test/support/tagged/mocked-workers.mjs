// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:net';
import { schedule } from './scheduler.mjs';

export const MOCKED_WORKERS = 2;

export function mockedWorkers(value = MOCKED_WORKERS) {
  if (!/^[12]$/.test(String(value))) throw new Error('--workers must be 1 or 2 independent mocked stacks');
  return Number(value);
}

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
});
const close = server => new Promise(resolve => server.close(resolve));
// A child cannot inherit these listeners. Keep the assignments claimed even
// after closing them, while its services are still starting in this process.
const claimed = new Set();

/** Reserve the full port block until its child is about to start. */
export async function reserveMockedPorts() {
  for (;;) {
    const sockets = [createServer()];
    await listen(sockets[0], 0);
    const base = sockets[0].address().port;
    try {
      if (base + 8 > 65535 || Array.from({ length: 9 }, (_, i) => base + i).some(port => claimed.has(port))) {
        throw Object.assign(new Error('Port block unavailable'), { code: 'EADDRINUSE' });
      }
      for (let offset = 1; offset <= 8; offset++) {
        const socket = createServer(); sockets.push(socket); await listen(socket, base + offset);
      }
      for (let offset = 0; offset <= 8; offset++) claimed.add(base + offset);
      let released = false;
      return {
        base,
        env: {
          SCIENCE_AGENT_PORT: String(base), SCIENCE_AGENT_RUNNER_PORT: String(base + 1),
          SCIENCE_AGENT_MEMORY_GRAPH_PORT: String(base + 2), SCIENCE_AGENT_LEGACY_PORT: String(base + 8),
          // A fresh named Swarm instance is index 1: its port is base + 1000.
          // Use its existing product settings instead of racing auto-discovery
          // in independent registries. base+5 belongs to the MCP fault proxy.
          JIUWENSWARM_AGENT_SERVER_PORT: String(base + 3 - 1000),
          JIUWENSWARM_WEB_PORT: String(base + 4 - 1000),
          JIUWENSWARM_GATEWAY_PORT: String(base + 6 - 1000),
          JIUWENSWARM_FRONTEND_PORT: String(base + 7 - 1000),
        },
        async release() { if (!released) { released = true; await Promise.all(sockets.map(close)); } },
      };
    } catch (error) {
      await Promise.all(sockets.map(close));
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
}

/** A fresh-library check finishes first; other batches never share a stack. */
export async function runMockedBatches(batches, run, { workers = MOCKED_WORKERS } = {}) {
  workers = mockedWorkers(workers);
  const fresh = batches.filter(batch => batch.entries.some(entry => entry.tags.includes('isolation:fresh')));
  const independent = batches.filter(batch => !fresh.includes(batch));
  const tasks = selected => selected.map(batch => ({ run: () => run(batch) }));
  // Keep collecting failures instead of discarding sibling cases on rejection.
  return [
    ...await schedule(tasks(fresh), { workers: 1 }),
    ...await schedule(tasks(independent), { workers }),
  ];
}

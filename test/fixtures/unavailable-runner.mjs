// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Real Runner HTTP server with a deliberately missing sandbox executable.
 * No product/API responses are stubbed, no host security settings are changed.
 */
export async function unavailableRunner() {
  const { createRunnerServer, loadRunnerConfig } = await import('../../services/runner/dist/server.js');
  const root = await mkdtemp(join(tmpdir(), 'sd-e2e-unavailable-runner-'));
  const token = randomUUID();
  const requests = [];
  const server = createRunnerServer({ ...loadRunnerConfig(), dataDir: root, authToken: token,
    sandboxProvider: 'bubblewrap', bwrapPath: join(root, 'missing-bwrap'),
    scientificEnvsEnabled: false, npuBrokerEnabled: false });
  server.prependListener('request', (request) => requests.push({method:request.method, path:request.url, at:Date.now()}));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) { await rm(root, {recursive:true, force:true}); throw error; }
  return {
    endpoint: { host:'127.0.0.1', port:server.address().port, protocol:'http' }, token, requests,
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive:true, force:true });
    },
  };
}

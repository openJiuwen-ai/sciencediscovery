// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
// Explicit test-only bootstrap. No production route or configuration is changed.
import { createApiServer, closeApiServer, loadServerConfig } from '../../services/api/dist/server.js';
import { literatureSource } from './literature-source.mjs';
if (process.env.E2E_SWARM_EXCLUSIVE !== '1' || !process.env.SCIENCE_DISCOVERY_DATA_DIR || process.env.SCIENCE_AGENT_EXECUTOR !== 'jiuwenswarm') {
  throw new Error('Use a dedicated data directory and E2E_SWARM_EXCLUSIVE=1');
}
const fixture = literatureSource();
const config = loadServerConfig();
if (!['127.0.0.1', 'localhost'].includes(config.host)) throw new Error('Fixture must bind loopback');
const server = createApiServer(config, { mcpTransport: fixture.mcpTransport, connectorFetch: fixture.connectorFetch });
const handlers = server.listeners('request');
server.removeAllListeners('request');
server.on('request', (request, response) => {
  if (request.url === '/e2e/literature-fixture') {
    if (request.headers.authorization !== `Bearer ${config.authToken}`) { response.writeHead(401).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ fixture: 'offline-literature-v1', events: fixture.events }));
  } else for (const handler of handlers) handler.call(server, request, response);
});
server.listen(config.port, config.host);
process.once('SIGTERM', () => { void closeApiServer(server); });

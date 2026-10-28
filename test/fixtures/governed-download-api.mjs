// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
// Explicit test-only bootstrap. No production route or configuration is changed.
import { createApiServer, closeApiServer, loadServerConfig } from '../../services/api/dist/server.js';

import { governedDownloadSource } from './governed-download-source.mjs';

// Refuse to start against an instance somebody is using for themselves: the
// offline transport must only replace a stack this layer owns end to end.
if (process.env.E2E_GOVERNED_DOWNLOAD_FIXTURE !== '1' || !process.env.SCIENCE_DISCOVERY_DATA_DIR) {
  throw new Error('Use a dedicated data directory and E2E_GOVERNED_DOWNLOAD_FIXTURE=1');
}
const fixture = governedDownloadSource();
const config = loadServerConfig();
if (!['127.0.0.1', 'localhost'].includes(config.host)) throw new Error('Fixture must bind loopback');
const server = createApiServer(config, {
  connectorFetch: fixture.connectorFetch,
  mcpTransport: fixture.mcpTransport,
});
const handlers = server.listeners('request');
server.removeAllListeners('request');
server.on('request', (request, response) => {
  if (request.url === '/e2e/governed-download-fixture') {
    if (request.headers.authorization !== `Bearer ${config.authToken}`) { response.writeHead(401).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ events: fixture.events, fixture: fixture.fixture, pdfUrl: fixture.pdfUrl }));
  } else for (const handler of handlers) handler.call(server, request, response);
});
server.listen(config.port, config.host);
process.once('SIGTERM', () => { void closeApiServer(server); });
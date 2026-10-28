// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
// Explicit test-only offline source. No production route, manifest or host list is changed.
import { createPublicBiomedSources } from '../../packages/mcp-sources/dist/public-biomed.js';

import { sourcePdf } from './literature-source.mjs';

const FIXTURE_ID = 'offline-governed-download-v1';
const ARXIV_IDENTIFIER = '2401.00001';
const ARXIV_IDENTIFIER_PATTERN = /^\d{4}\.\d{4,5}$/;

/**
 * The identifier the tool was asked for, so one invocation can offer the
 * candidate of one paper and another one the candidate of a different paper
 * of the same source: a Session-scoped download grant matches on the source,
 * not on the file, and only a second candidate can show that.
 */
function requestedIdentifier(input) {
  const identifier = String(input.identifier ?? ARXIV_IDENTIFIER);
  if (!ARXIV_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`Unsupported fixture identifier ${identifier}`);
  }
  return identifier;
}

/**
 * An arXiv source whose transport and artifact bytes stay on this machine: the
 * MCP call is served by an in-process transport and the governed download is
 * served by `connectorFetch`, the same seam the governed download manager
 * takes its fetch from. The download therefore exercises the real candidate →
 * plan → permission → job → verified artifact path without a live request.
 */
export function governedDownloadSource() {
  const [source] = createPublicBiomedSources(['arxiv']);
  const events = [];
  const catalog = {
    loadedAt: new Date().toISOString(),
    revision: FIXTURE_ID,
    servers: [{
      description: 'Offline governed download fixture',
      enabled: true,
      id: source.manifest.transport.mcpServerId,
      tools: Object.values(source.manifest.tools).map((tool) => ({
        description: tool.description,
        inputSchema: tool.inputSchema,
        name: tool.mcpToolName,
      })),
      transport: 'stdio',
    }],
  };
  return {
    events,
    fixture: FIXTURE_ID,
    identifier: ARXIV_IDENTIFIER,
    pdfUrl: `https://arxiv.org/pdf/${ARXIV_IDENTIFIER}`,
    mcpTransport: {
      catalog: async () => catalog,
      reload: async () => catalog,
      invoke: async (request) => {
        const toolId = Object.entries(source.manifest.tools)
          .find(([, tool]) => tool.mcpToolName === request.toolName)?.[0];
        if (!toolId) throw new Error(`Unconfigured fixture tool ${request.toolName}`);
        const input = request.arguments ?? request.input ?? {};
        events.push({ input, kind: 'invoke', sourceId: source.manifest.id, timestamp: Date.now(), toolId });
        const identifier = requestedIdentifier(input);
        const result = {
          artifacts: [{
            attribution: 'Offline fixture',
            expectedBytes: sourcePdf().byteLength,
            format: 'pdf',
            id: `pdf-${identifier}`,
            kind: 'paper',
            license: 'CC0',
            logicalName: `${identifier}.pdf`,
            mimeType: 'application/pdf',
            sourceId: source.manifest.id,
            sourceRecordId: identifier,
            sourceUrl: `https://arxiv.org/pdf/${identifier}`,
          }],
          attribution: 'Offline fixture',
          license: 'CC0',
          records: [],
          retrievedAt: new Date().toISOString(),
          sourceId: source.manifest.id,
          toolId,
          untrusted: true,
          warnings: [],
        };
        return {
          attempts: [],
          content: [{ type: 'json', value: result }],
          durationMs: 1,
          isError: false,
          requestId: 'offline',
          serverId: request.serverId,
          toolName: request.toolName,
        };
      },
    },
    connectorFetch: async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      const identifier = url.startsWith('https://arxiv.org/pdf/')
        ? url.slice('https://arxiv.org/pdf/'.length)
        : undefined;
      if (!identifier || !ARXIV_IDENTIFIER_PATTERN.test(identifier)) {
        throw new Error(`Unexpected outbound fixture download: ${url}`);
      }
      events.push({ kind: 'download', timestamp: Date.now(), url });
      return new Response(sourcePdf(), {
        headers: { 'content-length': String(sourcePdf().byteLength), 'content-type': 'application/pdf' },
        status: 200,
      });
    },
  };
}
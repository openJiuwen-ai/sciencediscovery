// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createPublicBiomedSources } from '../../packages/mcp-sources/dist/public-biomed.js';

/** Minimal valid one-page PDF; real PaperService parses it, never a mocked extractor. */
export function sourcePdf() {
  const text = 'BT /F1 12 Tf 50 740 Td (LR_PDF_EVIDENCE risk ratio 1.25 synthetic cohort) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}

export function literatureSource() {
  const sources = createPublicBiomedSources(['arxiv', 'pubmed']);
  const events = [];
  const catalog = { loadedAt: new Date().toISOString(), revision: 'offline-literature-v1', servers: [] };
  for (const { manifest } of sources) {
    let server = catalog.servers.find(s => s.id === manifest.transport.mcpServerId);
    if (!server) { server = { id: manifest.transport.mcpServerId, enabled: true, tools: [], transport: 'stdio' }; catalog.servers.push(server); }
    for (const tool of Object.values(manifest.tools)) server.tools.push({ name: tool.mcpToolName, description: tool.description, inputSchema: tool.inputSchema });
  }
  return {
    events,
    mcpTransport: {
      catalog: async () => catalog, reload: async () => catalog,
      invoke: async request => {
        const source = sources.find(s => Object.values(s.manifest.tools).some(t => t.mcpToolName === request.toolName));
        if (!source) throw new Error(`Unconfigured fixture tool ${request.toolName}`);
        const toolId = Object.entries(source.manifest.tools).find(([, t]) => t.mcpToolName === request.toolName)[0];
        const input = request.arguments ?? request.input ?? {};
        events.push({ kind: 'invoke', source: source.manifest.id, toolId, input, timestamp: Date.now() });
        const sourceId = source.manifest.id;
        const identifier = sourceId === 'arxiv' ? (input.identifier ?? '2401.00001') : '12345678';
        const url = sourceId === 'arxiv' ? `https://arxiv.org/abs/${identifier}` : `https://pubmed.ncbi.nlm.nih.gov/${identifier}/`;
        const citation = { source: sourceId, identifier, identifierType: sourceId, title: 'Synthetic cohort', url,
          retrievedAt: new Date().toISOString(), formatted: `${sourceId}:${identifier}` };
        const result = { sourceId, toolId, untrusted: true, attribution: 'Offline fixture', license: 'CC0',
          retrievedAt: new Date().toISOString(), warnings: [], records: [{
            source: sourceId, identifier, identifierType: sourceId, title: 'Synthetic cohort', url,
            primaryCitation: citation, citations: [citation], warnings: [],
            structuredData: { doi: '10.0000/LR-SAME-STUDY', effect: sourceId === 'arxiv' ? 1.25 : 0.8 },
            abstract: sourceId === 'arxiv' ? 'LR_SOURCE_A risk ratio 1.25' : 'LR_SOURCE_B risk ratio 0.8; conflicting estimate',
          }], artifacts: toolId === 'prepare_paper_download' ? [{
            id: `pdf-${identifier}`, sourceId, sourceRecordId: identifier, kind: 'paper', format: 'pdf',
            mimeType: 'application/pdf', logicalName: `${identifier}.pdf`, sourceUrl: `https://arxiv.org/pdf/${identifier}`,
            attribution: 'Offline fixture', license: 'CC0',
          }] : [] };
        const isError = String(input.query ?? '').includes('LR_FAIL');
        if (String(input.query ?? '').includes('LR_EMPTY')) result.records = [];
        return { requestId: 'offline', serverId: request.serverId, toolName: request.toolName,
          durationMs: 1, attempts: [], isError, content: isError ? [{ type: 'text', text: 'LR_RATE_LIMIT: synthetic source unavailable; choose another source' }] : [{ type: 'json', value: result }] };
      },
    },
    connectorFetch: async input => {
      const url = String(input instanceof Request ? input.url : input);
      if (!/^https:\/\/arxiv\.org\/pdf\/2401\.0000[1-4]$/.test(url)) throw new Error('Unexpected outbound fixture download');
      events.push({ kind: 'download', url, timestamp: Date.now() });
      const bytes = url.endsWith('2') ? Buffer.from('<html>Login required</html>') : url.endsWith('3') ? Buffer.from('%PDF-1.4\nbroken') : sourcePdf();
      return new Response(url.endsWith('4') ? 'Forbidden' : bytes, { status: url.endsWith('4') ? 403 : 200,
        headers: { 'content-type': url.endsWith('2') ? 'text/html' : 'application/pdf' } });
    },
  };
}

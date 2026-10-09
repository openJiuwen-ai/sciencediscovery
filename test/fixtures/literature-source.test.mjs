// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createTest } from "../support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { literatureSource, sourcePdf } from './literature-source.mjs';
import { createPublicBiomedSources } from '../../packages/mcp-sources/dist/public-biomed.js';

test('offline results obey the actual builtin source normalization contract', async () => {
  const fixture = literatureSource();
  for (const source of createPublicBiomedSources(['arxiv', 'pubmed'])) {
    for (const id of ['search', ...(source.manifest.id === 'arxiv' ? ['prepare_paper_download'] : [])]) {
      const tool = source.manifest.tools[id];
      const raw = await fixture.mcpTransport.invoke({ serverId: source.manifest.transport.mcpServerId, toolName: tool.mcpToolName,
        arguments: id === 'search' ? { query: 'LR_CONFLICT' } : { identifier: '2401.00001' } });
      const normalized = await source.normalizeResult({ source: source.manifest, tool, retrievedAt: new Date().toISOString() }, raw);
      assert.equal(normalized.sourceId, source.manifest.id);
      assert.equal(normalized.records.length, 1);
      assert.equal(normalized.records[0].primaryCitation.source, source.manifest.id);
      if (id === 'prepare_paper_download') assert.equal(normalized.artifacts.length, 1);
    }
  }
});

test('offline source supports error, empty result and recovery without live network', async () => {
  const fixture = literatureSource();
  const toolName = createPublicBiomedSources(['pubmed'])[0].manifest.tools.search.mcpToolName;
  assert.equal((await fixture.mcpTransport.invoke({ toolName, arguments: { query: 'LR_FAIL' } })).isError, true);
  const empty = await fixture.mcpTransport.invoke({ toolName, arguments: { query: 'LR_EMPTY' } });
  assert.equal(empty.content[0].value.records.length, 0);
  const success = await fixture.mcpTransport.invoke({ toolName, arguments: { query: 'LR_RECOVERED' } });
  assert.equal(success.content[0].value.records.length, 1);
  await assert.rejects(fixture.connectorFetch('https://example.org/not-in-fixture'), /Unexpected outbound/);
});

test('download fixture distinguishes a real PDF, login HTML, corrupt PDF and access denial', async () => {
  const fixture = literatureSource();
  const valid = await fixture.connectorFetch('https://arxiv.org/pdf/2401.00001');
  assert.deepEqual(Buffer.from(await valid.arrayBuffer()), sourcePdf());
  assert.match(sourcePdf().toString(), /xref\n0 6/);
  assert.match(sourcePdf().toString(), /LR_PDF_EVIDENCE/);
  const html = await fixture.connectorFetch('https://arxiv.org/pdf/2401.00002');
  assert.equal(html.headers.get('content-type'), 'text/html');
  assert.match(await html.text(), /Login required/);
  assert.equal(await (await fixture.connectorFetch('https://arxiv.org/pdf/2401.00003')).text(), '%PDF-1.4\nbroken');
  assert.equal((await fixture.connectorFetch('https://arxiv.org/pdf/2401.00004')).status, 403);
});

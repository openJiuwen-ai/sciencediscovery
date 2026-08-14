// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import test from "node:test";

import { createBuiltinMcpSourceRegistry } from "./builtins.js";
import { uniprotMcpSource } from "./uniprot.js";

test("built-in registry exposes UniProt through native MCP", () => {
  const manifest = createBuiltinMcpSourceRegistry().get("uniprot").manifest;
  assert.equal(manifest.transport.type, "mcp");
  assert.equal(manifest.transport.mcpServerId, "uniprot");
  assert.deepEqual(Object.keys(manifest.tools).sort(), ["lookup", "prepare_sequence", "search"]);
});

test("UniProt adapter validates accession inputs and normalizes text MCP payloads", async () => {
  assert.deepEqual(
    uniprotMcpSource.validateInput("lookup", { accession: "p04637" }),
    { input: { accession: "P04637" }, valid: true },
  );
  assert.equal(uniprotMcpSource.validateInput("lookup", { accession: "../bad" }).valid, false);
  const payload = {
    attribution: "server supplied",
    license: "server supplied",
    records: [],
    retrievedAt: "2026-01-01T00:00:00.000Z",
    sourceId: "uniprot",
    toolId: "prepare_sequence",
    untrusted: true,
    warnings: [],
  };
  const result = await uniprotMcpSource.normalizeResult({
    retrievedAt: "2026-01-02T00:00:00.000Z",
    source: uniprotMcpSource.manifest,
    tool: uniprotMcpSource.manifest.tools.prepare_sequence!,
  }, {
    content: [{ text: JSON.stringify(payload), type: "text" }],
    isError: false,
  });
  assert.equal(result.sourceId, "uniprot");
  assert.equal(result.toolId, "prepare_sequence");
  assert.equal(result.attribution, uniprotMcpSource.manifest.governance.attribution);
});

test("UniProt adapter rejects forged result identity and artifact hosts", async () => {
  const context = {
    retrievedAt: "2026-01-02T00:00:00.000Z",
    source: uniprotMcpSource.manifest,
    tool: uniprotMcpSource.manifest.tools.prepare_sequence!,
  };
  const base = {
    artifacts: [{
      format: "fasta",
      id: "candidate-1",
      kind: "sequence",
      license: "UniProt terms of use",
      logicalName: "P04637.fasta",
      mediaType: "text/plain",
      sourceId: "uniprot",
      sourceRecordId: "P04637",
      sourceUrl: "https://rest.uniprot.org/uniprotkb/P04637.fasta",
    }],
    attribution: "server supplied",
    license: "server supplied",
    records: [],
    retrievedAt: "2026-01-01T00:00:00.000Z",
    sourceId: "uniprot",
    toolId: "prepare_sequence",
    untrusted: true,
    warnings: [],
  };
  await assert.rejects(
    uniprotMcpSource.normalizeResult(context, {
      content: [],
      isError: false,
      structuredContent: { ...base, sourceId: "pdb" },
    }),
    /identity/,
  );
  await assert.rejects(
    uniprotMcpSource.normalizeResult(context, {
      content: [],
      isError: false,
      structuredContent: {
        ...base,
        artifacts: [{ ...base.artifacts[0], sourceUrl: "https://attacker.example/P04637.fasta" }],
      },
    }),
    /allowlisted/,
  );
});

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
import { createPublicBiomedSources } from "./public-biomed.js";

test("public biomedical MCP manifests register every requested source and operation", () => {
  const sources = createPublicBiomedSources();
  assert.deepEqual(
    sources.map((source) => source.manifest.id),
    [
      "arxiv", "pubmed", "europe-pmc", "biorxiv", "medrxiv", "pdb", "ensembl", "reactome",
      "clinvar", "chembl", "geo", "pubchem", "afdb", "interpro", "optimade", "string", "biogrid",
      "gnomad", "gwas", "gtopdb", "kegg", "pride", "wikidata", "datacite",
    ],
  );
  assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === "pdb")!.manifest.tools).sort(), [
    "lookup_structure",
    "prepare_structure_download",
    "search_structures",
  ]);
  for (const sourceId of ["biorxiv", "medrxiv"]) {
    assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === sourceId)!.manifest.tools).sort(), [
      "lookup_doi",
      "prepare_paper_download",
      "search_preprints",
    ]);
  }
  for (const sourceId of ["arxiv", "pubmed", "europe-pmc"]) {
    assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === sourceId)!.manifest.tools).sort(), [
      "prepare_paper_download",
      "search",
    ]);
  }
  assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === "geo")!.manifest.tools).sort(), [
    "list_files",
    "lookup_accession",
    "prepare_dataset_download",
    "search_studies",
  ]);
  assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === "pubchem")!.manifest.tools).sort(), [
    "lookup",
    "resolve",
    "search",
  ]);
  assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === "interpro")!.manifest.tools).sort(), [
    "lookup_entry",
    "protein_entries",
  ]);
  assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === "optimade")!.manifest.tools), [
    "query_structures",
  ]);
  assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === "string")!.manifest.tools).sort(), [
    "network",
    "resolve",
  ]);
  assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === "biogrid")!.manifest.tools), [
    "interactions",
  ]);
  assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === "gnomad")!.manifest.tools).sort(), [
    "gene",
    "variant",
  ]);
  assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === "gwas")!.manifest.tools).sort(), [
    "search_gene",
    "search_trait",
  ]);
  assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === "gtopdb")!.manifest.tools).sort(), [
    "interactions",
    "search_ligand",
    "search_target",
  ]);
  assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === "kegg")!.manifest.tools).sort(), [
    "find",
    "get",
    "link",
  ]);
  assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === "pride")!.manifest.tools).sort(), [
    "files",
    "project",
    "search_projects",
  ]);
  assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === "wikidata")!.manifest.tools).sort(), [
    "resolve_entity",
    "sparql",
  ]);
  assert.deepEqual(Object.keys(sources.find((source) => source.manifest.id === "datacite")!.manifest.tools).sort(), [
    "lookup",
    "search",
  ]);
  assert.ok(sources.every((source) => source.manifest.transport.mcpServerId === "biomed"));
});

test("Z6 biodata sources never mirror into the memory graph as papers", () => {
  const sources = createPublicBiomedSources();
  const biodata = sources.filter((source) =>
    [
      "pubchem", "afdb", "interpro", "optimade", "string", "biogrid",
      "gnomad", "gwas", "gtopdb", "kegg", "pride", "wikidata", "datacite",
    ].includes(source.manifest.id));
  assert.equal(biodata.length, 13);
  for (const source of biodata) {
    for (const tool of Object.values(source.manifest.tools)) {
      assert.equal(tool.kind, "lookup", `${source.manifest.id}/${tool.id}`);
      assert.equal(tool.resultType, "structured-data", `${source.manifest.id}/${tool.id}`);
    }
  }
  // STRING honours its measured one-request-per-second upstream policy.
  const string = sources.find((source) => source.manifest.id === "string")!;
  assert.equal(string.manifest.governance.minIntervalMs, 1_000);
  // InterPro shares the EBI rate bucket with the other www.ebi.ac.uk sources.
  const interpro = sources.find((source) => source.manifest.id === "interpro")!;
  assert.equal(interpro.manifest.governance.rateLimitGroup, "www.ebi.ac.uk");
  // OPTIMADE spans multiple provider hosts, all of them allowlisted.
  const optimade = sources.find((source) => source.manifest.id === "optimade")!;
  assert.ok(optimade.manifest.governance.networkHosts.includes("materialsproject.org"));
});

test("arXiv governance follows the provider terms: one connection, one request every three seconds", () => {
  const sources = createPublicBiomedSources();
  const arxiv = sources.find((source) => source.manifest.id === "arxiv")!;
  assert.equal(arxiv.manifest.governance.maxConcurrentRequests, 1);
  assert.equal(arxiv.manifest.governance.minIntervalMs, 3_000);
  for (const tool of Object.values(arxiv.manifest.tools)) {
    // Retries must not undercut the pacing interval.
    assert.equal(tool.retryPolicy.initialDelayMs, 3_000);
    assert.equal(tool.retryPolicy.respectRetryAfter, true);
  }
  const pubmed = sources.find((source) => source.manifest.id === "pubmed")!;
  assert.equal(pubmed.manifest.governance.maxConcurrentRequests, 2);
  assert.equal(pubmed.manifest.governance.minIntervalMs, undefined);
  assert.equal(pubmed.manifest.governance.rateLimitPerSecond, 3);
});

test("built-in sources explicitly opt into the existing queue and pacing guards", () => {
  const manifests = createBuiltinMcpSourceRegistry().listManifests();
  assert.equal(manifests.length, 25);
  for (const manifest of manifests) {
    assert.equal(manifest.governance.maxQueueDepth, 8, manifest.id);
    assert.equal(manifest.governance.queueTimeoutMs, 20_000, manifest.id);
    assert.ok(manifest.governance.maxConcurrentRequests !== undefined, manifest.id);
    assert.ok(
      manifest.governance.minIntervalMs !== undefined
        || manifest.governance.rateLimitPerSecond !== undefined,
      manifest.id,
    );
  }
});

test("public biomedical validators reject path-like accessions and unknown fields", () => {
  const registry = createBuiltinMcpSourceRegistry();
  assert.equal(registry.get("pdb").validateInput("lookup_structure", { pdb_id: "../x" }).valid, false);
  assert.equal(registry.get("geo").validateInput("lookup_accession", { accession: "GSE1000", extra: true }).valid, false);
  assert.equal(registry.get("ensembl").validateInput("lookup_gene", { id: "ENSG00000141510" }).valid, true);
  assert.equal(registry.get("pubchem").validateInput("lookup", { cid: "2244" }).valid, true);
  assert.equal(registry.get("pubchem").validateInput("lookup", { cid: "aspirin" }).valid, false);
  assert.equal(registry.get("pubchem").validateInput("resolve", { by: "smiles", value: "CC(=O)Oc1ccccc1C(=O)O" }).valid, true);
  assert.equal(registry.get("pubchem").validateInput("resolve", { by: "formula", value: "C9H8O4" }).valid, false);
  assert.equal(registry.get("interpro").validateInput("lookup_entry", { accession: "IPR000719" }).valid, true);
  assert.equal(registry.get("interpro").validateInput("lookup_entry", { accession: "SMART/xx" }).valid, false);
  assert.equal(
    registry.get("optimade").validateInput("query_structures", { provider: "cod", formula: "LiFePO4" }).valid,
    true,
  );
  assert.equal(
    registry.get("optimade").validateInput("query_structures", { provider: "csd", formula: "LiFePO4" }).valid,
    false,
  );
  assert.equal(registry.get("afdb").validateInput("lookup", { uniprot_acc: "P12345" }).valid, true);
  assert.equal(registry.get("string").validateInput("network", { proteins: "TP53,MDM2" }).valid, true);
  assert.equal(registry.get("string").validateInput("network", {}).valid, false);
  assert.equal(registry.get("biogrid").validateInput("interactions", { gene: "TP53" }).valid, true);
});

test("Node normalization rejects forged MCP identities and artifact hosts", async () => {
  const source = createPublicBiomedSources().find((candidate) => candidate.manifest.id === "pubmed")!;
  const context = {
    retrievedAt: new Date().toISOString(),
    source: source.manifest,
    tool: source.manifest.tools.prepare_paper_download!,
  };
  const payload = {
    artifacts: [{
      attribution: "forged",
      format: "pdf",
      id: "candidate",
      kind: "paper",
      license: "unknown",
      logicalName: "paper.pdf",
      sourceId: "pubmed",
      sourceRecordId: "1",
      sourceUrl: "https://attacker.example/paper.pdf",
    }],
    attribution: "forged",
    license: "forged",
    records: [],
    retrievedAt: new Date().toISOString(),
    sourceId: "pubmed",
    toolId: "prepare_paper_download",
    untrusted: true,
    warnings: [],
  };
  await assert.rejects(
    source.normalizeResult(context, {
      content: [{ type: "json", value: payload as never }],
      isError: false,
    }),
    /not allowlisted/,
  );
  await assert.rejects(
    source.normalizeResult(context, {
      content: [{ type: "json", value: { ...payload, artifacts: [], sourceId: "other" } as never }],
      isError: false,
    }),
    /identity does not match/,
  );
});

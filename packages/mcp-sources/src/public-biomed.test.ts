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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import { createBuiltinMcpSourceRegistry } from "./builtins.js";
import { createPublicBiomedSources } from "./public-biomed.js";

test("public biomedical MCP manifests register every requested source and operation", () => {
  const sources = createPublicBiomedSources();
  assert.deepEqual(
    sources.map((source) => source.manifest.id),
    ["arxiv", "pubmed", "europe-pmc", "biorxiv", "medrxiv", "pdb", "alphafold", "ensembl", "reactome", "clinvar", "chembl", "geo"],
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
    "get_samples",
    "list_files",
    "lookup_accession",
    "prepare_dataset_download",
    "search_studies",
  ]);
  assert.ok(sources.every((source) => source.manifest.transport.mcpServerId === "biomed"));
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
  assert.equal(manifests.length, 14);
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

test("domain database inputs enforce scientific measurement constraints before transport", () => {
  const registry = createBuiltinMcpSourceRegistry();
  const activities = registry.get("chembl");
  assert.equal(activities.validateInput("search_activities", {}).valid, false);
  assert.equal(activities.validateInput("search_activities", { target_chembl_id: "CHEMBL203", standard_value_max: 100 }).valid, false);
  assert.equal(activities.validateInput("search_activities", { target_chembl_id: "CHEMBL203", standard_type: "IC50", standard_units: "nM", standard_relation: "=", standard_value_max: 100, offset: 2, confidence_score_min: 9 }).valid, true);
  assert.equal(activities.validateInput("search_activities", { target_chembl_id: "CHEMBL203", standard_value_max: "100", standard_type: "IC50", standard_units: "nM", standard_relation: "=" }).valid, false);
  assert.equal(registry.get("geo").validateInput("get_samples", { accession: "GSE1000", offset: -1 }).valid, false);
  assert.equal(registry.get("alphafold").validateInput("lookup_prediction", { accession: "P69905" }).valid, true);
  assert.equal(registry.get("alphafold").validateInput("lookup_prediction", { accession: "../../etc/passwd" }).valid, false);
  assert.equal(registry.get("clinvar").validateInput("get_assertions", { accession: "VCV000014206.2" }).valid, true);
  assert.equal(registry.get("clinvar").validateInput("get_assertions", { accession: "malformed" }).valid, false);
});

test("AlphaFold prediction evidence, versions and downloadable provenance survive normalization", async () => {
  const source = createPublicBiomedSources(["alphafold"])[0]!;
  const citation = { identifier: "AF-P69905-F1", identifierType: "alphafold identifier", label: "AlphaFold model", markdown: "[AlphaFold](https://alphafold.ebi.ac.uk/entry/P69905)", role: "database-record", source: "alphafold", sourceVersion: "6", url: "https://alphafold.ebi.ac.uk/entry/P69905" };
  const payload = {
    attribution: "provider", license: "CC BY 4.0", retrievedAt: "2026-10-20T00:00:00Z", sourceId: "alphafold", toolId: "prepare_prediction_download", untrusted: true, warnings: [],
    records: [{ identifier: citation.identifier, identifierType: citation.identifierType, title: "Hemoglobin subunit alpha", source: "alphafold", url: citation.url, primaryCitation: citation, citations: [citation], structuredData: { structureType: "predicted", latestVersion: 6, globalMetricValue: 98.06 }, contentScope: "curated-record", fullTextRetrieved: false, crossReferences: [{ source: "uniprot", identifier: "P69905" }], warnings: [] }],
    artifacts: [{ id: "alphafold:AF-P69905-F1:v6:cif", sourceId: "alphafold", sourceRecordId: "AF-P69905-F1", sourceUrl: "https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.cif", logicalName: "AF-P69905-F1-model_v6.cif", kind: "structure", format: "cif", attribution: "AlphaFold DB", license: "CC BY 4.0" }],
  };
  const result = await source.normalizeResult({ retrievedAt: "later", source: source.manifest, tool: source.manifest.tools.prepare_prediction_download! }, { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false });
  assert.equal(result.records[0]!.primaryCitation.sourceVersion, "6");
  assert.equal(result.retrievedAt, payload.retrievedAt);
  assert.deepEqual(result.records[0]!.structuredData, payload.records[0]!.structuredData);
  assert.equal(result.artifacts![0]!.sourceRecordId, result.records[0]!.identifier);
  assert.equal(result.artifacts![0]!.sourceUrl, payload.artifacts[0]!.sourceUrl);
});

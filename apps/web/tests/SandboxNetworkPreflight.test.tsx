// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { ConnectorManifest } from "@sciencediscovery/schema";
import { requestedResearchHosts, selectedResearchHosts } from "../src/composer/SandboxNetworkPreflight.js";

const connectors = [
  { id: "pubmed", displayName: "PubMed", networkHosts: ["eutils.ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov"] },
  { id: "europe-pmc", displayName: "Europe PMC", networkHosts: ["www.ebi.ac.uk"] },
  { id: "web", networkHosts: [] },
] as ConnectorManifest[];

test("warns only for explicitly named known sources, including disabled connectors", () => {
  const pubmedHosts = ["eutils.ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov"];
  assert.deepEqual(selectedResearchHosts(connectors, ["pubmed"]), pubmedHosts);
  assert.deepEqual(requestedResearchHosts("search PubMed for CRISPR", connectors), pubmedHosts);
  assert.deepEqual(requestedResearchHosts("visit pubmed.ncbi.nlm.nih.gov", connectors), pubmedHosts);
  assert.deepEqual(requestedResearchHosts("搜索PubMed文献", connectors), pubmedHosts);
  assert.deepEqual(requestedResearchHosts("search EuropePMC", connectors), ["www.ebi.ac.uk"]);
  assert.deepEqual(requestedResearchHosts("research CRISPR and write a paper outline from the CSV", connectors), []);
  assert.deepEqual(requestedResearchHosts("pubmedology", connectors), []);
  assert.deepEqual(requestedResearchHosts("", connectors), []);
});

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
import { requestsResearchNetwork, selectedResearchHosts } from "../src/composer/SandboxNetworkPreflight.js";

const connectors = [
  { id: "pubmed", networkHosts: ["eutils.ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov"] },
  { id: "web", networkHosts: [] },
] as ConnectorManifest[];

test("preflights enabled research connector hosts and explicit literature requests", () => {
  assert.deepEqual(selectedResearchHosts(connectors, ["pubmed"]), ["eutils.ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov"]);
  assert.equal(requestsResearchNetwork("research CRISPR", selectedResearchHosts(connectors, ["pubmed"])), true);
  assert.equal(requestsResearchNetwork("search PubMed for CRISPR", []), true);
  assert.equal(requestsResearchNetwork("", selectedResearchHosts(connectors, ["pubmed"])), false);
  assert.equal(requestsResearchNetwork("thanks", selectedResearchHosts(connectors, ["pubmed"])), false);
  assert.equal(requestsResearchNetwork("summarize the uploaded CSV", []), false);
});

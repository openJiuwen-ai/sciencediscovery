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
import { test } from "node:test";

import { externalUrl, externalUrlList, formatExternalUrl } from "../dist/index.js";

test("external URL configuration preserves current defaults", () => {
  assert.equal(externalUrl("package_indexes.pypi_simple"), "https://pypi.org/simple");
  assert.equal(externalUrl("downloads.micromamba_config"), "services/runner/src/micromamba-releases.json");
  assert.equal(externalUrl("downloads.runtimes_config"), "scripts/binary-release/runtimes.json");
  assert.equal(
    formatExternalUrl("data_sources.arxiv.article_template", { identifier: "2101.00001v1" }),
    "https://arxiv.org/abs/2101.00001v1",
  );
  assert.deepEqual(externalUrlList("web.jina_endpoints"), ["https://r.jinaai.cn", "https://r.jina.ai"]);
});

test("external URL configuration fails clearly for missing keys and template arguments", () => {
  assert.throws(() => externalUrl("data_sources.missing"), /missing required key/u);
  assert.throws(
    () => formatExternalUrl("data_sources.arxiv.article_template", {}),
    /requires parameter: identifier/u,
  );
});

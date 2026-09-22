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

import { selectCoverageGroups } from "./select-coverage-groups.mjs";

const graph = {
  allGroups: [".ci", "config", "packages/context", "packages/schema", "scripts", "services/api"],
  packageByRoot: new Map([
    ["config", "@sciencediscovery/config"],
    ["packages/context", "@sciencediscovery/context"],
    ["packages/schema", "@sciencediscovery/schema"],
    ["services/api", "@sciencediscovery/api"],
  ]),
  reverseDependencies: new Map([
    ["@sciencediscovery/schema", new Set(["@sciencediscovery/context"])],
    ["@sciencediscovery/context", new Set(["@sciencediscovery/api"])],
  ]),
};

test("selects a changed group and its transitive Node-test dependents", () => {
  const selected = selectCoverageGroups({ paths: ["packages/schema/src/index.ts"], ...graph });
  assert.deepEqual(selected.groups, ["packages/context", "packages/schema", "services/api"]);
  assert.equal(selected.mode, "incremental");
  assert.equal(selected.skip, false);
});

test("uses a full run when shared coverage infrastructure changes", () => {
  const selected = selectCoverageGroups({ paths: ["scripts/run-node-coverage.mjs"], ...graph });
  assert.equal(selected.mode, "full");
  assert.deepEqual(selected.groups, []);
});

test("skips Node coverage for documentation or browser-only changes", () => {
  const selected = selectCoverageGroups({ paths: ["docs/guide.md", "apps/web/src/App.tsx"], ...graph });
  assert.equal(selected.skip, true);
  assert.deepEqual(selected.groups, []);
});

test("maps CI and repository script changes to their native groups", () => {
  const selected = selectCoverageGroups({ paths: [".ci/run-layer.mjs", "scripts/release.mjs"], ...graph });
  assert.deepEqual(selected.groups, [".ci", "scripts"]);
});

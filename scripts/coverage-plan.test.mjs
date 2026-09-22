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
import { createTest } from "../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

import { globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { entriesByGroup, groupCwd, groupOf, nodeGroups, planFor, pythonGroups } from "../test/support/tagged/coverage.mjs";
import { profiles } from "../test/support/tagged/profiles.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const revision = "0".repeat(40);
const identity = (id, source, tags) => ({ id, source, sourceHash: "a".repeat(64), runner: "node", tags });
const unit = ["category:ut", "os:linux", "arch:amd64"];

test("a coverage group is the directory a report is attributed to", () => {
  assert.equal(groupOf("packages/cas/src/store.test.ts"), "packages/cas");
  assert.equal(groupOf("services/memory-graph/tests/test_smoke.py"), "services/memory-graph");
  assert.equal(groupOf("apps/web/tests/Toasts.test.tsx"), "apps/web");
  assert.equal(groupOf(".ci/ci-contract.test.mjs"), ".ci");
  assert.equal(groupOf("scripts/binary-release/fetch-runtime.test.mjs"), "scripts");
  assert.equal(groupOf("config/test/external-urls.test.mjs"), "config");
  // A declaration outside those trees has no group, and coverage leaves it
  // alone rather than inventing one.
  assert.equal(groupOf("test/api/agent_loop_smoke.ts"), undefined);
});

test("a group's tests run where the shared runner runs them", () => {
  assert.equal(groupCwd(root, "packages/cas"), resolve(root, "packages/cas"));
  assert.equal(groupCwd(root, "scripts"), root);
  assert.equal(groupCwd(root, "config"), root);
});

test("coverage selects with the profile's own selector and targets", () => {
  const plan = planFor([identity("a", "packages/cas/src/a.test.ts", unit)], { root, revision });
  assert.equal(plan.selector, profiles.pr.selector);
  assert.deepEqual(plan.targets, profiles.pr.targets);
  assert.throws(() => planFor([identity("a", "packages/cas/src/a.test.ts", unit)], { root, revision, profileName: "nope" }),
    /Unknown profile/);
});

test("what the merge gate leaves out, coverage leaves out", () => {
  const plan = planFor([
    identity("reviewed", "packages/cas/src/a.test.ts", unit),
    identity("external", "services/memory-graph/tests/b.py", [...unit, "status:external"]),
    identity("live-model", "packages/cas/src/c.test.ts", [...unit, "model:real"]),
    identity("npu", "packages/cas/src/d.test.ts", [...unit, "npu:required"]),
    identity("macos", "packages/cas/src/e.test.ts", ["category:ut", "os:macos", "arch:amd64"]),
  ], { root, revision });
  assert.deepEqual(plan.entries.map((entry) => entry.id), ["reviewed"]);
});

test("groups partition the plan by the directory each identity lives in", () => {
  const plan = planFor([
    identity("cas-a", "packages/cas/src/a.test.ts", unit),
    identity("cas-b", "packages/cas/src/nested/b.test.ts", unit),
    identity("api", "services/api/src/c.test.ts", unit),
    identity("loose", "test/api/agent_loop_smoke.ts", unit),
  ], { root, revision });
  const groups = entriesByGroup(plan);
  assert.deepEqual([...groups.keys()].sort(), ["packages/cas", "services/api"]);
  assert.deepEqual(groups.get("packages/cas").map((entry) => entry.id), ["cas-a", "cas-b"]);
  // Every grouped entry, and only those, is claimed exactly once.
  const claimed = [...groups.values()].flat().map((entry) => entry.id);
  assert.equal(new Set(claimed).size, claimed.length);
  assert.deepEqual(plan.entries.filter((entry) => !claimed.includes(entry.id)).map((entry) => entry.id), ["loose"]);
});

test("every workspace holding a collected test is a coverage group", () => {
  const names = new Set(nodeGroups(root).map((group) => group.name));
  const workspaces = new Set(globSync(["packages/*/src/**/*.test.ts", "services/*/src/**/*.test.ts"], { cwd: root })
    .map((file) => file.replaceAll("\\", "/").split("/").slice(0, 2).join("/")));
  assert.ok(workspaces.size > 0, "the workspace layout changed; this test is measuring nothing");
  // The group list used to be read off each package's `test` script with a
  // regular expression, and emptied itself when those scripts changed shape.
  assert.deepEqual([...workspaces].filter((workspace) => !names.has(workspace)), []);
  assert.deepEqual(pythonGroups(root).map((group) => group.name).sort(),
    ["services/evolve", "services/gateway", "services/memory-graph", "services/paper"]);
});

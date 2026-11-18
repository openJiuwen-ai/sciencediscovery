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
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { effectiveRunnerIds } from "./project.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });

test("unspecified Project selection follows the supplied live Runner catalog without mutating it", () => {
  const project = { remoteRunnerHostIds: [] };
  const catalog = ["local", "gpu-a"];
  const selected = effectiveRunnerIds(project, undefined, catalog);
  assert.deepEqual(selected, catalog);
  selected.pop();
  assert.deepEqual(catalog, ["local", "gpu-a"]);
  assert.deepEqual(project, { remoteRunnerHostIds: [] });
  assert.deepEqual(effectiveRunnerIds(project, undefined, [...catalog, "gpu-b"]), ["local", "gpu-a", "gpu-b"]);
});

test("explicit Project and Session selections retain their precedence, including empty lists", () => {
  const catalog = ["local", "gpu-a", "gpu-b"];
  assert.deepEqual(effectiveRunnerIds({ remoteRunnerHostIds: [], runnerIds: [] }, undefined, catalog), []);
  assert.deepEqual(effectiveRunnerIds({ remoteRunnerHostIds: [], runnerIds: ["gpu-a"] }, undefined, catalog), ["gpu-a"]);
  assert.deepEqual(effectiveRunnerIds({ remoteRunnerHostIds: ["gpu-a"] }, undefined, catalog), ["local", "gpu-a"]);
  assert.deepEqual(effectiveRunnerIds({ remoteRunnerHostIds: [] }, { runnerIds: [] }, catalog), []);
  assert.deepEqual(effectiveRunnerIds({ remoteRunnerHostIds: [] }, { runnerIds: ["gpu-b"] }, catalog), ["gpu-b"]);
  assert.deepEqual(effectiveRunnerIds({ remoteRunnerHostIds: [] }, { remoteRunnerHostIds: [] }, catalog), ["local"]);
});

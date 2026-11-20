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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { enableCreatedSkills } from "../src/app/git-skill-import-job.js";
import type { GitSkillImportJob } from "../src/api/types.js";
import { StubClient } from "./api-stub.js";

const job = (imported: GitSkillImportJob["imported"], id = "job-1"): GitSkillImportJob => ({
  done: imported.length,
  failures: [],
  id,
  imported,
  startedAt: "2026-11-20T00:00:00.000Z",
  status: "done",
  total: imported.length,
});

test("a finished import switches on only the packages it created", async () => {
  const stub = new StubClient()
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply({});
  await enableCreatedSkills(stub.asClient(), job([
    { created: true, id: "new-skill" },
    { created: false, id: "updated-skill" },
  ]));
  assert.deepEqual(
    stub.calls.map((call) => [call.path, call.init.method ?? "GET"]),
    [
      ["/api/jiuwenswarm/skills", "GET"],
      ["/api/jiuwenswarm/skills-by-id/new-skill", "PUT"],
    ],
  );
});

test("the pane and the store share one enable run per job", async () => {
  const stub = new StubClient()
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply({});
  const shared = job([{ created: true, id: "new-skill" }], "job-dedupe");
  await Promise.all([
    enableCreatedSkills(stub.asClient(), shared),
    enableCreatedSkills(stub.asClient(), shared),
  ]);
  assert.deepEqual(
    stub.calls.map((call) => call.path),
    ["/api/jiuwenswarm/skills", "/api/jiuwenswarm/skills-by-id/new-skill"],
  );
});

test("a native backend has no switches to turn on", async () => {
  const stub = new StubClient().reply({ backend: "native", skills: [] });
  await enableCreatedSkills(stub.asClient(), job([{ created: true, id: "new-skill" }], "job-2"));
  assert.deepEqual(stub.calls.map((call) => call.path), ["/api/jiuwenswarm/skills"]);
});

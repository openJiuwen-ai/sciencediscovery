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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createIdeaTreeAuthorityRegistry,
  IdeaTreeAuthorityRegistry,
} from "@sciencediscovery/idea-tree";
import { SkillCatalog } from "@sciencediscovery/specialist";

import { resolveExecutorCapability } from "./executor-capability.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

test("the built-in workflow needs no metadata and still requires its Result Authority", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "sciencediscovery-executor-capability-"));
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const skillCatalog = new SkillCatalog(dataDir, repositoryRoot);
  await skillCatalog.load();
  const base = {
    skillCatalog,
    skillId: "idea-tree-team",
  };

  const available = await resolveExecutorCapability({
    ...base,
    ideaTreeAuthorities: createIdeaTreeAuthorityRegistry(),
  });
  assert.equal(available.capability.available, true);
  assert.equal(available.capability.developmentOnly, true);
  assert.equal(available.executor?.workflowSkill.id, "idea-tree-team");
  assert.deepEqual(available.executor?.leafRoles, []);
  assert.deepEqual(available.executor?.preflightRoles, []);

  const missingAuthority = await resolveExecutorCapability({
    ...base,
    ideaTreeAuthorities: new IdeaTreeAuthorityRegistry(),
  });
  assert.equal(missingAuthority.capability.available, false);
  assert.match(missingAuthority.capability.reason ?? "", /unavailable Result Authority/u);
});

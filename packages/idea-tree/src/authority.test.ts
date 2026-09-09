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

import type { IdeaTreeExecutorDescriptor } from "@sciencediscovery/schema";

import { IdeaTreeAuthorityError, IdeaTreeAuthorityRegistry } from "./authority.js";

const executor = {
  fingerprint: "sha256:fixture",
  key: "fixture",
  kind: "workflow_skill",
  leafRoles: [],
  preflightRoles: [],
  resultAuthority: { key: "fixture-authority", version: "1.0.0" },
  resultContract: "leaf-workflow-result/v1",
  scoreSpec: { direction: "maximize", maximum: 10, minimum: 1, name: "score", rubricVersion: "v1" },
  version: "1.0.0",
  workflowSkill: { hash: "hash", id: "fixture", revision: 1, version: "1.0.0" },
} satisfies IdeaTreeExecutorDescriptor;

test("authority registry resolves only exact installed capabilities", () => {
  const registry = new IdeaTreeAuthorityRegistry().register({
    createLeadTools: () => [],
    developmentOnly: true,
    key: "fixture-authority",
    supports: (candidate) => candidate.key === "fixture",
    version: "1.0.0",
  });
  assert.equal(registry.resolve(executor).developmentOnly, true);
  assert.deepEqual(registry.capability(executor), {
    authorityKey: "fixture-authority",
    authorityVersion: "1.0.0",
    available: true,
    developmentOnly: true,
  });
  assert.throws(
    () => registry.resolve({ ...executor, resultAuthority: { key: "fixture-authority", version: "2.0.0" } }),
    (error: unknown) => error instanceof IdeaTreeAuthorityError && error.code === "AUTHORITY_NOT_INSTALLED",
  );
});

test("authority registry rejects duplicate identities", () => {
  const registry = new IdeaTreeAuthorityRegistry();
  const authority = {
    createLeadTools: () => [],
    developmentOnly: false,
    key: "fixture-authority",
    supports: () => true,
    version: "1.0.0",
  };
  registry.register(authority);
  assert.throws(
    () => registry.register(authority),
    (error: unknown) => error instanceof IdeaTreeAuthorityError && error.code === "AUTHORITY_DUPLICATE",
  );
});

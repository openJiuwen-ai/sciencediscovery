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
import { join } from "node:path";
import test from "node:test";

import { CasStore } from "@sciencediscovery/cas";
import {
  createExecutorDescriptor,
  IDEA_TREE_TEAM_CONTRACT,
  IdeaTreeRuntimeError,
  specialistConfigHash,
} from "@sciencediscovery/idea-tree";

import { SessionStore } from "../store.js";
import { createIdeaTreeArtifactResolver } from "./artifact-resolver.js";

test("CAS resolver verifies exact Session, completed producer, content, and executor without restricting Workflow roles", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "sciencediscovery-artifact-resolver-"));
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const project = await store.createProject("Artifact resolver");
  const session = await store.createSession(project.id, "Producer", {}, {}, { allowUnconfiguredModel: true });
  const otherSession = await store.createSession(project.id, "Other", {}, {}, { allowUnconfiguredModel: true });
  const specialist = await store.createSpecialist({
    connectorIds: [],
    description: "Frozen creative",
    enabledSkillIds: [],
    instructions: "Produce one JSON candidate.",
    name: "Frozen creative",
  });
  const configHash = specialistConfigHash(specialist);
  const executor = createExecutorDescriptor({
    key: "resolver-fixture",
    kind: "workflow_skill",
    leafRoles: [{
      role: "creative",
      specialistConfigHash: configHash,
      specialistId: specialist.id,
      specialistUpdatedAt: specialist.updatedAt,
    }],
    preflightRoles: [],
    resultAuthority: { key: "resolver-authority", version: "1.0.0" },
    resultContract: "leaf-workflow-result/v1",
    scoreSpec: {
      direction: "maximize",
      maximum: 10,
      minimum: 1,
      name: "resolver-score",
      rubricVersion: "resolver-v1",
    },
    version: "1.0.0",
    workflowSkill: { hash: "resolver-workflow-hash", id: "resolver-workflow", revision: 1, version: "1.0.0" },
  });
  const run = await store.createSessionRun({
    prompt: "produce",
    sessionId: session.id,
    settingsSnapshot: {
      ...store.resolveRuntimeSettings(session.id).effective,
      ideaTreeExecutor: executor,
    },
  });
  const producer = await store.createSubagent(session.id, run.id, {
    description: "Produce candidate",
    prompt: "Produce the governed candidate JSON.",
    specialistId: specialist.id,
    subagentType: "general-purpose",
  }, { specialistConfigHash: configHash });
  producer.status = "completed";
  producer.finishedAt = new Date().toISOString();
  await store.updateSubagent(producer);

  const cas = new CasStore(dataDir);
  const bytes = Buffer.from('{"candidate":"X"}\n');
  const content = await cas.put(bytes);
  const { artifact, version } = await store.createArtifactVersion({
    content,
    kind: "json",
    logicalName: `idea-tree/tree-test/node-test/${producer.id}/creative/candidate.json`,
    mediaType: "application/json",
    origin: "llm_declared",
    sessionId: session.id,
    turnId: producer.id,
  });
  const resolver = createIdeaTreeArtifactResolver(store, cas);
  const input = {
    artifactId: artifact.id,
    executor,
    role: "creative",
    sessionId: session.id,
    versionId: version.id,
  };

  const resolved = await resolver.resolve(input);
  assert.deepEqual(Buffer.from(resolved.bytes), bytes);
  assert.equal(resolved.snapshot.versionId, version.id);
  assert.equal(resolved.snapshot.producerExecutionId, producer.id);
  assert.equal(resolved.snapshot.producerSpecialistConfigHash, configHash);

  const reassignedRole = await resolver.resolve({ ...input, role: "workflow-selected-role" });
  assert.equal(reassignedRole.snapshot.role, "workflow-selected-role");
  await assert.rejects(
    resolver.resolve({ ...input, sessionId: otherSession.id }),
    (error: unknown) => error instanceof IdeaTreeRuntimeError && error.code === "ARTIFACT_VERSION_INVALID",
  );
  await assert.rejects(
    resolver.resolve({ ...input, executor: { ...executor, fingerprint: `sha256:${"0".repeat(64)}` } }),
    (error: unknown) => error instanceof IdeaTreeRuntimeError && error.code === "ARTIFACT_EXECUTOR_MISMATCH",
  );
  const flexibleExecutor = createExecutorDescriptor({
    key: IDEA_TREE_TEAM_CONTRACT.executorKey,
    kind: "workflow_skill",
    leafRoles: [],
    preflightRoles: [],
    resultAuthority: { ...IDEA_TREE_TEAM_CONTRACT.resultAuthority },
    resultContract: IDEA_TREE_TEAM_CONTRACT.resultContract,
    scoreSpec: { ...IDEA_TREE_TEAM_CONTRACT.scoreSpec },
    version: IDEA_TREE_TEAM_CONTRACT.executorVersion,
    workflowSkill: { hash: "current-markdown", id: "idea-tree-team", revision: 5, version: "5.0.0" },
  });
  const flexibleRun = await store.createSessionRun({
    prompt: "produce from current workflow",
    sessionId: session.id,
    settingsSnapshot: {
      ...store.resolveRuntimeSettings(session.id).effective,
      ideaTreeExecutor: flexibleExecutor,
    },
  });
  const flexibleProducer = await store.createSubagent(session.id, flexibleRun.id, {
    description: "Produce a workflow-selected artifact",
    prompt: "Produce the artifact selected by workflow.md.",
    specialistId: specialist.id,
    subagentType: "general-purpose",
  }, { specialistConfigHash: configHash });
  flexibleProducer.status = "completed";
  flexibleProducer.finishedAt = new Date().toISOString();
  await store.updateSubagent(flexibleProducer);
  const flexibleBytes = Buffer.from('{"evidence":"Y"}\n');
  const flexibleContent = await cas.put(flexibleBytes);
  const flexibleArtifact = await store.createArtifactVersion({
    content: flexibleContent,
    kind: "json",
    logicalName: `idea-tree/tree-test/preflight/${flexibleProducer.id}/evidence.json`,
    mediaType: "application/json",
    origin: "llm_declared",
    sessionId: session.id,
    turnId: flexibleProducer.id,
  });
  const flexibleResolved = await resolver.resolve({
    artifactId: flexibleArtifact.artifact.id,
    executor: flexibleExecutor,
    role: "workflow-evidence",
    sessionId: session.id,
    versionId: flexibleArtifact.version.id,
  });
  assert.deepEqual(Buffer.from(flexibleResolved.bytes), flexibleBytes);
  assert.equal(flexibleResolved.snapshot.role, "workflow-evidence");
  assert.equal(flexibleResolved.snapshot.producerSpecialistId, specialist.id);
});

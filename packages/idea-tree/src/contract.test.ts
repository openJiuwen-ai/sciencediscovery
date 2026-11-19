import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import {
  IDEA_TREE_TEAM_CONTRACT,
  ideaTreeExecutorFingerprintPayload,
  matchesIdeaTreeTeamContract,
} from "./contract.js";
import { createExecutorDescriptor } from "./runtime.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"],
});

function descriptor() {
  return {
    key: IDEA_TREE_TEAM_CONTRACT.executorKey,
    version: IDEA_TREE_TEAM_CONTRACT.executorVersion,
    kind: "workflow_skill",
    fingerprint: "sha256:fixture",
    preflightRequired: true,
    preflightRoles: [],
    leafRoles: [],
    resultAuthority: IDEA_TREE_TEAM_CONTRACT.resultAuthority,
    resultContract: IDEA_TREE_TEAM_CONTRACT.resultContract,
    scoreSpec: IDEA_TREE_TEAM_CONTRACT.scoreSpec,
    workflowSkill: { id: IDEA_TREE_TEAM_CONTRACT.executorKey, hash: "hash", revision: 1, version: "1.0.0" },
  } as any;
}

test("Idea Tree contract accepts v5 and legacy v4 shape but rejects drift", () => {
  const current = descriptor();
  assert.equal(matchesIdeaTreeTeamContract(current), true);
  assert.equal(matchesIdeaTreeTeamContract({ ...current, resultContract: "changed" }), false);
  const { fingerprint: _fingerprint, ...withoutFingerprint } = current;
  assert.deepEqual(ideaTreeExecutorFingerprintPayload(withoutFingerprint), {
    key: current.key,
    version: current.version,
    kind: current.kind,
    preflightRoles: [],
    leafRoles: [],
    resultAuthority: current.resultAuthority,
    resultContract: current.resultContract,
    scoreSpec: current.scoreSpec,
    workflowSkill: { id: current.key },
    preflightRequired: true,
  });
});

test("executor descriptors receive stable fingerprints for equivalent input", () => {
  const input = descriptor();
  const first = createExecutorDescriptor(input);
  const second = createExecutorDescriptor({ ...input, fingerprint: undefined });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.match(first.fingerprint, /^sha256:/);
});

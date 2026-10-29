// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { ResearchPackageIds, remapRunEvent } from "./research-package-history.js";
import { verifyResearchCopy } from "./research-snapshot-integrity.js";
import { portableShellResult } from "./research-shell-result.js";
import type { ShellExecutionResult } from "@sciencediscovery/schema";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

for (const state of ["completed", "failed", "cancelled"]) test(`research copy preserves ${state} shell evidence while excluding source-runner receipts`, () => {
  const ids = new ResearchPackageIds();
  const result = { executionId: "exec", environmentRevisionId: "env", language: "shell", stdout: "original output\n", stderr: "original error", exitCode: state === "completed" ? 0 : 1,
    workspaceSnapshot: { runnerId: "remote", objectId: "sha256:source", pool: "agent-state", size: 1, mediaType: "application/json" },
    workspaceVersion: { runnerId: "remote", objectId: "sha256:version", pool: "agent-state", size: 1, mediaType: "application/json" } } as unknown as ShellExecutionResult;
  const row = { id: "shell", sessionId: "source", turnId: "turn", state, result };
  const source = { sessions: [{ session: { id: "source" }, shellExecutions: [row] }] };
  const restored = { ...remapRunEvent(row, ids), id: ids.id(row.id), result: portableShellResult(remapRunEvent(result, ids)) };
  const target = { sessions: [{ session: { id: ids.id("source") }, shellExecutions: [restored] }] };
  const sessions = new Map([["source", ids.id("source")]]);
  assert.doesNotThrow(() => verifyResearchCopy(source, target, ids, sessions, "project"));
  assert.equal(restored.result.stdout, result.stdout);
  assert.equal(restored.result.environmentRevisionId, ids.id("env"));
  restored.result.stdout = "truncated";
  assert.throws(() => verifyResearchCopy(source, target, ids, sessions, "project"), /shellExecutions.result/);
});

test("empty restored stream containers are equivalent but observed events cannot disappear", () => {
  const ids = new ResearchPackageIds(), targetId = ids.id("source");
  const source = { sessions: [{ session: { id: "source" }, runEvents: [] as unknown[] }] };
  const target = { sessions: [{ session: { id: targetId }, runEvents: [{ runId: ids.id("run"), streams: [{ streamId: "main", events: [] }] }] }] };
  const sessions = new Map([["source", targetId]]);
  assert.doesNotThrow(() => verifyResearchCopy(source, target, ids, sessions, "p"));
  source.sessions[0]!.runEvents = [{ runId: "run", streams: [{ streamId: "main", events: [{ sequence: 1, createdAt: "2026-10-20", event: { type: "message", text: "must survive" } }] }] }];
  assert.throws(() => verifyResearchCopy(source, target, ids, sessions, "p"), /run event streams/);
});

for (const [sourceStatus, restoredStatus] of [["queued", "cancelled"], ["running", "cancelled"], ["failed", "failed"], ["completed", "completed"]] as const) test(`research copy integrity preserves reviewer task state ${sourceStatus}`, () => {
  const ids = new ResearchPackageIds();
  const targetSession = ids.id("source");
  const targetReview = ids.id("review");
  const targetTask = ids.id("task");
  const targetFeedback = ids.id("feedback");
  const source = { sessions: [{ session: { id: "source" }, validations: {
    artifactReviews: [{ id: "review" }], reviews: [],
    reviewerAuditTasks: [{ id: "task", status: sourceStatus, artifactVersionIds: [], reviewIds: ["review"] }],
    reviewFeedback: [{ id: "feedback", status: "ready", artifactVersionIds: [], reviewIds: ["review"] }],
  } }] };
  const target = { sessions: [{ session: { id: targetSession }, validations: {
    artifactReviews: [{ id: targetReview }], reviews: [],
    reviewerAuditTasks: [{ id: targetTask, status: restoredStatus, artifactVersionIds: [], reviewIds: [targetReview] }],
    reviewFeedback: [{ id: targetFeedback, status: "dismissed", artifactVersionIds: [], reviewIds: [targetReview] }],
  } }] };
  const sessions = new Map([["source", targetSession]]);
  assert.doesNotThrow(() => verifyResearchCopy(source, target, ids, sessions, "project"));
});

for (const [sourceStatus, restoredStatus] of [["ready", "dismissed"], ["dismissed", "dismissed"], ["consumed", "consumed"]] as const) test(`research copy integrity preserves review feedback state ${sourceStatus}`, () => {
  const ids = new ResearchPackageIds();
  const targetSession = ids.id("source");
  const targetFeedback = ids.id("feedback");
  const source = { sessions: [{ session: { id: "source" }, validations: {
    artifactReviews: [], reviews: [], reviewerAuditTasks: [],
    reviewFeedback: [{ id: "feedback", status: sourceStatus, artifactVersionIds: [], reviewIds: [] }],
  } }] };
  const target = { sessions: [{ session: { id: targetSession }, validations: {
    artifactReviews: [], reviews: [], reviewerAuditTasks: [],
    reviewFeedback: [{ id: targetFeedback, status: restoredStatus, artifactVersionIds: [], reviewIds: [] }],
  } }] };
  const sessions = new Map([["source", targetSession]]);
  assert.doesNotThrow(() => verifyResearchCopy(source, target, ids, sessions, "project"));
});

test("research copy integrity rejects a reviewer reference that was not restored", () => {
  const ids = new ResearchPackageIds();
  const targetSession = ids.id("source");
  const source = { sessions: [{ session: { id: "source" }, validations: {
    artifactReviews: [], reviews: [], reviewerAuditTasks: [{ id: "task", status: "failed", artifactVersionIds: [], reviewIds: ["missing-review"] }], reviewFeedback: [],
  } }] };
  const target = { sessions: [{ session: { id: targetSession }, validations: {
    artifactReviews: [], reviews: [], reviewerAuditTasks: [{ id: ids.id("task"), status: "failed", artifactVersionIds: [], reviewIds: [] }], reviewFeedback: [],
  } }] };
  const sessions = new Map([["source", targetSession]]);
  assert.throws(() => verifyResearchCopy(source, target, ids, sessions, "project"), /validation\.reviewerAuditTasks\.reviewIds\[missing-review\]/);
});

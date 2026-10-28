// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { importResearchPackage, sha256, type ExportInput } from "@sciencediscovery/research-package";
import type { MemoryGraphSnapshot } from "@sciencediscovery/memory";
import { researchTrajectoryFixture } from "../../../test/support/research-package.fixture.js";
import { buildConversationBranch } from "./conversation-branches.js";
import { countExport, type ExportArtifact, type ExportSessionRecord } from "./research-snapshots.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
type Records = { sessions: ExportSessionRecord[]; artifacts: ExportArtifact[]; memoryGraph: MemoryGraphSnapshot };

function branchFixture() {
  const fixture = researchTrajectoryFixture();
  const imported = importResearchPackage(fixture.bytes);
  const records = structuredClone(imported.records) as Records;
  const source = records.sessions[0]!;
  source.artifactAnnotations = [];
  source.validations = { artifactReviews: [], reviews: [], reviewerAuditTasks: [], reviewFeedback: [] };
  source.messages[1]!.modelContext = [{ role: "assistant", content: "Canonical model response with tool history" }];
  const later = "2026-10-20T11:00:00.000Z";
  source.messages.push({ id: "later-question", role: "user", content: "Later research", createdAt: later },
    { id: "later-answer", role: "assistant", content: "Later conclusion", createdAt: later });
  source.runs.push({ ...source.runs[0]!, id: "later-run", createdAt: later, finishedAt: later,
    userMessageId: "later-question", assistantMessageId: "later-answer", queueOrder: 2 });
  source.runEvents!.push({ ...structuredClone(source.runEvents![0]!), runId: "later-run" });
  source.runEvents![0]!.streams[0]!.events.push({ ...source.runEvents![0]!.streams[0]!.events[0]!, sequence: 99, createdAt: later });
  const detail = structuredClone(source.trajectory.details[0]!);
  detail.entry = { ...detail.entry, id: "later-input", runId: "later-run", timestamp: later };
  source.trajectory.index.entries.push(detail.entry);
  source.trajectory.details.push(detail);
  const futureBytes = Buffer.from("Future data must not leak into earlier research\n");
  const futureHash = sha256(futureBytes);
  const artifact = records.artifacts[0]!;
  artifact.versions.push({ ...artifact.versions[0]!, id: "later-version", version: 5, createdAt: later,
    turnId: "later-run", content: { hash: futureHash, size: futureBytes.length }, objectPath: futureHash });
  artifact.currentVersion = 5;
  const file = source.workspaceProvenance[0]!;
  const oldHash = file.currentRevision.contentHash!;
  file.revisions.push({ ...file.currentRevision, id: "later-revision", createdAt: later, modifiedAt: later,
    runId: "later-run", executionRunId: undefined, contentHash: futureHash, size: futureBytes.length,
    parentRevisionId: file.currentRevision.id, artifactVersionIds: ["later-version"] });
  file.currentRevision = file.revisions.at(-1)!;
  file.file.currentRevisionId = file.currentRevision.id;
  source.workspace[0] = { path: file.file.path, objectPath: futureHash, size: futureBytes.length, modifiedAt: later };
  records.memoryGraph.nodes.push({ id: "future-node", labels: ["Artifact"], properties: {
    artifact_id: artifact.id, version: 5, content_hash: futureHash, session_id: source.session.id,
  } });
  const input: ExportInput = { source: imported.manifest.source, records,
    objects: [...imported.objects].map(([path, bytes]) => ({ path, bytes })).concat([{ path: futureHash, bytes: Uint8Array.from(futureBytes) }]) };
  return { input, records, source, oldHash, futureHash };
}

test("fork selects the message prefix, exact old file bytes and matching evidence without mutating the source", async () => {
  const { input, source, oldHash, futureHash } = branchFixture();
  const original = structuredClone(input);
  const output = await buildConversationBranch(input, source.session.id, "fixture-answer", async () => { throw new Error("missing"); }, countExport);
  const branch = output.records as Records;
  const copy = branch.sessions[0]!;
  assert.deepEqual(copy.messages.map((row) => row.id), ["fixture-prompt", "fixture-answer"]);
  assert.deepEqual(copy.messages[1]!.modelContext, source.messages[1]!.modelContext);
  assert.deepEqual(copy.runs.map((row) => row.id), ["run-source"]);
  assert.deepEqual(copy.runEvents?.map((row) => row.runId), ["run-source"]);
  assert.ok(copy.runEvents![0]!.streams[0]!.events.every((event) => event.sequence !== 99));
  assert.deepEqual(copy.trajectory.details.map((row) => row.entry.id), ["input-source", "thinking-source"]);
  assert.equal(copy.workspace[0]!.objectPath, oldHash);
  assert.equal(copy.workspaceProvenance[0]!.currentRevision.id, "revision-current");
  assert.deepEqual(branch.artifacts[0]!.versions.map((row) => row.version), [4]);
  assert.equal(branch.artifacts[0]!.currentVersion, 4);
  assert.deepEqual(branch.memoryGraph.nodes.map((node) => node.id), ["code", "artifact"]);
  assert.deepEqual(branch.memoryGraph.edges.map((edge) => [edge.source, edge.target]), [["code", "artifact"]]);
  assert.ok(!output.objects?.some((object) => object.path.replace(/^objects\//, "") === futureHash));
  assert.deepEqual(input, original);
});

test("fork recovers a historical file by its exact CAS hash", async () => {
  const { input, source, oldHash } = branchFixture();
  const original = input.objects!.find((object) => object.path.replace(/^objects\//, "") === oldHash)!;
  input.objects = input.objects!.filter((object) => object !== original);
  const reads: string[] = [];
  const output = await buildConversationBranch(input, source.session.id, "fixture-answer", async (hash) => {
    reads.push(hash); assert.equal(hash, oldHash); return original.bytes;
  }, countExport);
  assert.deepEqual(reads, [oldHash]);
  assert.equal((output.records as Records).sessions[0]!.workspace[0]!.objectPath, oldHash);
  assert.deepEqual(output.objects!.find((object) => object.path === oldHash)!.bytes, original.bytes);
});

test("missing historical file payload is disclosed instead of substituting the latest file", async () => {
  const { input, source, oldHash, futureHash } = branchFixture();
  input.objects = input.objects!.filter((object) => object.path.replace(/^objects\//, "") !== oldHash);
  const output = await buildConversationBranch(input, source.session.id, "fixture-answer", async () => { throw new Error("expired"); }, countExport);
  assert.deepEqual((output.records as Records).sessions[0]!.workspace, []);
  assert.ok(output.omissions?.some((item) => item.includes("results/verified.csv") && item.includes("原始内容已不可用")));
  assert.ok(!output.objects!.some((object) => object.path === futureHash));
});

test("only completed formal assistant replies can be forked", async () => {
  const { input, source } = branchFixture();
  const read = async () => { throw new Error("not read"); };
  await assert.rejects(buildConversationBranch(input, source.session.id, "fixture-prompt", read, countExport), /已完成的正式回复/);
  source.runs[0]!.status = "failed";
  await assert.rejects(buildConversationBranch(input, source.session.id, "fixture-answer", read, countExport), /已完成的正式回复/);
});

test("trajectory ownership resolves request IDs and exact contexts instead of treating agent runs as session runs", async () => {
  const { input, source } = branchFixture();
  const template = structuredClone(source.trajectory.details[0]!);
  const oldTime = source.messages[1]!.createdAt;
  const add = (id: string, fields: Partial<typeof template.entry>) => {
    const entry = { ...template.entry, id, timestamp: oldTime, runId: undefined,
      requestExecutionId: undefined, contextId: undefined, ...fields };
    (entry.timestamp ? source.trajectory.index.entries : source.trajectory.index.untimedEntries!).push(entry);
    source.trajectory.details.push({ ...structuredClone(template), entry });
  };
  source.trajectory.index.untimedEntries = [];
  add("old-journal", { runId: "shared-agent-run", requestExecutionId: "run-source", contextId: "old-context" });
  // Even if an old producer lacks reliable event times, ownership must exclude later work.
  add("later-journal", { runId: "shared-agent-run", requestExecutionId: "later-run", contextId: "later-context" });
  add("old-input", { runId: "shared-agent-run", contextId: "old-context", timestamp: null });
  add("later-input", { runId: "shared-agent-run", contextId: "later-context", timestamp: null });
  add("old-segment", { contextId: "old-context" });
  add("ambiguous-state", { runId: "shared-agent-run", timestamp: null });
  add("unlinked-segment", {});
  add("unique-journal", { runId: "unique-agent-run", requestExecutionId: "run-source" });
  add("unique-context", { runId: "unique-agent-run", contextId: "unique-context", timestamp: null });
  add("unique-segment", { contextId: "unique-context" });
  const original = structuredClone(input);
  const output = await buildConversationBranch(input, source.session.id, "fixture-answer", async () => { throw new Error("missing"); }, countExport);
  const copy = (output.records as Records).sessions[0]!;
  assert.deepEqual(copy.trajectory.details.map((row) => row.entry.id), ["input-source", "thinking-source",
    "old-journal", "old-input", "old-segment", "unique-journal", "unique-context", "unique-segment"]);
  assert.deepEqual(copy.trajectory.details.find((row) => row.entry.id === "old-input")!.context, template.context);
  assert.ok(output.omissions?.some((item) => item.includes("轨迹") && item.includes("请求归属")));
  assert.deepEqual(input, original);
});

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
  // A search that finished before the selected reply travels with the branch; one
  // that finished after it must not (#1176 review F2). Their candidate sources are
  // package objects, so a kept entry needs its object and a dropped one must not
  // bring its own (#1176 review F4).
  const answerAt = Date.parse(source.messages[1]!.createdAt);
  const evolveBefore = new Date(answerAt - 3_600_000).toISOString();
  const evolveAfter = new Date(answerAt + 3_600_000).toISOString();
  const candidateBytes = Buffer.from("print('candidate source kept by the branch')\n");
  const candidateHash = sha256(candidateBytes);
  const droppedCandidateBytes = Buffer.from("print('candidate source of a search past the reply')\n");
  const droppedCandidateHash = sha256(droppedCandidateBytes);
  (records as Records & { evolve?: unknown }).evolve = {
    runs: [
      { events: [], run: { createdAt: evolveBefore, finishedAt: evolveBefore, id: "evolve-before", sessionId: source.session.id } },
      { events: [], run: { createdAt: evolveAfter, finishedAt: evolveAfter, id: "evolve-after", sessionId: source.session.id } },
    ],
    candidates: [
      { hash: "sha256:before", objectPath: candidateHash, runId: "evolve-before" },
      { hash: "sha256:after", objectPath: droppedCandidateHash, runId: "evolve-after" },
    ],
  };
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
    objects: [...imported.objects].map(([path, bytes]) => ({ path, bytes })).concat([
      { path: futureHash, bytes: Uint8Array.from(futureBytes) },
      { path: candidateHash, bytes: Uint8Array.from(candidateBytes) },
      { path: droppedCandidateHash, bytes: Uint8Array.from(droppedCandidateBytes) },
    ]) };
  return { input, records, source, oldHash, futureHash, candidateHash, droppedCandidateHash };
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

test("a branch carries only the searches that finished at or before its reply", async () => {
  // #1176 review F2: the evolve payload is part of the history the branch trims.
  // A run started after the branch point, and the candidate source of a run the
  // branch did not keep, must not reach the branch package.
  const { input, source, candidateHash, droppedCandidateHash } = branchFixture();
  const original = structuredClone(input);
  const output = await buildConversationBranch(input, source.session.id, "fixture-answer", async () => { throw new Error("missing"); }, countExport);
  const evolve = (output.records as Records & {
    evolve?: { candidates: Array<{ runId: string }>; runs: Array<{ run: { id: string } }> };
  }).evolve!;
  assert.deepEqual(evolve.runs.map((entry) => entry.run.id), ["evolve-before"]);
  assert.deepEqual(evolve.candidates.map((entry) => entry.runId), ["evolve-before"]);
  // #1176 review F4: the kept entry is only usable with its source object, and the
  // dropped search must not smuggle its own object into the branch.
  assert.ok(output.objects!.some((object) => object.path === candidateHash),
    "the kept search keeps its candidate source object");
  assert.ok(!output.objects!.some((object) => object.path === droppedCandidateHash),
    "a search the branch drops must not carry its candidate source object");
  assert.deepEqual(input, original);
});

test("fork recovers a historical file by its exact CAS hash", async () => {
  const { input, source, oldHash } = branchFixture();
  // A branch is built from a resident package, so every object here has its bytes;
  // the streamed form belongs to the background export (#1152 stage 2).
  const bytesOf = (object: unknown): Uint8Array => {
    const bytes = (object as { bytes?: Uint8Array } | undefined)?.bytes;
    assert.ok(bytes, "a resident package object carries its bytes");
    return bytes;
  };
  const original = input.objects!.find((object) => object.path.replace(/^objects\//, "") === oldHash)!;
  const originalBytes = bytesOf(original);
  input.objects = input.objects!.filter((object) => object !== original);
  const reads: string[] = [];
  const output = await buildConversationBranch(input, source.session.id, "fixture-answer", async (hash) => {
    reads.push(hash); assert.equal(hash, oldHash); return originalBytes;
  }, countExport);
  assert.deepEqual(reads, [oldHash]);
  assert.equal((output.records as Records).sessions[0]!.workspace[0]!.objectPath, oldHash);
  assert.deepEqual(bytesOf(output.objects!.find((object) => object.path === oldHash)!), originalBytes);
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

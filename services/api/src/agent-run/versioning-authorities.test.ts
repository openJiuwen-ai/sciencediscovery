// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { CasStore, VersionStore } from "@sciencediscovery/cas";
import type { ExecutionRun, Subagent } from "@sciencediscovery/schema";
import { SessionStore } from "../store.js";
import { versioningAuthorities } from "./versioning-authorities.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "authority-scope-"));
  const store = new SessionStore(root);
  await store.load();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const project = await store.createProject("Snapshot isolation");
  const session = await store.createSession(project.id, "Research", {}, {}, { allowUnconfiguredModel: true });
  const a = await store.createSubagent(session.id, "parent-run", { description: "A", prompt: "Research A" });
  const b = await store.createSubagent(session.id, "parent-run", { description: "B", prompt: "Research B" });
  const versions = new VersionStore(root);
  const parent = versioningAuthorities(store, { sessionId: session.id, executionId: "parent-run" });
  const child = versioningAuthorities(store, { sessionId: session.id, executionId: a.id, subagentId: a.id });
  return { root, store, session, a, b, versions, parent, child };
}

test("sibling trajectory growth leaves a child's authority snapshot identical and the parent's catalog bounded", async (t) => {
  const f = await fixture(t);
  const before = await f.child();
  const parentBefore = await f.parent();
  const oldB = parentBefore.children.find((item) => item.id === f.b.id)!;
  const oldRecord = (await f.versions.readRecord<Subagent>(oldB.record, "SubagentAuthority")).value;
  const largeResult = "sibling-only-tool-output".repeat(100_000);
  f.b.steps.push({ id: "large", createdAt: new Date().toISOString(), kind: "tool", content: largeResult });
  f.b.status = "completed";
  await f.store.updateSubagent(f.b);
  // Snapshot collection must not clone the session-wide trajectories and filter afterwards.
  const list = t.mock.method(f.store, "listSubagents", () => { throw new Error("unscoped trajectory read"); });
  assert.deepEqual(await f.child(), before);
  const parentAfter = await f.parent();
  assert.equal(parentAfter.children.length, 2);
  assert.ok(JSON.stringify(parentAfter.children).length < 2_000);
  assert.ok(!JSON.stringify(parentAfter).includes("sibling-only-tool-output"));
  const newB = parentAfter.children.find((item) => item.id === f.b.id)!;
  assert.notDeepEqual(newB.record, oldB.record);
  assert.equal(newB.status, "completed");
  assert.deepEqual((await f.versions.readRecord<Subagent>(oldB.record)).value, oldRecord);
  assert.equal((await f.versions.readRecord<Subagent>(newB.record)).value.steps.at(-1)!.content, largeResult);
  assert.deepEqual((await f.parent()).children, parentAfter.children, "unchanged revisions reuse their references");
  const audit = await f.versions.putRecord("AuthorityScopeTest", parentAfter);
  await f.versions.validateClosure(audit);
  list.mock.restore();
  assert.equal(f.store.listSubagents(f.session.id).find((item) => item.id === f.b.id)!.steps.at(-1)!.content, largeResult,
    "UI and native task readers retain the full trajectory");
  t.diagnostic(`sibling trajectory=${Buffer.byteLength(largeResult)} bytes; parent directory=${Buffer.byteLength(JSON.stringify(parentAfter.children))} bytes; child snapshot unchanged`);
});

test("each execution captures its own provenance and inbox, including cancellation and timers", async (t) => {
  const f = await fixture(t);
  const blob = await new CasStore(f.root).put("execution output");
  for (const [agentId, executionId] of [["main", "parent-run"], [`subagent:${f.a.id}`, f.a.id], [`subagent:${f.b.id}`, f.b.id]]) {
    const owner = { sessionId: f.session.id, agentId: agentId! };
    f.store.notifications.complete(owner, executionId!, `result-${executionId}`);
    f.store.notifications.createTimer(owner, { dueAt: Date.now() + 60_000, message: `timer-${executionId}` });
    await f.store.appendExecutionRun({
      id: executionId!, sessionId: f.session.id, turnId: executionId!, code: blob, stdout: blob, stderr: blob,
      cgroupMode: "none", createdFiles: [], modifiedFiles: [], environmentRevisionId: null, exitCode: 0,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), kernelId: "test",
      kernelMode: null, language: null, networkPolicy: "none", permissionEpochId: "test", runnerVersion: "test",
      sandbox: "bubblewrap", status: "succeeded", tool: "run_shell", toolVersion: "test", workingDirectory: "/workspace",
    } satisfies ExecutionRun);
  }
  f.store.notifications.stopAgent({ sessionId: f.session.id, agentId: `subagent:${f.a.id}` });
  const child = await f.child();
  const parent = await f.parent();
  assert.deepEqual(child.executions.map((run) => run.id), [f.a.id]);
  assert.deepEqual(parent.executions.map((run) => run.id), ["parent-run"]);
  assert.equal(child.children.length, 0);
  assert.equal(child.task!.id, f.a.id);
  const inbox = child.notifications as { agents: { agent: string; stopped: number }[]; notifications: { agent: string }[]; timers: { state: string }[] };
  assert.deepEqual(inbox.agents.map((gate) => [gate.agent, gate.stopped]), [[`subagent:${f.a.id}`, 1]]);
  assert.deepEqual(inbox.notifications.map((notice) => notice.agent), [`subagent:${f.a.id}`]);
  assert.deepEqual(inbox.timers.map((timer) => timer.state), ["cancelled"]);
  await f.versions.validateClosure(await f.versions.putRecord("AuthorityScopeTest", child));
});

test("task revisions retain continuation history across updates and restart, with closure validation intact", async (t) => {
  const f = await fixture(t);
  const history = [{ role: "user", content: "Original task" }, { role: "assistant", content: "Partial findings" }];
  f.a.contextRef = await f.versions.putRecord("SubagentContext", { history });
  f.a.status = "failed";
  await f.store.updateSubagent(f.a);
  const before = await f.child();
  await f.store.updateSubagentBrief(f.session.id, f.a.id, { brief: {
    goal: "Continue from partial findings", constraints: ["Keep existing evidence"], collaborationRules: ["Report to parent"], outputRequirements: ["Summary"],
  } });
  const after = await f.child();
  assert.notDeepEqual(after.task!.record, before.task!.record);
  const oldTask = (await f.versions.readRecord<Subagent>(before.task!.record)).value;
  assert.deepEqual((await f.versions.readRecord(oldTask.contextRef!, "SubagentContext")).value, { history });
  f.store.close();
  const reopened = new SessionStore(f.root);
  await reopened.load();
  t.after(() => reopened.close());
  const restarted = await versioningAuthorities(reopened, { sessionId: f.session.id, executionId: f.a.id, subagentId: f.a.id })();
  assert.deepEqual(restarted.task, after.task);
  const audit = await f.versions.putRecord("AuthorityScopeTest", restarted);
  await f.versions.validateClosure(audit);
  await rm(join(f.root, "versioning", "agent-state", "blobs", "sha256", oldTask.contextRef!.digest.slice(7)));
  await assert.rejects(f.versions.validateClosure(audit), /ENOENT|missing/i);
});

test("an unknown or cross-session child cannot silently fall back to the global task catalog", async (t) => {
  const f = await fixture(t);
  await assert.rejects(versioningAuthorities(f.store, { sessionId: f.session.id, executionId: "foreign", subagentId: "foreign" })(), /Subagent not found/);
  const other = await f.store.createSession(f.session.projectId, "Other", {}, {}, { allowUnconfiguredModel: true });
  await assert.rejects(versioningAuthorities(f.store, { sessionId: other.id, executionId: f.a.id, subagentId: f.a.id })(), /Subagent not found/);
});


test("shell and transfer snapshots keep owner evidence without collecting sibling work", async (t) => {
  const f = await fixture(t);
  const source = join(f.root, "source");
  const target = join(f.root, "target");
  await mkdir(source); await mkdir(target);
  for (const agentId of ["main", `subagent:${f.a.id}`, `subagent:${f.b.id}`]) {
    const owner = { sessionId: f.session.id, agentId };
    await f.store.shellExecutions.start(owner, { runnerId: "local", workspaceId: "test", turnId: agentId },
      () => { throw new Error("Runner must not be reached"); },
      async () => { throw new Error("Submission failed before acceptance"); });
    const transfer = f.store.transfers.start(owner, {
      sourceWorkspaceId: "source", targetWorkspaceId: "target", files: [{ sourcePath: "missing", targetPath: "result" }],
    }, { resolve: (id) => ({ id, root: id === "source" ? source : target }) });
    await f.store.transfers.wait(transfer.id, owner);
  }
  const child = await f.child();
  assert.deepEqual(child.shellExecutions.map((item) => item.agentId), [`subagent:${f.a.id}`]);
  assert.deepEqual(child.transfers.map((item) => item.agentId), [`subagent:${f.a.id}`]);
  assert.equal(child.shellExecutions[0]!.state, "unknown");
  assert.equal(child.transfers[0]!.state, "failed");
  const parent = await f.parent();
  assert.deepEqual(parent.shellExecutions.map((item) => item.agentId), ["main"]);
  assert.deepEqual(parent.transfers.map((item) => item.agentId), ["main"]);
  assert.equal(f.store.shellExecutions.snapshot(f.session.id).length, 3, "global audit remains available");
  assert.equal(f.store.transfers.snapshot(f.session.id).length, 3);
});

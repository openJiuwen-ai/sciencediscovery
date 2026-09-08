// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RefStore, VersionStore } from "@sciencediscovery/cas";
import type { ExecutionOwner, ShellExecutionRequest, ShellExecutionResult } from "@sciencediscovery/schema";
import { ExecutionManager } from "./execution-manager.js";

const owner: ExecutionOwner = { agentId: "main", sessionId: "session" };
function request(root: string, id: string): ShellExecutionRequest {
  return { agentId: owner.agentId, executionId: id, code: "echo result", workspaceRoot: root,
    permissionEpoch: { sessionId: owner.sessionId } as ShellExecutionRequest["permissionEpoch"] };
}
function result(id: string): ShellExecutionResult {
  return { executionId: id, environmentRevisionId: "latest", exitCode: 0, stdout: "done", stderr: "",
    createdFiles: [], modifiedFiles: [], language: "shell", kernelMode: "ephemeral", kernelId: `ephemeral:${id}`,
    cgroupMode: "none", sandbox: "bubblewrap", environmentVariables: {}, networkPolicy: "none", runnerVersion: "test",
    workingDirectory: "/workspace", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Execution did not reach expected state");
    await new Promise((done) => setTimeout(done, 5));
  }
}
async function fixture(context: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(resolve(tmpdir(), "execution-manager-"));
  const workspace = resolve(root, "workspace");
  await mkdir(workspace);
  const manager = new ExecutionManager(root);
  context.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { root, workspace, manager };
}

test("background admission does not block observers; one workspace queues, another runs, CAS commits before release", async (context) => {
  const { manager, workspace, root } = await fixture(context);
  let release!: () => void;
  const latch = new Promise<void>((done) => { release = done; });
  assert.equal(manager.start(request(workspace, "one"), async (_signal, log) => {
    const bytes = Buffer.from("训练中\n");
    log("stdout", bytes.subarray(0, 2));
    log("stdout", bytes.subarray(2));
    await latch;
    await writeFile(resolve(workspace, "result.txt"), "first");
    return result("one");
  }).state, "queued");
  await until(() => manager.get("one", owner).state === "running");
  manager.start(request(workspace, "two"), async () => {
    assert.ok(manager.get("one", owner).version, "the preceding writer committed its version before release");
    return result("two");
  });
  assert.equal(manager.get("two", owner).state, "queued");
  assert.equal(manager.logs("one", owner).chunks.map((chunk) => chunk.text).join(""), "训练中\n");
  assert.throws(() => manager.get("one", { ...owner, agentId: "other" }), /not found/);
  assert.throws(() => manager.start(request(workspace, "one"), async () => result("one")), /already been used/);
  const second = resolve(root, "second-workspace");
  await mkdir(second);
  manager.start(request(second, "parallel"), async () => result("parallel"));
  await until(() => manager.get("parallel", owner).state === "completed");
  assert.equal(manager.get("one", owner).state, "running");
  release();
  await until(() => manager.get("two", owner).state === "completed");
  const versions = new VersionStore(root);
  const ref = manager.get("one", owner).version!;
  await versions.validateClosure(ref);
  const record = await versions.readRecord<{ workspace: typeof ref; stdout: typeof ref }>(ref, "WorkspaceExecution");
  assert.equal((await versions.readState(record.value.stdout)).toString(), "训练中\n");
  const refs = await RefStore.open(versions);
  try { assert.ok(refs.roots().some((entry) => entry.digest === ref.digest)); } finally { refs.close(); }
});

test("cancel waits for process join; queued cancellation never starts or replays a command", async (context) => {
  const { manager, workspace } = await fixture(context);
  let joined = false;
  manager.start(request(workspace, "running"), async (signal, log) => {
    log("stderr", Buffer.from("progress"));
    await new Promise<void>((done) => signal.addEventListener("abort", () => setTimeout(done, 20), { once: true }));
    joined = true;
    throw new Error("aborted");
  });
  await until(() => manager.get("running", owner).state === "running");
  let queuedRan = false;
  manager.start(request(workspace, "queued"), async () => { queuedRan = true; return result("queued"); });
  manager.cancel("queued", owner);
  assert.equal(manager.cancel("running", owner).state, "running");
  assert.equal(joined, false);
  await until(() => manager.get("running", owner).state === "cancelled" && manager.get("queued", owner).state === "cancelled");
  assert.equal(joined, true);
  assert.equal(queuedRan, false);
  assert.ok(manager.get("running", owner).version);
  assert.equal(manager.logs("running", owner).chunks[0]?.text, "progress");
});

test("restart retains completed results and marks unfinished records unknown without replay", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "execution-restart-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, "workspace");
  await mkdir(workspace);
  const first = new ExecutionManager(root);
  first.start(request(workspace, "finished"), async () => result("finished"));
  await until(() => first.get("finished", owner).state === "completed");
  await first.close();
  const db = new DatabaseSync(resolve(root, "runner-executions", "executions.sqlite"));
  db.prepare("INSERT INTO executions VALUES (?, ?, ?, ?)").run("lost", owner.sessionId, owner.agentId,
    JSON.stringify({ ...owner, id: "lost", state: "running", queuedAt: new Date().toISOString() }));
  db.close();
  const restarted = new ExecutionManager(root);
  try {
    assert.equal(restarted.get("finished", owner).result?.stdout, "done");
    assert.equal(restarted.get("lost", owner).state, "unknown");
    assert.match(restarted.get("lost", owner).error!, /not replayed/);
    assert.throws(() => restarted.start(request(workspace, "lost"), async () => result("lost")), /already been used/);
  } finally { await restarted.close(); }
});

test("log retention is explicit, paginated and does not stop execution", async (context) => {
  const { manager, workspace } = await fixture(context);
  manager.start({ ...request(workspace, "verbose"), maxOutputBytes: 25_000 }, async (_signal, log) => {
    log("stdout", Buffer.from("x".repeat(30_000)));
    return result("verbose");
  });
  await until(() => manager.get("verbose", owner).state === "completed");
  const first = manager.logs("verbose", owner);
  assert.equal(first.retentionTruncated, true);
  assert.equal(first.truncated, true);
  const second = manager.logs("verbose", owner, first.nextCursor);
  assert.ok(second.nextCursor > first.nextCursor);
  assert.equal(second.truncated, false);
  assert.equal([...first.chunks, ...second.chunks].reduce((sum, chunk) => sum + chunk.text.length, 0), 25_000);
});

test("workspace snapshot failure closes writer admission instead of claiming a committed version", async (context) => {
  const { manager, workspace } = await fixture(context);
  manager.start(request(workspace, "broken"), async () => {
    await rm(workspace, { recursive: true });
    return result("broken");
  });
  await until(() => manager.get("broken", owner).state === "failed");
  assert.equal(manager.get("broken", owner).version, undefined);
  assert.match(manager.get("broken", owner).error!, /version commit failed/);
  assert.throws(() => manager.start(request(workspace, "next"), async () => result("next")), /repair storage/);
});

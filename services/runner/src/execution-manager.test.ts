// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"] });
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RefStore, VersionStore, withWorkspaceMutation, withWorkspaceRetirement, workspaceHeadName } from "@sciencediscovery/cas";
import type { ExecutionOwner, ShellExecutionRequest, ShellExecutionResult } from "@sciencediscovery/schema";
import { ExecutionManager, ExecutionManagerError } from "./execution-manager.js";

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
async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Execution did not reach expected state within ${timeoutMs}ms`);
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

test("deletion admission failure is not a poisoned version store after a successful rollback", async (context) => {
  const { manager, workspace, root } = await fixture(context);
  await withWorkspaceRetirement(new VersionStore(root), [workspace], "rollback", async (_roots, reopen) => {
    manager.start(request(workspace, "blocked-delete"), async () => { assert.fail("closed Workspace executed"); });
    await until(() => manager.get("blocked-delete", owner).state === "failed");
    assert.match(manager.get("blocked-delete", owner).error!, /deleted/);
    reopen();
  });
  manager.start(request(workspace, "after-rollback"), async () => result("after-rollback"));
  await until(() => manager.get("after-rollback", owner).state === "completed");
});

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
  assert.equal(manager.start(request(workspace, "one"), async () => assert.fail("duplicate command launched")).state, "running");
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

test("external file publication waits for cancelled process join and the execution ref commit", async (context) => {
  const { manager, workspace, root } = await fixture(context);
  let joined = false;
  manager.start(request(workspace, "writer"), async (signal) => {
    await new Promise<void>((done) => signal.addEventListener("abort", () => setTimeout(done, 40), { once: true }));
    joined = true;
    await writeFile(resolve(workspace, "partial"), "cancelled output");
    throw new Error("cancelled");
  });
  await until(() => manager.get("writer", owner).state === "running");
  let published = false;
  const versions = new VersionStore(root);
  const upload = withWorkspaceMutation(versions, workspace, async () => {
    assert.equal(joined, true);
    assert.ok(manager.get("writer", owner).version);
    const refs = await RefStore.open(versions);
    try { assert.deepEqual(refs.head(workspaceHeadName(workspace)), manager.get("writer", owner).version); }
    finally { refs.close(); }
    await writeFile(resolve(workspace, "upload"), "new output"); published = true;
  }, { kind: "external-upload" });
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(published, false);
  assert.equal(manager.get("writer", owner).state, "running");
  manager.cancel("writer", owner);
  assert.equal(published, false);
  await upload;
  assert.equal(published, true);
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
    assert.throws(() => restarted.start(request(workspace, "lost"), async () => result("lost")), { code: "EXECUTION_ID_CONFLICT", statusCode: 409 });
    assert.equal(restarted.get("lost", owner).finishedAt, undefined);
    assert.equal(restarted.get("lost", owner).evidence, undefined);
    assert.throws(() => restarted.start(request(workspace, "new"), async () => result("new")), { code: "EXECUTION_RESOURCE_QUARANTINED" });
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

test("failed atomic ref publication never reports an unrooted Execution version", async (context) => {
  const { manager, workspace } = await fixture(context);
  context.mock.method(RefStore.prototype, "commit", async () => { throw new Error("injected ref publication failure"); });
  manager.start(request(workspace, "unrooted"), async () => result("unrooted"));
  await until(() => manager.get("unrooted", owner).state === "failed");
  const execution = manager.get("unrooted", owner);
  assert.equal(execution.version, undefined, "CAS bytes alone are not a committed Workspace version");
  assert.match(execution.error!, /ref publication failure/);
  assert.throws(() => manager.start(request(workspace, "later"), async () => result("later")), /repair storage/);
});

test("a caught HTTP denial still fails the managed execution and commits its partial workspace", async context => {
  const { manager, workspace, root } = await fixture(context);
  manager.start(request(workspace, "caught-denial"), async () => {
    await writeFile(resolve(workspace, "partial.txt"), "already wrote");
    return { ...result("caught-denial"), networkDeniedHosts: ["pypi.org:443"] };
  });
  await until(() => manager.get("caught-denial", owner).state === "failed");
  const record = manager.get("caught-denial", owner);
  assert.equal(record.result!.exitCode, 0, "retain actual process exit status rather than falsifying it");
  assert.deepEqual(record.result!.networkDeniedHosts, ["pypi.org:443"]);
  assert.ok(record.version);
  await new VersionStore(root).validateClosure(record.version!);
});

test("cancellation wins over a successful late process result without losing its audit", async context => {
  const { manager, workspace } = await fixture(context);
  manager.start(request(workspace, "late-success"), async signal => {
    await new Promise<void>(done => signal.addEventListener("abort", () => done(), { once: true }));
    return result("late-success");
  });
  await until(() => manager.get("late-success", owner).state === "running");
  manager.cancel("late-success", owner);
  await until(() => manager.get("late-success", owner).state === "cancelled");
  assert.equal(manager.get("late-success", owner).result!.exitCode, 0);
  assert.ok(manager.get("late-success", owner).version);
});

test("explicit Specialist handoff records execution receipts without snapshotting undeclared files", async (context) => {
  const { manager, workspace, root } = await fixture(context);
  manager.start({ ...request(workspace, "explicit"), explicitHandoff: true }, async () => {
    await writeFile(resolve(workspace, "private.txt"), "must-not-be-versioned");
    return result("explicit");
  });
  await until(() => !["queued", "running"].includes(manager.get("explicit", owner).state));
  const execution = manager.get("explicit", owner);
  assert.equal(execution.state, "completed", execution.error ?? "");
  assert.ok(execution.version, "execution receipt remains durable");
  assert.equal(execution.result?.workspaceSnapshot, undefined);
  const record = await new VersionStore(root).readRecord<{ workspace?: unknown }>(execution.version!, "WorkspaceExecution");
  assert.equal(record.value.workspace, undefined, "no file tree or undeclared bytes in the execution version");
});

test("identical concurrent submissions return one durable receipt and launch only once", async (context) => {
  const { manager, workspace } = await fixture(context);
  let launches = 0;
  const input = request(workspace, "same");
  const submissions = await Promise.all(Array.from({ length: 25 }, () => Promise.resolve().then(() => manager.submit(input, async () => {
    launches += 1;
    return result("same");
  }))));
  assert.equal(submissions.filter(submission => submission.accepted).length, 1);
  const receipt = submissions[0]!.execution.receipt!;
  assert.equal(receipt.revision, 1);
  assert.match(receipt.requestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(receipt.runnerInstanceId, manager.identity.runnerInstanceId);
  assert.equal(receipt.runnerBootId, manager.identity.runnerBootId);
  assert.ok(submissions.every(submission => submission.execution.receipt?.requestDigest === receipt.requestDigest));
  await until(() => manager.get("same", owner).state === "completed");
  assert.equal(launches, 1);
  const completed = manager.get("same", owner);
  assert.ok(completed.receipt!.revision > receipt.revision);
  assert.equal(completed.evidence?.processTerminated, true);
  assert.equal(completed.evidence?.revision, completed.receipt?.revision);
  assert.equal(completed.evidence?.workspaceVersionDigest, completed.version?.digest);
  assert.match(completed.evidence!.resultDigest!, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(manager.submit(input, async () => assert.fail("terminal replay launched")), { execution: completed, accepted: false });
});

test("canonical request digest ignores object key ordering but binds all execution inputs and ownership", async (context) => {
  const { manager, workspace } = await fixture(context);
  const input = { ...request(workspace, "canonical"), npuDevices: [0, 1], cwd: "subdir", maxOutputBytes: 300 };
  const accepted = manager.start(input, async () => result("canonical"));
  const reordered = Object.fromEntries(Object.entries(input).reverse()) as unknown as ShellExecutionRequest;
  assert.equal(manager.submit(reordered, async () => assert.fail("reordered payload launched")).accepted, false);
  const variants: ShellExecutionRequest[] = [
    { ...input, code: "different command" }, { ...input, workspaceRoot: `${workspace}-other` },
    { ...input, npuDevices: [1, 0] }, { ...input, environmentId: "other" },
    { ...input, maxOutputBytes: 301 }, { ...input, permissionEpoch: { ...input.permissionEpoch, sessionId: "other-session" } },
    { ...input, agentId: "other-agent" },
  ];
  for (const variant of variants) {
    assert.throws(() => manager.submit(variant, async () => assert.fail("conflict launched")), error => {
      assert.ok(error instanceof ExecutionManagerError);
      assert.equal(error.code, "EXECUTION_ID_CONFLICT");
      assert.equal(error.statusCode, 409);
      assert.equal(error.message, "Execution ID conflicts with an existing submission");
      return true;
    });
  }
  await until(() => manager.get("canonical", owner).state === "completed");
  assert.equal(manager.get("canonical", owner).receipt?.requestDigest, accepted.receipt?.requestDigest);
});

test("restart preserves identity and quarantines original workspace and selected devices without replay", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "execution-quarantine-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, "workspace");
  const other = resolve(root, "other");
  await mkdir(workspace); await mkdir(other);
  const first = new ExecutionManager(root);
  const identity = first.identity;
  const input = { ...request(workspace, "orphan"), npuDevices: [0] };
  first.start(input, async () => result("orphan"));
  await until(() => first.get("orphan", owner).state === "completed");
  const original = first.get("orphan", owner);
  await first.close();
  const db = new DatabaseSync(resolve(root, "runner-executions", "executions.sqlite"));
  const interrupted = { ...original, state: "running", result: undefined, version: undefined, evidence: undefined, finishedAt: undefined };
  db.prepare("UPDATE executions SET record = ? WHERE id = ?").run(JSON.stringify(interrupted), "orphan");
  db.close();
  const restarted = new ExecutionManager(root);
  try {
    assert.equal(restarted.identity.runnerInstanceId, identity.runnerInstanceId);
    assert.notEqual(restarted.identity.runnerBootId, identity.runnerBootId);
    const recovered = restarted.get("orphan", owner);
    assert.equal(recovered.state, "unknown");
    assert.equal(recovered.finishedAt, undefined);
    assert.equal(recovered.evidence, undefined);
    assert.equal(recovered.workspaceKey, workspace);
    assert.deepEqual(recovered.npuDevices, [0]);
    assert.ok(recovered.receipt!.revision > original.receipt!.revision);
    assert.equal(recovered.receipt?.runnerBootId, identity.runnerBootId);
    assert.deepEqual(restarted.submit(input, async () => assert.fail("orphan replay launched")), { execution: recovered, accepted: false });
    assert.deepEqual(restarted.cancel("orphan", owner), recovered, "cannot claim to cancel an orphan without a controller");
    assert.throws(() => restarted.start(request(workspace, "same-workspace"), async () => assert.fail("workspace isolation lost")), { code: "EXECUTION_RESOURCE_QUARANTINED" });
    assert.throws(() => restarted.start({ ...request(other, "same-device"), npuDevices: [0] }, async () => assert.fail("device isolation lost")), { code: "EXECUTION_RESOURCE_QUARANTINED" });
    restarted.start({ ...request(other, "unrelated"), npuDevices: [1] }, async () => result("unrelated"));
    await until(() => restarted.get("unrelated", owner).state === "completed");
  } finally { await restarted.close(); }
  const again = new ExecutionManager(root);
  try {
    assert.equal(again.identity.runnerInstanceId, identity.runnerInstanceId);
    assert.throws(() => again.start(request(workspace, "still-blocked"), async () => assert.fail("quarantine expired")), { code: "EXECUTION_RESOURCE_QUARANTINED" });
    assert.equal(again.get("unrelated", owner).state, "completed");
  } finally { await again.close(); }
});

test("a legacy unknown record without resource scope blocks unrelated new submissions too", async context => {
  const root = await mkdtemp(resolve(tmpdir(), "execution-legacy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const manager = new ExecutionManager(root);
  await manager.close();
  const db = new DatabaseSync(resolve(root, "runner-executions", "executions.sqlite"));
  db.prepare("INSERT INTO executions VALUES (?, ?, ?, ?)").run("legacy", owner.sessionId, owner.agentId,
    JSON.stringify({ ...owner, id: "legacy", state: "unknown", queuedAt: new Date().toISOString() }));
  db.close();
  const restarted = new ExecutionManager(root);
  try {
    assert.throws(() => restarted.start({ ...request("/unrelated-workspace", "new-id"), npuDevices: [7] }, async () => assert.fail("legacy unknown admitted work")), { code: "EXECUTION_RESOURCE_QUARANTINED" });
  } finally { await restarted.close(); }
});

test("process exit is journaled before result publication and terminal state follows its commit", async context => {
  const { manager, workspace } = await fixture(context);
  let finish!: () => void;
  const operationLatch = new Promise<void>(done => { finish = done; });
  manager.start(request(workspace, "journal"), async () => { await operationLatch; return result("journal"); });
  await until(() => manager.get("journal", owner).state === "running");
  let publish!: () => void;
  const publicationLatch = new Promise<void>(done => { publish = done; });
  let publishing = false;
  const commit = RefStore.prototype.commit;
  context.mock.method(RefStore.prototype, "commit", async function(this: RefStore, ...args: Parameters<RefStore["commit"]>) {
    publishing = true;
    await publicationLatch;
    return commit.apply(this, args);
  });
  finish();
  await until(() => publishing);
  const pending = manager.get("journal", owner);
  assert.equal(pending.state, "running");
  assert.equal(pending.finishedAt, undefined);
  assert.equal(pending.evidence?.processTerminated, true);
  assert.equal(pending.evidence?.resultDigest, undefined);
  assert.equal(pending.evidence?.workspaceVersionDigest, undefined);
  assert.equal(pending.version, undefined);
  publish();
  await until(() => manager.get("journal", owner).state === "completed");
  assert.ok(manager.get("journal", owner).receipt!.revision > pending.receipt!.revision);
});

test("Unicode log cursors remain stable across pagination, duplicate submission and restart", async context => {
  const root = await mkdtemp(resolve(tmpdir(), "execution-unicode-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, "workspace");
  await mkdir(workspace);
  const manager = new ExecutionManager(root);
  const text = "训练🧬\n".repeat(5000);
  manager.start(request(workspace, "unicode"), async (_signal, log) => {
    const bytes = Buffer.from(text);
    for (let offset = 0; offset < bytes.length; offset += 11) log("stdout", bytes.subarray(offset, offset + 11));
    return result("unicode");
  });
  // The 55 KB log is written in 11-byte chunks and committed through CAS plus a
  // workspace snapshot. That is ~11 s on slow disks (observed in PR #472
  // verification), so the completion wait needs a bound sized for it; every
  // content/cursor/dedup/restart assertion below still checks exact bytes.
  await until(() => manager.get("unicode", owner).state === "completed", 30_000);
  const first = manager.logs("unicode", owner);
  const terminal = manager.get("unicode", owner);
  await manager.close();
  const restarted = new ExecutionManager(root);
  try {
    assert.deepEqual(restarted.get("unicode", owner), terminal);
    assert.deepEqual(restarted.logs("unicode", owner), first);
    assert.equal(restarted.submit(request(workspace, "unicode"), async () => assert.fail("logs replay started process")).accepted, false);
    let reconstructed = first.chunks.map(chunk => chunk.text).join("");
    let cursor = first.nextCursor;
    while (true) {
      const page = restarted.logs("unicode", owner, cursor);
      if (!page.chunks.length) break;
      assert.ok(page.chunks.every(chunk => chunk.cursor > cursor));
      reconstructed += page.chunks.map(chunk => chunk.text).join("");
      cursor = page.nextCursor;
    }
    assert.equal(reconstructed, text);
    assert.equal(reconstructed.includes("�"), false);
  } finally { await restarted.close(); }
});

test("corrupt SQLite, corrupt records and lost receipt identity fail closed rather than replacing the ledger", async context => {
  for (const corruption of ["sqlite", "empty", "missing", "record", "identity", "future-schema", "missing-table"] as const) {
    const root = await mkdtemp(resolve(tmpdir(), "execution-corrupt-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const workspace = resolve(root, "workspace");
    await mkdir(workspace);
    const manager = new ExecutionManager(root);
    manager.start(request(workspace, "saved"), async () => result("saved"));
    await until(() => manager.get("saved", owner).state === "completed");
    await manager.close();
    const path = resolve(root, "runner-executions", "executions.sqlite");
    if (corruption === "sqlite") await writeFile(path, "not a sqlite ledger");
    else if (corruption === "empty") await writeFile(path, "");
    else if (corruption === "missing") await rm(path);
    else {
      const db = new DatabaseSync(path);
      if (corruption === "missing-table") db.exec("DROP TABLE executions");
      else if (corruption === "future-schema") db.exec("PRAGMA user_version=99");
      else if (corruption === "record") db.prepare("UPDATE executions SET record = ?").run("{invalid JSON");
      else db.exec("DELETE FROM execution_metadata WHERE key = 'runnerInstanceId'");
      db.close();
    }
    assert.throws(() => new ExecutionManager(root), { code: "EXECUTION_LEDGER_UNAVAILABLE", statusCode: 503 });
  }
});

test("a second manager cannot relabel or launch work while the ledger has a live owner", async context => {
  const { manager, workspace, root } = await fixture(context);
  let finish!: () => void;
  const latch = new Promise<void>(done => { finish = done; });
  manager.start(request(workspace, "live"), async () => { await latch; return result("live"); });
  await until(() => manager.get("live", owner).state === "running");
  try {
    assert.throws(() => new ExecutionManager(root), { code: "RUNNER_ALREADY_ACTIVE", statusCode: 503 });
    assert.equal(manager.get("live", owner).state, "running");
  } finally { finish(); }
  await until(() => manager.get("live", owner).state === "completed");
});

test("a crashed Runner releases the OS-owned ledger lock and restart quarantines its original execution", { timeout: 10_000 }, async context => {
  const root = await mkdtemp(resolve(tmpdir(), "execution-process-crash-"));
  const workspace = resolve(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  const input = request(workspace, "crashed");
  const script = `
    import { ExecutionManager } from ${JSON.stringify(new URL("./execution-manager.ts", import.meta.url).href)};
    const manager = new ExecutionManager(${JSON.stringify(root)});
    manager.start(${JSON.stringify(input)}, async () => new Promise(() => {}));
    const timer = setInterval(() => {
      if (manager.get("crashed", ${JSON.stringify(owner)}).state === "running") {
        process.send(manager.identity);
        clearInterval(timer);
        setInterval(() => {}, 1000);
      }
    }, 5);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  context.after(() => { child.kill("SIGKILL"); });
  let childErrors = "";
  assert.ok(child.stderr);
  child.stderr.on("data", chunk => { childErrors += String(chunk); });
  const [identity] = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => { throw new Error(`Runner child exited before acceptance: ${childErrors}`); }),
  ]) as [{ runnerInstanceId: string; runnerBootId: string }];
  assert.throws(() => new ExecutionManager(root), { code: "RUNNER_ALREADY_ACTIVE" });
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const restarted = new ExecutionManager(root);
  try {
    assert.equal(restarted.identity.runnerInstanceId, identity.runnerInstanceId);
    assert.notEqual(restarted.identity.runnerBootId, identity.runnerBootId);
    const recovered = restarted.get("crashed", owner);
    assert.equal(recovered.state, "unknown");
    assert.equal(recovered.evidence, undefined);
    assert.equal(recovered.finishedAt, undefined);
    assert.equal(restarted.submit(input, async () => assert.fail("crashed command replayed")).accepted, false);
    assert.throws(() => restarted.start(request(workspace, "next"), async () => assert.fail("orphan workspace reused")), { code: "EXECUTION_RESOURCE_QUARANTINED" });
  } finally { await restarted.close(); }
});

for (const point of ["before-publication", "after-publication", "conflicting-head", "invalid-target", "missing-cas"] as const) {
  test(`restart recovers durable publication without compute replay: ${point}`, { timeout: 10_000 }, async context => {
    const root = await mkdtemp(resolve(tmpdir(), "execution-publication-crash-"));
    const workspace = resolve(root, "workspace");
    await mkdir(workspace);
    context.after(() => rm(root, { recursive: true, force: true }));
    const input = request(workspace, "publication-crash");
    const script = `
      import { ExecutionManager } from ${JSON.stringify(new URL("./execution-manager.ts", import.meta.url).href)};
      import { RefStore } from "@sciencediscovery/cas";
      const manager = new ExecutionManager(${JSON.stringify(root)});
      const commit = RefStore.prototype.commit;
      RefStore.prototype.commit = async function(store, name, expected, target) {
        const record = await store.readRecord(target);
        if (record.kind !== "WorkspaceExecution") return commit.call(this, store, name, expected, target);
        if (${JSON.stringify(point)} === "after-publication") await commit.call(this, store, name, expected, target);
        process.send({ target, name });
        await new Promise(() => {});
      };
      manager.start(${JSON.stringify(input)}, async (_signal, log) => {
        log("stdout", Buffer.from("original-result"));
        return ${JSON.stringify(result("publication-crash"))};
      });
      setInterval(() => {}, 1000);
    `;
    // Resolve CAS in the child's normal Runner package workspace.
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    context.after(() => { child.kill("SIGKILL"); });
    let errors = "";
    assert.ok(child.stderr);
    child.stderr.on("data", chunk => { errors += String(chunk); });
    const [publication] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => { throw new Error(`Crash fixture exited before journal: ${errors}`); }),
    ]) as [{ target: NonNullable<import("@sciencediscovery/schema").ManagedExecution["version"]>; name: string }];
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const versions = new VersionStore(root);
    const refsBefore = await RefStore.open(versions);
    let sequenceBefore: number | undefined;
    try {
      sequenceBefore = refsBefore.publicationSequence(publication.name, publication.target);
      if (point === "conflicting-head") {
        const other = await versions.putRecord("WorkspaceMutation", { kind: "conflicting-test-publication" });
        await refsBefore.commit(versions, publication.name, refsBefore.head(publication.name), other);
      }
    } finally { refsBefore.close(); }
    if (point === "missing-cas") await rm(versions.objectPath(publication.target));
    if (point === "invalid-target") {
      const db = new DatabaseSync(resolve(root, "runner-executions", "executions.sqlite"));
      const row = db.prepare("SELECT record FROM execution_publications WHERE id = ?").get(input.executionId)!;
      const journal = JSON.parse(String(row.record));
      journal.execution.evidence.resultDigest = `sha256:${"0".repeat(64)}`;
      db.prepare("UPDATE execution_publications SET record = ? WHERE id = ?").run(JSON.stringify(journal), input.executionId);
      db.close();
    }
    let releaseValidation!: () => void;
    let validating = false;
    if (point === "before-publication") {
      const latch = new Promise<void>(done => { releaseValidation = done; });
      const validate = VersionStore.prototype.validateClosure;
      context.mock.method(VersionStore.prototype, "validateClosure", async function(this: VersionStore, ref: Parameters<VersionStore["validateClosure"]>[0]) {
        validating = true;
        await latch;
        return validate.call(this, ref);
      });
    }
    const restarted = new ExecutionManager(root);
    let recoveredRevision: number | undefined;
    try {
      if (point === "invalid-target") assert.equal(restarted.get(input.executionId, owner).state, "unknown");
      else assert.throws(() => restarted.get(input.executionId, owner), { code: "EXECUTION_RECOVERY_PENDING", statusCode: 503 });
      if (point === "before-publication") {
        assert.equal(validating, true);
        assert.throws(() => restarted.get(input.executionId, { ...owner, agentId: "other" }), { code: "EXECUTION_NOT_FOUND", statusCode: 404 });
        assert.throws(() => restarted.submit(input, async () => assert.fail("recovering POST replayed")), { code: "EXECUTION_RECOVERY_PENDING", statusCode: 503 });
        assert.equal(restarted.logs(input.executionId, owner).chunks.map(chunk => chunk.text).join(""), "original-result");
      }
      assert.throws(() => restarted.start(request(workspace, "premature"), async () => assert.fail("recovery admitted work")), { code: "EXECUTION_RECOVERY_PENDING" });
      releaseValidation?.();
      await restarted.ready();
      const recovered = restarted.get(input.executionId, owner);
      assert.equal(restarted.submit(input, async () => assert.fail("publication recovery replayed compute")).accepted, false);
      if (point === "conflicting-head" || point === "invalid-target" || point === "missing-cas") {
        assert.equal(recovered.state, "unknown");
        assert.equal(recovered.version, undefined);
        assert.match(recovered.error!, /recovery is blocked/);
      } else {
        assert.equal(recovered.state, "completed");
        assert.equal(recovered.result?.stdout, "done");
        assert.deepEqual(recovered.version, publication.target);
        assert.equal(recovered.evidence?.processTerminated, true);
        assert.equal(recovered.evidence?.revision, recovered.receipt?.revision);
        assert.equal(restarted.logs(input.executionId, owner).chunks.map(chunk => chunk.text).join(""), "original-result");
        recoveredRevision = recovered.receipt?.revision;
        const refs = await RefStore.open(versions);
        try {
          assert.deepEqual(refs.head(publication.name), publication.target);
          if (point === "after-publication") assert.equal(refs.publicationSequence(publication.name, publication.target), sequenceBefore, "already rooted result is never republished");
        } finally { refs.close(); }
      }
      // The generic CAS active marker intentionally needs explicit fence repair.
      assert.throws(() => restarted.start(request(workspace, "after-recovery"), async () => assert.fail("ambiguous active marker cleared")), { code: "EXECUTION_RESOURCE_QUARANTINED" });
    } finally { releaseValidation?.(); await restarted.close(); }
    if (recoveredRevision !== undefined) {
      const again = new ExecutionManager(root);
      try {
        await again.ready();
        assert.equal(again.get(input.executionId, owner).state, "completed");
        assert.equal(again.get(input.executionId, owner).receipt?.revision, recoveredRevision, "repeated publication recovery is idempotent");
      } finally { await again.close(); }
    }
  });
}

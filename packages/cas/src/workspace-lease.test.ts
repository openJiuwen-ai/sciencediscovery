// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { RefStore, VersionStore } from "./versioning.js";
import { withWorkspaceLease, withWorkspaceLeases, withWorkspaceMutation, workspaceHeadName } from "./workspace-lease.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "workspace-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return { root, workspace, versions: new VersionStore(root) };
}
function latch() { let release!: () => void; const promise = new Promise<void>((done) => { release = done; }); return { promise, release }; }

test("Workspace lease coordinates independent processes and does not block observers", async (t) => {
  const { workspace } = await fixture(t);
  const entry = new URL("./workspace-lease.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { withWorkspaceLease } from ${JSON.stringify(entry)};
    await withWorkspaceLease(${JSON.stringify(workspace)}, async () => {
      process.stdout.write('ready'); process.stdin.resume();
      await new Promise(done => process.stdin.once('data', done));
    }); process.exit(0);
  `], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child.stdout, "data");
  let entered = false;
  const controller = new AbortController();
  const waiting = withWorkspaceLease(workspace, async () => { entered = true; }, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(entered, false);
  const exit = once(child, "exit"); child.stdin.write("release"); await exit;
  await withWorkspaceLease(workspace, async () => { entered = true; });
  assert.equal(entered, true);
});

test("same Workspace waits through atomic version publication; different roots run independently", async (t) => {
  const { root, workspace, versions } = await fixture(t);
  const started = latch(); const release = latch();
  const first = withWorkspaceMutation(versions, workspace, async () => {
    await writeFile(join(workspace, "file"), "first"); started.release(); await release.promise;
  }, { kind: "first" });
  await started.promise;
  const other = join(root, "other"); await mkdir(other);
  await withWorkspaceMutation(versions, other, async () => {}, { kind: "parallel" });
  let ran = false;
  const second = withWorkspaceMutation(versions, workspace, async () => {
    const refs = await RefStore.open(versions);
    try { assert.ok(refs.head(workspaceHeadName(workspace))); } finally { refs.close(); }
    ran = true;
  }, { kind: "second" });
  assert.equal(ran, false); release.release(); await Promise.all([first, second]); assert.equal(ran, true);
});

test("nested file operations reuse the owning lease and failed operations still commit file effects", async (t) => {
  const { workspace, versions } = await fixture(t);
  await assert.rejects(withWorkspaceMutation(versions, workspace, () => withWorkspaceLease(workspace, async () => {
    await writeFile(join(workspace, "partial"), "preserved"); throw new Error("command failed");
  }), { kind: "failing-write" }), /command failed/);
  assert.equal(await readFile(join(workspace, "partial"), "utf8"), "preserved");
  const refs = await RefStore.open(versions);
  try {
    const record = await versions.readRecord<{ status: string }>(refs.head(workspaceHeadName(workspace))!, "WorkspaceMutation");
    assert.equal(record.value.status, "failed");
  } finally { refs.close(); }
  await withWorkspaceLease(workspace, async () => {});
});

test("opposite-direction copies acquire multiple Workspace leases without deadlock", async (t) => {
  const { root, workspace } = await fixture(t);
  const other = join(root, "other"); await mkdir(other);
  const order: number[] = [];
  await Promise.all([
    withWorkspaceLeases([workspace, other], async () => { order.push(1); await new Promise((done) => setTimeout(done, 25)); order.push(2); }),
    withWorkspaceLeases([other, workspace], async () => { order.push(3); await new Promise((done) => setTimeout(done, 25)); order.push(4); }),
  ]);
  assert.ok(JSON.stringify(order) === "[1,2,3,4]" || JSON.stringify(order) === "[3,4,1,2]");
});

test("ref publication failure closes admission across later operations", async (t) => {
  const { workspace, versions } = await fixture(t);
  t.mock.method(RefStore.prototype, "commit", async () => { throw new Error("ref failure"); });
  await assert.rejects(withWorkspaceMutation(versions, workspace, async () => {}, { kind: "broken" }), /ref failure/);
  await assert.rejects(withWorkspaceLease(workspace, async () => assert.fail("must not run")), /repair storage/);
});

test("process loss releases the OS lock but refuses unverified files instead of replaying work", async (t) => {
  const { workspace } = await fixture(t);
  const entry = new URL("./workspace-lease.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { withWorkspaceLease } from ${JSON.stringify(entry)};
    await withWorkspaceLease(${JSON.stringify(workspace)}, async () => { process.stdout.write('ready'); setInterval(() => {}, 1000); await new Promise(() => {}); });
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child.stdout, "data"); const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
  await assert.rejects(withWorkspaceLease(workspace, async () => assert.fail("must not replay")), /interrupted operation/);
});

// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { CasStore, sha256 } from "./index.js";
import { canonicalize, RECORD_MEDIA_TYPE, RefStore, snapshotWorkspace, StepCommitCoordinator, VersionStore,
  type AgentStateRef, type DataRef, type TrajectoryStep, type WorkspaceTree } from "./versioning.js";

async function fixture(run: (store: VersionStore, root: string) => Promise<void>) {
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".tmp/versioning-"));
  try { await run(new VersionStore(resolve(root, "storage")), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("JCS matches RFC number and UTF-16 ordering rules and rejects non-JSON values", () => {
  assert.equal(canonicalize({ z: -0, a: [1e30, 4.50, 2e-3, 1e-27] }), '{"a":[1e+30,4.5,0.002,1e-27],"z":0}');
  assert.equal(canonicalize({ "10": 0, "2": 0 }), '{"10":0,"2":0}');
  assert.equal(canonicalize({ "€": 1, "😀": 2, "\r": 3 }), '{"\\r":3,"€":1,"😀":2}');
  for (const value of [NaN, Infinity, undefined, 1n, new Date(), "\ud800", [,], { a: undefined }]) {
    assert.throws(() => canonicalize(value));
  }
  const cycle: unknown[] = []; cycle.push(cycle);
  assert.throws(() => canonicalize(cycle));
});

test("dual pools preserve typed identity, concurrent writes and OCI layout", async () => fixture(async (store) => {
  const [data, state] = await Promise.all([store.put("data", "same"), store.put("agent-state", "same")]);
  assert.equal(data.digest, state.digest);
  assert.notEqual(store.objectPath(data), store.objectPath(state));
  await assert.rejects(store.readData(state as unknown as DataRef), /cross-pool/);
  if (false) {
    // @ts-expect-error State references cannot be passed to the Data API.
    await store.readData(state);
    // @ts-expect-error Data references cannot be passed to the State API.
    await store.readState(data);
  }
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => store.put("data", "same"))), Array(8).fill(data));
  assert.equal(JSON.parse(await readFile(resolve(store.poolRoot("data"), "oci-layout"), "utf8")).imageLayoutVersion, "1.0.0");
  const a = await store.putRecord("Test", { b: 2, a: 1 });
  const b = await store.putRecord("Test", { a: 1, b: 2 });
  assert.deepEqual(a, b);
  await writeFile(store.objectPath(data), "evil");
  await assert.rejects(store.put("data", "same"), /Corrupt/);
  await assert.rejects(store.readData(data), /integrity/);
}));

test("legacy hash reads survive new pool writes without moving the original", async () => fixture(async (store) => {
  const bytes = Buffer.from("legacy"); const digest = sha256(bytes);
  const old = resolve(store.dataDir, "cas", "sha256", digest.slice(0, 2), digest);
  await mkdir(resolve(old, ".."), { recursive: true }); await writeFile(old, bytes);
  const legacy = new CasStore(store.dataDir);
  assert.deepEqual(await legacy.read(digest), bytes);
  const ref = await new CasStore(store.dataDir, "data").put(bytes);
  assert.equal(ref.hash, digest);
  assert.deepEqual(await readFile(old), bytes);
  const source = resolve(store.dataDir, "large.bin"); const large = Buffer.alloc(300_000, 97);
  await writeFile(source, large);
  assert.equal((await legacy.putFile(source)).hash, sha256(large));
  assert.deepEqual(await legacy.read(sha256(large)), large);
  assert.deepEqual(await legacy.retain({ hash: digest, size: bytes.length }, "data"), {
    pool: "data", digest: `sha256:${digest}`, size: bytes.length, mediaType: "application/octet-stream",
  });
  await assert.rejects(legacy.retain({ hash: digest, size: bytes.length + 1 }, "data"), /integrity/);
}));

test("Linux tree preserves raw names, case, symlinks, empty directories and executable bits", async () => fixture(async (store, root) => {
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  for (const name of ["A", "a", "é", "é"]) await writeFile(resolve(workspace, name), "identical");
  await mkdir(resolve(workspace, "empty"));
  await symlink("../outside", resolve(workspace, "link"));
  const raw = Buffer.concat([Buffer.from(`${workspace}/`), Buffer.from([0xff])]); await writeFile(raw, "raw");
  const first = await snapshotWorkspace(store, workspace);
  assert.deepEqual(await snapshotWorkspace(store, workspace), first);
  const tree = (await store.readRecord<WorkspaceTree>(first)).value;
  assert.equal(tree.entries.length, 7);
  assert.ok(tree.entries.some((entry) => entry.name === "_w"));
  assert.ok(tree.entries.some((entry) => entry.type === "symlink" && Buffer.from(entry.target, "base64url").toString() === "../outside"));
  await chmod(resolve(workspace, "a"), 0o755);
  const executable = await snapshotWorkspace(store, workspace); assert.notEqual(executable.digest, first.digest);
  await utimes(resolve(workspace, "a"), 100, 100);
  assert.deepEqual(await snapshotWorkspace(store, workspace), executable);
  await writeFile(resolve(workspace, "a"), "different"); await utimes(resolve(workspace, "a"), 100, 100);
  assert.notEqual((await snapshotWorkspace(store, workspace)).digest, executable.digest);
  execFileSync("mkfifo", [resolve(workspace, "pipe")]);
  await assert.rejects(snapshotWorkspace(store, workspace), /rejects FIFO/);
}));

test("refs validate closure, rollback injected faults and retain every committed history root", async () => fixture(async (store) => {
  const refs = await RefStore.open(store);
  try {
    const leaf = await store.put("data", "file");
    const first = await store.putRecord("Root", { leaf });
    assert.equal(await store.validateClosure(first), 2);
    const undeclared = await store.put("agent-state", canonicalize({ schemaVersion: 1, kind: "Root", value: { leaf }, dependencies: [] }), RECORD_MEDIA_TYPE);
    await assert.rejects(refs.commit(store, "undeclared", null, undeclared), /Undeclared/);
    const future = await store.put("agent-state", canonicalize({ schemaVersion: 2, kind: "Root", value: {}, dependencies: [] }), RECORD_MEDIA_TYPE);
    await assert.rejects(store.readRecord(future), /Unsupported/);
    await refs.commit(store, "agent/head", null, first);
    const second = await store.putRecord("Root", { parent: first });
    for (const point of ["before-transaction", "after-live-ref"]) {
      await assert.rejects(refs.commit(store, "agent/head", first, second, (at) => { if (at === point) throw new Error("fault"); }), /fault/);
      assert.deepEqual(refs.head("agent/head"), first);
      assert.equal(refs.history("agent/head").length, 1);
    }
    await refs.commit(store, "agent/head", first, second);
    assert.deepEqual(refs.history("agent/head"), [first, second]);
    assert.equal(refs.roots().length, 2);
    await rm(store.objectPath(leaf));
    await assert.rejects(refs.commit(store, "agent/broken", null, second));
    assert.equal(refs.head("agent/broken"), null);
  } finally { refs.close(); }
}));

test("independent coordinators compare expected heads and same-path overwrite is captured", async () => fixture(async (store, root) => {
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  await writeFile(resolve(workspace, "result"), "old");
  const beforeTree = await snapshotWorkspace(store, workspace);
  await writeFile(resolve(workspace, "result"), "first"); await writeFile(resolve(workspace, "result"), "last");
  const afterTree = await snapshotWorkspace(store, workspace);
  const revision = await store.putRecord("AgentRevision", {});
  const before = await store.putRecord("AgentStateSnapshot", { agentId: "agent", agentRevision: revision, workspace: beforeTree });
  const after = await store.putRecord("AgentStateSnapshot", { agentId: "agent", agentRevision: revision, workspace: afterTree });
  const context = await store.putRecord("ContextAssemblyRecord", {});
  const modelContext = await store.putRecord("ModelContextSnapshot", {});
  const refs = await RefStore.open(store); const competing = await RefStore.open(store);
  const step: TrajectoryStep = { agentId: "agent", trajectoryId: "run", turn: 0, parent: null,
    revision, before, after, context, modelContext, actions: [], childTrajectories: [], eventSegments: [] };
  try {
    const results = await Promise.allSettled([
      new StepCommitCoordinator(store, refs, "head").commit(step),
      new StepCommitCoordinator(store, competing, "head").commit({ ...step, trajectoryId: "other" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const saved = (await store.readRecord<TrajectoryStep>(refs.head("head")!)).value;
    const savedState = (await store.readRecord<{ workspace: AgentStateRef }>(saved.after)).value;
    assert.deepEqual(savedState.workspace, await snapshotWorkspace(store, workspace));
    const entry = (await store.readRecord<WorkspaceTree>(savedState.workspace)).value.entries[0]!;
    assert.equal(entry.type, "file");
    if (entry.type === "file") assert.equal((await store.readData(entry.content)).toString(), "last");
    await assert.rejects(new StepCommitCoordinator(store, refs, "bad").commit({ ...step, context: before }), /schema/);
  } finally { refs.close(); competing.close(); }
}));

test("process death inside the SQLite transaction retains the old complete head", async () => fixture(async (store) => {
  let refs = await RefStore.open(store);
  const old = await store.putRecord("Root", { version: 1 });
  const next = await store.putRecord("Root", { version: 2, old });
  await refs.commit(store, "head", null, old); refs.close();
  const moduleUrl = new URL("./versioning.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { VersionStore, RefStore } from ${JSON.stringify(moduleUrl)};
    const store = new VersionStore(${JSON.stringify(store.dataDir)});
    const refs = await RefStore.open(store);
    await refs.commit(store, 'head', ${JSON.stringify(old)}, ${JSON.stringify(next)}, p => {
      if (p === 'after-live-ref') process.exit(73);
    });
  `]);
  assert.equal(child.status, 73, child.stderr.toString());
  refs = await RefStore.open(store);
  try {
    assert.deepEqual(refs.head("head"), old);
    await store.validateClosure(refs.head("head") as AgentStateRef);
    await refs.commit(store, "head", old, next);
    assert.deepEqual(refs.head("head"), next);
  } finally { refs.close(); }
}));

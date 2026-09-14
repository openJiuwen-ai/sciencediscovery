// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { VersionStore } from "@sciencediscovery/cas";
import type { RunnerClient } from "@sciencediscovery/executor";
import { WorkspaceTransfers, type TransferEndpoint } from "./workspace-transfers.js";
const owner = { sessionId: "session", agentId: "main" };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "transfers-"));
  const db = new DatabaseSync(join(root, "transfers.sqlite"));
  const source = join(root, "source"), target = join(root, "target");
  await mkdir(source); await mkdir(target);
  const manager = new WorkspaceTransfers(db, new VersionStore(root));
  t.after(() => { db.close(); return rm(root, { recursive: true, force: true }); });
  return { root, db, source, target, manager };
}
function remote(id: string, bytes: Map<string, Buffer>) {
  const snapshots = new Map<string, Map<string, Buffer>>();
  return { id, workspaceKey: id, runner: {
    snapshotRemoteWorkspace: async (workspace: string, paths: string[]) => {
      assert.equal(workspace, id); const key = randomUUID();
      const files = new Map(paths.filter((path) => bytes.has(path)).map((path) => [path, Buffer.from(bytes.get(path)!)])); snapshots.set(key, files);
      return { id: key, workspace, capturedAt: new Date().toISOString(), files: [...files].map(([path, value]) => ({ path, size: value.length, sha256: hash(value), executable: 0 })) };
    },
    streamWorkspaceSnapshot: async (snapshot: { id: string }, path: string) => (async function* () { yield snapshots.get(snapshot.id)!.get(path)!; })(),
    uploadWorkspaceSnapshotFile: async (_workspace: string, path: string, chunks: AsyncIterable<Uint8Array>, metadata: { sha256: string; size: number }, conflict: string) => {
      if (conflict === "reject" && bytes.has(path)) throw new Error("target exists");
      const content = []; for await (const chunk of chunks) content.push(Buffer.from(chunk));
      const value = Buffer.concat(content); assert.equal(hash(value), metadata.sha256); assert.equal(value.length, metadata.size); bytes.set(path, value);
    },
  } as unknown as RunnerClient };
}

test("one Transfer service covers local/local, local/remote, remote/local and remote/remote", async (t) => {
  const { source, target, manager } = await fixture(t);
  await writeFile(join(source, "data"), "original");
  const a = new Map<string, Buffer>(), b = new Map<string, Buffer>();
  const endpoints = new Map<string, TransferEndpoint>([["local-a", { id: "local-a", root: source }], ["local-b", { id: "local-b", root: target }], ["remote-a", remote("remote-a", a)], ["remote-b", remote("remote-b", b)]]);
  const resolve = (id: string) => { const target = endpoints.get(id); if (!target) throw new Error("unauthorized"); return target; };
  for (const [from, to] of [["local-a", "local-b"], ["local-a", "remote-a"], ["remote-a", "remote-b"], ["remote-b", "local-b"]]) {
    const started = manager.start(owner, { sourceWorkspaceId: from!, targetWorkspaceId: to!, files: [{ sourcePath: "data", targetPath: "data" }], conflict: "overwrite" }, { resolve });
    assert.equal(started.state, "queued");
    const result = await manager.wait(started.id, owner);
    assert.equal(result.state, "completed", result.error ?? "Transfer must complete"); assert.equal(result.progress[0]?.bytes, 8); assert.ok(result.sourceSnapshotId);
  }
  assert.equal(await readFile(join(target, "data"), "utf8"), "original");
  assert.equal(b.get("data")?.toString(), "original");
  assert.throws(() => manager.get(manager.list(owner)[0]!.id, { ...owner, agentId: "child" }), /not found/);
  assert.throws(() => manager.start(owner, { sourceWorkspaceId: "foreign", targetWorkspaceId: "local-a", files: [{ sourcePath: "data", targetPath: "data" }] }, { resolve }), /unauthorized/);
});

test("partial failure retains completed files and never labels the entire transfer completed", async (t) => {
  const { source, target, manager } = await fixture(t);
  await writeFile(join(source, "one"), "one"); await writeFile(join(source, "two"), "two"); await writeFile(join(target, "two"), "existing");
  const started = manager.start(owner, { sourceWorkspaceId: "a", targetWorkspaceId: "b", files: [{ sourcePath: "one", targetPath: "one" }, { sourcePath: "two", targetPath: "two" }] }, {
    resolve: (id) => ({ id, root: id === "a" ? source : target }),
  });
  const result = await manager.wait(started.id, owner);
  assert.equal(result.state, "partial"); assert.deepEqual(result.progress.map((file) => file.state), ["completed", "failed"]);
  assert.equal(await readFile(join(target, "one"), "utf8"), "one"); assert.equal(await readFile(join(target, "two"), "utf8"), "existing");
});

test("cancellation after the first publication preserves that file and cancels pending files", async (t) => {
  const { source, target, manager } = await fixture(t);
  await writeFile(join(source, "data"), "bytes");
  let cancel: Promise<unknown> | undefined;
  const started = manager.start(owner, { sourceWorkspaceId: "a", targetWorkspaceId: "b", files: [{ sourcePath: "data", targetPath: "one" }, { sourcePath: "data", targetPath: "two" }] }, {
    resolve: (id) => ({ id, root: id === "a" ? source : target }),
    committed: async (_file, job) => { cancel = manager.cancel(job.id, owner); },
  });
  const result = await manager.wait(started.id, owner); await cancel;
  assert.equal(result.state, "partial"); assert.deepEqual(result.progress.map((file) => file.state), ["completed", "cancelled"]);
  await assert.rejects(readFile(join(target, "two")), { code: "ENOENT" });
});

test("old Runner snapshot failure never falls back to live source reads; restart does not replay", async (t) => {
  const { root, db, target, manager } = await fixture(t);
  let liveReads = 0;
  const runner = { snapshotRemoteWorkspace: async () => { throw new Error("Snapshot protocol unavailable"); }, streamRemoteWorkspaceFile: async () => { liveReads++; } } as unknown as RunnerClient;
  const started = manager.start(owner, { sourceWorkspaceId: "a", targetWorkspaceId: "b", files: [{ sourcePath: "data", targetPath: "data" }] }, {
    resolve: (id) => id === "a" ? { id, workspaceKey: "remote", runner } : { id, root: target },
  });
  assert.equal((await manager.wait(started.id, owner)).state, "failed"); assert.equal(liveReads, 0);
  const record = { ...manager.get(started.id, owner), state: "running" };
  db.prepare("UPDATE workspace_transfers SET record = ? WHERE id = ?").run(JSON.stringify(record), started.id);
  const restarted = new WorkspaceTransfers(db, new VersionStore(root));
  assert.equal(restarted.get(started.id, owner).state, "unknown"); assert.equal(liveReads, 0);
});

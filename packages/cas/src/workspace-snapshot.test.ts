// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { VersionStore } from "./versioning.js";
import { committedWorkspaceSnapshot, withWorkspaceMutation } from "./workspace-lease.js";
import { streamSnapshotFile, workspaceSnapshotFiles } from "./workspace-snapshot.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "workspace-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  return { workspace, versions: new VersionStore(root) };
}
function latch() { let release!: () => void; const promise = new Promise<void>((done) => { release = done; }); return { promise, release }; }

test("observers read the committed baseline while a writer changes live files, without waiting", async (t) => {
  const { workspace, versions } = await fixture(t);
  await writeFile(join(workspace, "result"), "old");
  const baseline = await committedWorkspaceSnapshot(versions, workspace);
  const started = latch(); const finish = latch();
  const writer = withWorkspaceMutation(versions, workspace, async () => {
    await writeFile(join(workspace, "result"), "new");
    assert.deepEqual(await committedWorkspaceSnapshot(versions, workspace), baseline, "nested reads cannot publish unfinished writes");
    started.release(); await finish.promise;
  }, { kind: "test" });
  await started.promise;
  try {
    const observed = await committedWorkspaceSnapshot(versions, workspace);
    assert.deepEqual(observed, baseline);
    const [file] = await workspaceSnapshotFiles(versions, observed);
    assert.equal((await versions.readData(file!.content)).toString(), "old");
  } finally { finish.release(); await writer; }
  const committed = await committedWorkspaceSnapshot(versions, workspace);
  assert.notEqual(committed.digest, baseline.digest);
  assert.equal((await versions.readData((await workspaceSnapshotFiles(versions, committed))[0]!.content)).toString(), "new");
});

test("snapshot selection is immutable, skips symlinks, and rejects path traversal", async (t) => {
  const { workspace, versions } = await fixture(t);
  await mkdir(join(workspace, "data"));
  await writeFile(join(workspace, "data", "file"), "original");
  await writeFile(join(workspace, "other"), "excluded");
  await symlink("data/file", join(workspace, "link"));
  const tree = await committedWorkspaceSnapshot(versions, workspace);
  await rm(join(workspace, "data"), { recursive: true });
  const files = await workspaceSnapshotFiles(versions, tree, ["data", "link"]);
  assert.deepEqual(files.map((file) => file.path), ["data/file"]);
  const chunks = []; for await (const chunk of streamSnapshotFile(versions, files[0]!.content)) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "original");
  for (const path of ["../data", "/data", "data/../other", "data\\file", "data//file"]) {
    await assert.rejects(workspaceSnapshotFiles(versions, tree, [path]), /relative Workspace/);
  }
});

test("snapshot streaming detects corrupted CAS bytes instead of publishing them as valid", async (t) => {
  const { workspace, versions } = await fixture(t);
  await writeFile(join(workspace, "file"), "first");
  const tree = await committedWorkspaceSnapshot(versions, workspace);
  const [file] = await workspaceSnapshotFiles(versions, tree);
  await writeFile(versions.objectPath(file!.content), "other");
  await assert.rejects(async () => { for await (const _ of streamSnapshotFile(versions, file!.content)) { /* drain */ } }, /integrity failure/);
});

test("failed writes publish actual partial effects and provide a committed receipt", async (t) => {
  const { workspace, versions } = await fixture(t);
  let receipt: unknown;
  await assert.rejects(withWorkspaceMutation(versions, workspace, async () => {
    await writeFile(join(workspace, "partial"), "kept"); throw new Error("failed command");
  }, { kind: "test", onCommitted: (tree) => { receipt = tree; } }), /failed command/);
  assert.deepEqual(receipt, await committedWorkspaceSnapshot(versions, workspace));
});

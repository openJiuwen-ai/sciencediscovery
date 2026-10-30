// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { watch } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { snapshotWorkspace, VersionStore, type WorkspaceTree } from "./versioning.js";
import { committedWorkspaceSnapshot, withWorkspaceMutation } from "./workspace-lease.js";
import { materializeWorkspaceSnapshot, streamSnapshotFile, workspaceSnapshotFiles } from "./workspace-snapshot.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "workspace-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  return { workspace, versions: new VersionStore(root) };
}
function latch() { let release!: () => void; const promise = new Promise<void>((done) => { release = done; }); return { promise, release }; }

test("a repeat snapshot reuses stored objects instead of republishing them", async (t) => {
  const { workspace, versions } = await fixture(t);
  await mkdir(join(workspace, "data"));
  for (let index = 0; index < 20; index += 1) await writeFile(join(workspace, "data", `file-${index}`), `body ${index}`);
  await writeFile(join(workspace, "empty"), "");
  const first = await snapshotWorkspace(versions, workspace);
  // Storing an object starts with a temporary file in one of these
  // directories, so a pass that only reuses what is already there touches
  // neither. A fresh instance has no admission cache, which is the case that
  // used to re-publish every object.
  const directories = [join(versions.poolRoot("data"), "blobs", "sha256"),
    join(versions.poolRoot("agent-state"), "blobs", "sha256")];
  const published: string[] = [];
  const watchers = directories.map((directory) =>
    watch(directory, (_event, name) => published.push(join(directory, String(name ?? "")))));
  t.after(() => { for (const watcher of watchers) watcher.close(); });
  const second = await snapshotWorkspace(new VersionStore(versions.dataDir), workspace);
  await new Promise((done) => setTimeout(done, 100));
  assert.deepEqual(second, first);
  assert.deepEqual(published, []);
});

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

test("whole-tree export preserves Linux structure and exports a fixed committed tree", async (t) => {
  const { workspace, versions } = await fixture(t);
  await mkdir(join(workspace, "empty"));
  await writeFile(join(workspace, "run"), "original"); await chmod(join(workspace, "run"), 0o751);
  await symlink("run", join(workspace, "link"));
  const rawName = Buffer.from([0xff]);
  await writeFile(Buffer.concat([Buffer.from(`${workspace}/`), rawName]), "raw name");
  const snapshot = await committedWorkspaceSnapshot(versions, workspace);
  await writeFile(join(workspace, "run"), "changed");
  const destination = join(workspace, "..", "export");
  await materializeWorkspaceSnapshot(versions, snapshot, destination);
  assert.equal(await readFile(join(destination, "run"), "utf8"), "original");
  assert.equal((await stat(join(destination, "run"))).mode & 0o111, 0o111);
  assert.equal(await readlink(join(destination, "link")), "run");
  assert.ok((await stat(join(destination, "empty"))).isDirectory());
  assert.equal(await readFile(Buffer.concat([Buffer.from(`${destination}/`), rawName]), "utf8"), "raw name");
  assert.deepEqual(await committedWorkspaceSnapshot(versions, destination), snapshot);
  await writeFile(join(destination, "run"), "independent");
  assert.equal(await readFile(join(workspace, "run"), "utf8"), "changed");
  const entry = (await versions.readRecord<WorkspaceTree>(snapshot)).value.entries.find((entry) => entry.name === Buffer.from("run").toString("base64url"));
  assert.equal(entry?.type, "file");
  if (entry?.type === "file") assert.equal((await versions.readData(entry.content)).toString(), "original");
});

test("whole-tree export refuses existing destinations and never deletes their contents", async (t) => {
  const { workspace, versions } = await fixture(t);
  await writeFile(join(workspace, "keep"), "keep");
  const snapshot = await committedWorkspaceSnapshot(versions, workspace);
  await assert.rejects(materializeWorkspaceSnapshot(versions, snapshot, workspace), { code: "EEXIST" });
  assert.equal(await readFile(join(workspace, "keep"), "utf8"), "keep");
});

test("whole-tree export does not publish corrupt bytes or traversal entries", async (t) => {
  const { workspace, versions } = await fixture(t);
  await writeFile(join(workspace, "file"), "valid");
  const snapshot = await committedWorkspaceSnapshot(versions, workspace);
  const [file] = await workspaceSnapshotFiles(versions, snapshot);
  await writeFile(versions.objectPath(file!.content), "wrong");
  const destination = join(workspace, "..", "corrupt-export");
  await assert.rejects(materializeWorkspaceSnapshot(versions, snapshot, destination), /integrity failure/);
  await assert.rejects(stat(destination), { code: "ENOENT" });
  const invalid = await versions.putRecord("WorkspaceTree", { entries: [{
    name: Buffer.from("../escape").toString("base64url"), type: "directory", tree: snapshot,
  }] });
  await assert.rejects(materializeWorkspaceSnapshot(versions, invalid, join(workspace, "..", "invalid-export")), /Invalid snapshot filename/);
  await assert.rejects(stat(join(workspace, "..", "escape")), { code: "ENOENT" });
});

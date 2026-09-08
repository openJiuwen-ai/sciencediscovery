// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { copyWorkspaceFile, publishWorkspaceFile } from "./workspace-copy.js";
import { SessionStore } from "./store.js";

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "workspace-copy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "target");
  await Promise.all([mkdir(source), mkdir(target)]);
  return { root, source, target };
}

test("local copies have separate bytes and identities, not shared mutable hard links", async (context) => {
  const { source, target } = await fixture(context);
  await writeFile(join(source, "file.txt"), "original");
  const result = await copyWorkspaceFile({ sourceRoot: source, sourcePath: "file.txt", targetRoot: target, targetPath: "nested/file.txt" });
  assert.equal(result.bytes, 8);
  assert.equal(result.sha256, createHash("sha256").update("original").digest("hex"));
  assert.ok(result.transferId);
  await writeFile(join(target, "nested/file.txt"), "target changed");
  assert.equal(await readFile(join(source, "file.txt"), "utf8"), "original");
});

test("publication rejects a file created during streaming, and explicit overwrite replaces it", async (context) => {
  const { target } = await fixture(context);
  const chunks = async function* () { yield Buffer.from("new"); await writeFile(join(target, "file"), "concurrent"); };
  await assert.rejects(publishWorkspaceFile({ root: target, path: "file", chunks: chunks() }), { code: "CONFLICT" });
  assert.equal(await readFile(join(target, "file"), "utf8"), "concurrent");
  await publishWorkspaceFile({ root: target, path: "file", conflict: "overwrite", chunks: chunks() });
  assert.equal(await readFile(join(target, "file"), "utf8"), "new");
  assert.deepEqual(await readdir(target), ["file"]);
});

test("source verification and checksum failures clean temporary files without publishing", async (context) => {
  const { target } = await fixture(context);
  const chunks = async function* () { yield Buffer.from("payload"); };
  await assert.rejects(publishWorkspaceFile({ root: target, path: "bad-hash", chunks: chunks(), expectedHash: "incorrect" }), /checksum/);
  await assert.rejects(publishWorkspaceFile({ root: target, path: "bad-size", chunks: chunks(), expectedBytes: 8 }), /size changed/);
  await assert.rejects(publishWorkspaceFile({ root: target, path: "changed", chunks: chunks(), verifySource: async () => { throw new Error("source changed"); } }), /source changed/);
  assert.deepEqual(await readdir(target), []);
});

test("cancelling a streaming publication cleans unfinished data but retains earlier completed files", async (context) => {
  const { source, target } = await fixture(context);
  await writeFile(join(source, "complete"), "keep");
  await copyWorkspaceFile({ sourceRoot: source, sourcePath: "complete", targetRoot: target, targetPath: "complete" });
  const controller = new AbortController();
  const chunks = async function* () { yield Buffer.from("first"); controller.abort(); yield Buffer.from("second"); };
  await assert.rejects(publishWorkspaceFile({ root: target, path: "partial", chunks: chunks(), signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(await readdir(target), ["complete"]);
});

test("copy denies traversal and symbolic links at the source, destination and intermediate directory", async (context) => {
  const { source, target } = await fixture(context);
  await writeFile(join(source, "file"), "private");
  await symlink(join(source, "file"), join(source, "link"));
  await symlink(source, join(target, "escape"));
  await symlink(join(source, "file"), join(target, "link"));
  for (const sourcePath of ["../target/file", "link"]) {
    await assert.rejects(copyWorkspaceFile({ sourceRoot: source, sourcePath, targetRoot: target, targetPath: "out" }));
  }
  for (const targetPath of ["../source/file", "escape/file", "link"]) {
    await assert.rejects(copyWorkspaceFile({ sourceRoot: source, sourcePath: "file", targetRoot: target, targetPath, conflict: "overwrite" }));
  }
  assert.equal(await readFile(join(source, "file"), "utf8"), "private");
});

test("Workspace identity includes Agent and Runner; new child audit paths resolve outside the parent tree", async (context) => {
  const { root } = await fixture(context);
  const store = new SessionStore(join(root, "data"));
  await store.load();
  const project = await store.createProject("Workspace identities");
  const session = await store.createSession(project.id, "Ownership", {}, {}, { allowUnconfiguredModel: true });
  const child = await store.createSubagent(session.id, "parent-request", { description: "Child", prompt: "Inspect selected input" });
  const main = store.workspaceIdentity(session.id);
  const local = store.workspaceIdentity(session.id, `subagent:${child.id}`);
  const remote = store.workspaceIdentity(session.id, `subagent:${child.id}`, "remote");
  assert.equal(new Set([main.id, local.id, remote.id]).size, 3);
  assert.deepEqual(store.workspaceIdentity(session.id), main);
  const logical = `subagents/${child.id}/output.txt`;
  assert.deepEqual(store.workspaceLocation(session.id, logical), { root: store.workspacePath(session.id), path: logical }, "legacy paths retain their original location");
  await store.updateSubagent({ ...child, handoff: { workspaceId: local.id, privateWorkspacePath: `subagents/${child.id}`,
    inputPaths: [], manifestPath: `subagents/${child.id}/handoff.json` } });
  const location = store.workspaceLocation(session.id, logical);
  assert.equal(location.root, store.agentWorkspacePath(session.id, child.id));
  assert.equal(location.path, "output.txt");
  assert.equal(location.root.startsWith(`${store.workspacePath(session.id)}/`), false);
  assert.throws(() => store.agentWorkspacePath(session.id, "../escape"), /Invalid Workspace owner/);
});

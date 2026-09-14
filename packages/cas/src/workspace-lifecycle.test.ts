// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { VersionStore } from "./versioning.js";
import { withWorkspaceMutation } from "./workspace-lease.js";
import { withWorkspaceAdmission, withWorkspaceRetirement } from "./workspace-lifecycle.js";

test("retirement drains admitted writes, rejects queued/new writes and keeps unrelated roots parallel", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "lifecycle-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const root = join(data, "session", "workspace");
  const other = join(data, "other");
  await mkdir(root, { recursive: true }); await mkdir(other);
  const versions = new VersionStore(data);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const writer = withWorkspaceMutation(versions, root, async () => {
    started.resolve(); await finish.promise; await writeFile(join(root, "final"), "complete");
  }, { kind: "test" });
  await started.promise;
  const queued = assert.rejects(withWorkspaceMutation(versions, root, async () => assert.fail("queued writer ran"), { kind: "test" }), /deleted/);
  let retired = false;
  const deletion = withWorkspaceRetirement(versions, [join(data, "session")], "delete", async () => {
    assert.equal(await readFile(join(root, "final"), "utf8"), "complete");
    await rename(join(data, "session"), join(data, "trash")); retired = true;
  });
  t.after(() => finish.resolve());
  // Poll the durable gate, not a timing assumption about the running writer.
  let closed = false;
  for (let i = 0; i < 100 && !closed; i++) {
    try { await withWorkspaceAdmission(versions, join(data, "session", "new-child"), async () => {}); }
    catch (error) { assert.match(String(error), /deleted/); closed = true; }
    if (!closed) await delay(5);
  }
  assert.ok(closed); assert.equal(retired, false);
  await withWorkspaceMutation(versions, other, async () => {}, { kind: "parallel" });
  finish.resolve(); await writer; await deletion; await queued;
  await assert.rejects(withWorkspaceAdmission(versions, root, async () => assert.fail("deleted root recreated")), /deleted/);
});

test("failed restoration stays closed across reopen; successful recovery reopens only its scope", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "lifecycle-recovery-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const root = join(data, "workspace"); await mkdir(root);
  const versions = new VersionStore(data);
  await withWorkspaceMutation(versions, root, async () => {}, { kind: "test" });
  await assert.rejects(withWorkspaceRetirement(versions, [root], "journal", async () => {
    await rename(root, join(data, "staged")); throw new Error("interrupted");
  }), /interrupted/);
  const reopened = new VersionStore(data);
  await assert.rejects(withWorkspaceAdmission(reopened, root, async () => {}), /deleted/);
  await withWorkspaceRetirement(reopened, [root], "journal", async (_roots, reopen) => {
    await rename(join(data, "staged"), root); reopen();
  });
  await withWorkspaceMutation(reopened, root, async () => writeFile(join(root, "restored"), "yes"), { kind: "test" });
  assert.equal(await readFile(join(root, "restored"), "utf8"), "yes");
});

test("overlapping retirement is rejected, but a retired child does not prevent later parent deletion", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "lifecycle-overlap-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const versions = new VersionStore(data);
  const parent = join(data, "project"); const child = join(parent, "session");
  await mkdir(child, { recursive: true });
  await withWorkspaceRetirement(versions, [child], "child", async () => {
    await assert.rejects(withWorkspaceRetirement(versions, [parent], "parent", async () => {}), /overlapping/);
  });
  await withWorkspaceRetirement(versions, [parent], "parent", async () => {});
  await assert.rejects(withWorkspaceAdmission(versions, join(parent, "new"), async () => {}), /deleted/);
});

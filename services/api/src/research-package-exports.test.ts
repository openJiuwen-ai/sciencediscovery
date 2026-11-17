// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { ResearchPackageExports, type ResearchPackageExportOptions } from "./research-package-exports.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

/** The streaming contract: the task hands a destination, the packager writes into it. */
const bytesCreated = (bytes: readonly number[]) => async (_input: ResearchPackageExportOptions, destination: Writable): Promise<void> => {
  await pipeline(Readable.from([Buffer.from(bytes)]), destination);
};

const options: ResearchPackageExportOptions = {
  projectId: "project", sessionId: "session", level: "complete", includeFullTrajectory: true,
  includeFullMemoryGraph: true, revision: "r1",
};

test("background exports serialize creation, persist downloads across restart and enforce project scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-exports-"));
  let active = 0, peak = 0, calls = 0;
  const create = async (input: ResearchPackageExportOptions, destination: Writable) => {
    assert.deepEqual(input, options);
    active++; peak = Math.max(peak, active); calls++;
    await new Promise<void>((resolve) => setImmediate(resolve)); active--;
    await pipeline(Readable.from([Buffer.from([1, 2, 3])]), destination);
  };
  const exports = new ResearchPackageExports(root, async () => "r1", create);
  try {
    const first = await exports.start(options, "研究证据.sdresearch");
    const second = await exports.start(options, "研究证据2.sdresearch");
    await exports.close();
    assert.equal(calls, 2); assert.equal(peak, 1);
    assert.equal((await exports.get(first.id, "project"))?.status, "completed");
    assert.equal((await exports.get(second.id, "project"))?.status, "completed");
    assert.equal(await exports.get(first.id, "other-project"), undefined);
    assert.equal(await exports.download(first.id, "other-project"), undefined);
    const restored = new ResearchPackageExports(root, async () => "r1", create);
    const file = await restored.download(first.id, "project");
    assert.equal(file?.filename, "研究证据.sdresearch");
    assert.deepEqual([...await readFile(file!.path)], [1, 2, 3]);
    assert.equal(calls, 2, "restart serves the original package without rebuilding it");
    await restored.close();
  } finally { await exports.close(); await rm(root, { recursive: true, force: true }); }
});

test("prunes expired tasks and rejects expired downloads while the process stays running", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-exports-"));
  let now = Date.now();
  const exports = new ResearchPackageExports(root, async () => "r1", bytesCreated([1]), () => now);
  try {
    const first = await exports.start(options, "first.sdresearch");
    const second = await exports.start(options, "second.sdresearch");
    await exports.close();
    const firstFile = await exports.download(first.id, "project");
    const secondFile = await exports.download(second.id, "project");
    assert.ok(firstFile);
    assert.ok(secondFile);

    now += 24 * 60 * 60 * 1000 + 1;
    assert.equal(await exports.get(first.id, "project"), undefined);
    assert.equal(await exports.download(second.id, "project"), undefined);
    await assert.rejects(() => readFile(join(root, `${first.id}.json`)), { code: "ENOENT" });
    await assert.rejects(() => readFile(firstFile.path), { code: "ENOENT" });
    await assert.rejects(() => readFile(join(root, `${second.id}.json`)), { code: "ENOENT" });
    await assert.rejects(() => readFile(secondFile.path), { code: "ENOENT" });
  } finally { await exports.close(); await rm(root, { recursive: true, force: true }); }
});

test("revision changes fail the affected export without publishing a stale download or blocking later tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-exports-"));
  let revision = "r2", creates = 0;
  const exports = new ResearchPackageExports(root, async () => revision, async (_input, destination) => {
    creates++; revision = "r3"; await pipeline(Readable.from([Buffer.from([1])]), destination);
  });
  try {
    const stale = await exports.start(options, "stale.sdresearch");
    await exports.close();
    assert.equal((await exports.get(stale.id, "project"))?.status, "failed");
    assert.equal(creates, 0);
    const changed = await exports.start({ ...options, revision: "r2" }, "changed.sdresearch");
    await exports.close();
    assert.equal((await exports.get(changed.id, "project"))?.status, "failed");
    assert.equal(await exports.download(changed.id, "project"), undefined);
    const fresh = await exports.start({ ...options, revision: "r3" }, "fresh.sdresearch");
    await exports.close();
    assert.equal((await exports.get(fresh.id, "project"))?.status, "completed");
    assert.equal(creates, 2);
  } finally { await exports.close(); await rm(root, { recursive: true, force: true }); }
});

test("restart reports interrupted exports as failed rather than leaving them permanently running", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-exports-"));
  const id = "12345678-1234-1234-1234-123456789abc";
  try {
    const now = new Date().toISOString();
    await writeFile(join(root, `${id}.json`), JSON.stringify({ id, projectId: "project", filename: "test.sdresearch", status: "running", createdAt: now, updatedAt: now }));
    const exports = new ResearchPackageExports(root, async () => "r1", async () => assert.fail("must not silently restart interrupted work"));
    assert.equal((await exports.get(id, "project"))?.status, "failed");
    assert.equal(await exports.download(id, "project"), undefined);
    await exports.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cancel removes a queued export without packaging and leaves completed exports untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-exports-"));
  let creates = 0;
  const create = async (_input: ResearchPackageExportOptions, destination: Writable) => {
    creates++;
    await pipeline(Readable.from([Buffer.from([1])]), destination);
  };
  const exports = new ResearchPackageExports(root, async () => "r1", create);
  try {
    const first = await exports.start(options, "first.sdresearch");
    const second = await exports.start(options, "second.sdresearch");
    assert.equal((await exports.cancel(second.id, "project"))?.status, "canceled");
    await exports.close();
    assert.equal((await exports.get(first.id, "project"))?.status, "completed");
    assert.equal((await exports.get(second.id, "project"))?.status, "canceled");
    assert.equal(creates, 1, "the cancelled queued task must never package");
    assert.equal(await exports.download(second.id, "project"), undefined);
  } finally { await exports.close(); await rm(root, { recursive: true, force: true }); }
});

test("cancel during packaging drops the produced archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-exports-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const create = async (_input: ResearchPackageExportOptions, destination: Writable) => {
    await gate;
    await pipeline(Readable.from([Buffer.from([1])]), destination);
  };
  const exports = new ResearchPackageExports(root, async () => "r1", create);
  try {
    const task = await exports.start(options, "task.sdresearch");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await exports.cancel(task.id, "project"))?.status, "canceled");
    release();
    await exports.close();
    assert.equal((await exports.get(task.id, "project"))?.status, "canceled");
    assert.equal(await exports.download(task.id, "project"), undefined);
    await assert.rejects(() => readFile(join(root, `${task.id}.sdresearch`)), { code: "ENOENT" },
      "a cancelled export leaves no partial archive");
  } finally { release?.(); await exports.close(); await rm(root, { recursive: true, force: true }); }
});

test("cancel returns a finished task unchanged so a late cancel cannot undo a package", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-exports-"));
  const exports = new ResearchPackageExports(root, async () => "r1", bytesCreated([7]));
  try {
    const task = await exports.start(options, "done.sdresearch");
    await exports.close();
    assert.equal((await exports.get(task.id, "project"))?.status, "completed");
    // The renderer offers cancel on a click that raced completion; the answer
    // must stay "completed" so the UI keeps the saved package.
    assert.equal((await exports.cancel(task.id, "project"))?.status, "completed");
    const file = await exports.download(task.id, "project");
    assert.ok(file, "a late cancel must not remove the finished archive");
    assert.deepEqual([...await readFile(file.path)], [7]);
  } finally { await exports.close(); await rm(root, { recursive: true, force: true }); }
});

test("a write failure leaves no partial archive behind", async () => {
  // The streaming writer appends to the task's own file, so a failure halfway is a
  // truncated download unless the task removes it (#1152 stage 2).
  const root = await mkdtemp(join(tmpdir(), "research-exports-"));
  const exports = new ResearchPackageExports(root, async () => "r1", async (_input, destination) => {
    await pipeline(Readable.from([Buffer.from([1, 2, 3])]), destination);
    throw new Error("磁盘空间不足");
  });
  try {
    const task = await exports.start(options, "broken.sdresearch");
    await exports.close();
    assert.equal((await exports.get(task.id, "project"))?.status, "failed");
    assert.equal(await exports.download(task.id, "project"), undefined);
    await assert.rejects(() => readFile(join(root, `${task.id}.sdresearch`)), { code: "ENOENT" },
      "a failed export must not leave a truncated archive");
  } finally { await exports.close(); await rm(root, { recursive: true, force: true }); }
});

test("cancel of an unknown task is not found", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-exports-"));
  const exports = new ResearchPackageExports(root, async () => "r1", bytesCreated([1]));
  try {
    assert.equal(await exports.cancel("12345678-1234-1234-1234-123456789abc", "project"), undefined);
  } finally { await exports.close(); await rm(root, { recursive: true, force: true }); }
});

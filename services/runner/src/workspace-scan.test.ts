// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { TestContext } from "node:test";

import { workspaceSnapshot, workspaceUsageBytes } from "./executor.js";

const originalReaddir = fs.readdir;
const originalStat = fs.stat;

async function workspace(context: TestContext): Promise<string> {
  const root = await fs.mkdtemp(resolve(tmpdir(), "runner-workspace-scan-"));
  context.after(async () => {
    // Restoring the default export alone leaves named ESM imports mocked.
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function beforeStat(context: TestContext, action: (path: string) => Promise<void>): void {
  context.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
    await action(String(args[0]));
    return originalStat(...args);
  });
  syncBuiltinESMExports();
}

function afterReaddir(context: TestContext, action: (path: string) => Promise<void>): void {
  context.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    const entries = await originalReaddir(...args);
    await action(String(args[0]));
    return entries;
  });
  syncBuiltinESMExports();
}

function snapshotBytes(snapshot: Map<string, string>): number {
  return [...snapshot.values()].reduce((sum, value) => sum + Number(value.split(":", 1)[0]), 0);
}

// File-local builtin mocks run serially. Both entry points must have the same
// race behavior because snapshots and the live quota watcher share traversal.
const scannerNames = ["workspaceSnapshot", "workspaceUsageBytes"] as const;

test("workspace scans count stable files, dotfiles and nested files without following symlinks", async (context) => {
  const root = await workspace(context);
  const files = new Map([
    ["weights.bin", Buffer.from([0, 255, 7, 128])],
    [".checkpoint.tmp", Buffer.from("unpublished but present")],
    ["empty", Buffer.alloc(0)],
    ["nested/metrics.json", Buffer.from('{"loss":0.25}')],
    [".cache/state", Buffer.from("训练状态")],
  ]);
  await fs.mkdir(resolve(root, "nested"));
  await fs.mkdir(resolve(root, ".cache"));
  for (const [path, contents] of files) { await fs.writeFile(resolve(root, path), contents); }
  await fs.symlink(resolve(root, "weights.bin"), resolve(root, "weight-link"));
  await fs.symlink(resolve(root, "nested"), resolve(root, "directory-link"));
  await fs.symlink(resolve(root, "absent"), resolve(root, "broken-link"));

  const expected = new Map<string, string>();
  for (const path of files.keys()) {
    const metadata = await originalStat(resolve(root, path));
    expected.set(path, `${metadata.size}:${metadata.mtimeMs}`);
  }
  assert.deepEqual(await workspaceSnapshot(root), expected);
  assert.equal(await workspaceUsageBytes(root), [...files.values()].reduce((sum, value) => sum + value.length, 0));
});

for (const name of scannerNames) {
  const scan = async (root: string) => name === "workspaceSnapshot"
    ? snapshotBytes(await workspaceSnapshot(root)) : workspaceUsageBytes(root);
  test(`${name} tolerates a real atomic publish between readdir and stat, then sees the published file`, async (context) => {
    const root = await workspace(context);
    const temporary = resolve(root, ".checkpoint.tmp");
    const published = resolve(root, "checkpoint.pt");
    await fs.writeFile(resolve(root, "stable.txt"), "stable");
    await fs.writeFile(temporary, "new checkpoint");
    let publishes = 0;
    beforeStat(context, async (path) => {
      if (path === temporary && publishes === 0) {
        publishes += 1;
        await fs.rename(temporary, published);
      }
    });

    assert.equal(await scan(root), Buffer.byteLength("stable"));
    assert.equal(publishes, 1, "the test must hit the enumerated-file/stat race");
    assert.equal(await scan(root), Buffer.byteLength("stable") + Buffer.byteLength("new checkpoint"));
    const next = await workspaceSnapshot(root);
    assert.ok(next.has("checkpoint.pt"));
    assert.ok(!next.has(".checkpoint.tmp"));
  });

  test(`${name} tolerates an enumerated nested directory removed before traversal`, async (context) => {
    const root = await workspace(context);
    const removed = resolve(root, "scratch");
    await fs.mkdir(removed);
    await fs.writeFile(resolve(removed, "transient"), "removed");
    await fs.writeFile(resolve(root, "stable"), "retained");
    let removals = 0;
    afterReaddir(context, async (path) => {
      if (path === root && removals === 0) {
        removals += 1;
        await fs.rm(removed, { recursive: true });
      }
    });

    assert.equal(await scan(root), Buffer.byteLength("retained"));
    assert.equal(removals, 1, "the test must remove an already-enumerated directory");
    assert.equal(await scan(root), Buffer.byteLength("retained"));
  });

  test(`${name} rejects a missing workspace root`, async (context) => {
    const root = await workspace(context);
    await fs.rm(root, { recursive: true });
    await assert.rejects(scan(root), { code: "ENOENT" });
  });

  for (const empty of [false, true]) {
    test(`${name} rejects ${empty ? "an empty" : "a"} workspace root removed after enumeration`, async (context) => {
      const root = await workspace(context);
      if (!empty) {
        await fs.writeFile(resolve(root, "enumerated"), "not an empty workspace");
      }
      let removals = 0;
      afterReaddir(context, async (path) => {
        if (path === root && removals === 0) {
          removals += 1;
          await fs.rm(root, { recursive: true });
        }
      });

      await assert.rejects(scan(root), { code: "ENOENT" });
      assert.equal(removals, 1);
    });
  }

  test(`${name} rejects a workspace root replaced by a file after enumeration`, async (context) => {
    const root = await workspace(context);
    let replacements = 0;
    afterReaddir(context, async (path) => {
      if (path === root && replacements === 0) {
        replacements += 1;
        await fs.rm(root, { recursive: true });
        await fs.writeFile(root, "not a workspace directory");
      }
    });

    await assert.rejects(scan(root), { code: "ENOTDIR" });
    assert.equal(replacements, 1);
  });

  for (const code of ["EACCES", "EPERM", "EIO", "ENOTDIR"]) {
    test(`${name} propagates ${code} from an enumerated file stat`, async (context) => {
      const root = await workspace(context);
      const path = resolve(root, "checkpoint");
      await fs.writeFile(path, "data");
      const failure = Object.assign(new Error(`injected ${code} during stat`), { code, path });
      beforeStat(context, async (candidate) => {
        if (candidate === path) { throw failure; }
      });

      await assert.rejects(scan(root), (error: unknown) => error === failure);
    });

    test(`${name} propagates ${code} while traversing an enumerated directory`, async (context) => {
      const root = await workspace(context);
      const path = resolve(root, "scratch");
      await fs.mkdir(path);
      const failure = Object.assign(new Error(`injected ${code} during readdir`), { code, path });
      context.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
        if (String(args[0]) === path) { throw failure; }
        return originalReaddir(...args);
      });
      syncBuiltinESMExports();

      await assert.rejects(scan(root), (error: unknown) => error === failure);
    });
  }
}

test("repeated live quota scans survive atomic publishes while retaining meaningful byte totals", async (context) => {
  const root = await workspace(context);
  const stableBytes = 37;
  const quotaBytes = 1_000;
  await fs.writeFile(resolve(root, "stable.bin"), Buffer.alloc(stableBytes));
  let temporary: string | undefined;
  let published: string | undefined;
  let publishes = 0;
  beforeStat(context, async (path) => {
    if (path === temporary && published !== undefined) {
      await fs.rename(temporary, published);
      temporary = undefined;
      published = undefined;
      publishes += 1;
    }
  });

  let expectedBytes = stableBytes;
  assert.ok(await workspaceUsageBytes(root) < quotaBytes);
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const bytes = 128 + iteration;
    temporary = resolve(root, `.checkpoint-${iteration}.tmp`);
    published = resolve(root, `checkpoint-${iteration}.pt`);
    await fs.writeFile(temporary, Buffer.alloc(bytes, iteration));

    assert.equal(await workspaceUsageBytes(root), expectedBytes, `racing scan ${iteration} must retain every stable byte`);
    expectedBytes += bytes;
    assert.equal(await workspaceUsageBytes(root), expectedBytes, `settled scan ${iteration} must include the published checkpoint`);
  }

  assert.equal(publishes, 24);
  assert.equal(await workspaceUsageBytes(root), expectedBytes);
  assert.ok(expectedBytes > quotaBytes, "a real quota breach remains observable after the races");
  assert.equal((await workspaceSnapshot(root)).size, 25);
});

test("repeated live quota scans count atomically replaced checkpoints rather than ignoring temporary-file usage", async (context) => {
  const root = await workspace(context);
  const temporary = resolve(root, ".checkpoint.tmp");
  const published = resolve(root, "checkpoint.pt");
  const stableBytes = 29;
  await fs.writeFile(resolve(root, "stable.bin"), Buffer.alloc(stableBytes));
  await fs.writeFile(published, Buffer.alloc(1));
  let publishOnRead = false;
  let publishes = 0;
  afterReaddir(context, async (path) => {
    if (path === root && publishOnRead) {
      publishOnRead = false;
      publishes += 1;
      await fs.rename(temporary, published);
    }
  });

  for (let iteration = 0; iteration < 24; iteration += 1) {
    const oldBytes = iteration === 0 ? 1 : 128 + iteration - 1;
    const newBytes = 128 + iteration;
    await fs.writeFile(temporary, Buffer.alloc(newBytes, iteration));
    assert.equal(await workspaceUsageBytes(root), stableBytes + oldBytes + newBytes,
      "an unpublished temporary checkpoint must count while it still exists");

    publishOnRead = true;
    assert.equal(await workspaceUsageBytes(root), stableBytes + newBytes,
      "a racing scan must count the replacement destination and omit only the vanished temporary path");
    assert.equal(await workspaceUsageBytes(root), stableBytes + newBytes);
  }

  assert.equal(publishes, 24);
  assert.deepEqual([...(await workspaceSnapshot(root)).keys()].sort(), ["checkpoint.pt", "stable.bin"]);
});

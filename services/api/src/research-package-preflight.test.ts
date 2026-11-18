// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import {
  assertResearchPackageExportCapacity, assertResearchPackageResponseExportCapacity, assertResearchPackageRestoreCapacity, assertResearchPackageUploadCapacity,
  measureResearchPackageCapacity, researchPackageBudgetRefusal, researchPackageExportRequirement, researchPackageResponseExportRequirement, researchPackageRestoreRequirement,
  researchPackageUnpackBudget, researchPackageUploadRequirement, restoreSizeOf,
  RESEARCH_PACKAGE_DISK_CODE, RESEARCH_PACKAGE_MEMORY_CODE,
} from "./research-package-preflight.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

const MIB = 1024 * 1024;
const CAPACITY = (freeDiskBytes: number, freeMemoryBytes = 8 * 1024 * MIB) => ({ freeDiskBytes, freeMemoryBytes });

test("an export is charged the archive it writes, not the copies a restore adds", () => {
  // 5 GiB uncompressed / 1.5 GiB archive on 4 GiB free: the task writes one file, so it
  // must start (#1200 review 3).
  const need = researchPackageExportRequirement(1.5 * 1024 * MIB);
  assert.equal(need.diskBytes, 1.5 * 1024 * MIB);
  assert.equal(need.memoryBytes, 512 * MIB + 256 * MIB, "one object at a time, capped at 512 MiB");
  assert.doesNotThrow(() => assertResearchPackageExportCapacity(CAPACITY(4 * 1024 * MIB), 1.5 * 1024 * MIB));
  assert.throws(() => assertResearchPackageExportCapacity(CAPACITY(1024 * MIB), 1.5 * 1024 * MIB),
    (error: NodeJS.ErrnoException) => error.code === RESEARCH_PACKAGE_DISK_CODE);
  assert.equal(researchPackageExportRequirement(-1).diskBytes, 0, "an unknown size asks for nothing");
});

test("the response export is charged no disk because it writes the client's bytes", () => {
  // The synchronous route streams into the HTTP response; nothing lands under dataDir,
  // so a short data volume must not refuse a download the client has room for
  // (#1216 review 1).
  const size = 4 * 1024 * MIB;
  assert.equal(researchPackageResponseExportRequirement(size).diskBytes, 0);
  assert.equal(researchPackageResponseExportRequirement(size).memoryBytes, 512 * MIB + 256 * MIB);
  assert.doesNotThrow(() => assertResearchPackageResponseExportCapacity(CAPACITY(0), size));
  // Memory still bounds it: the writer holds one object at a time.
  assert.throws(() => assertResearchPackageResponseExportCapacity(CAPACITY(0, 100 * MIB), size),
    (error: NodeJS.ErrnoException) => error.code === RESEARCH_PACKAGE_MEMORY_CODE);
});

test("an inspect unpacks one copy where a restore adds three", () => {
  const free = 10 * 1024 * MIB;
  const unpacked = Math.floor(3.8 * 1024 * MIB);
  // Restore: upload + snapshot objects + CAS blobs + workspace files = four copies.
  assert.ok(researchPackageUnpackBudget(CAPACITY(free), 8 * 1024 * MIB) < unpacked,
    "the restore budget must stay conservative");
  // Inspect: the upload plus the one copy it unpacks, so it fits (#1216 review 3).
  assert.ok(researchPackageUnpackBudget(CAPACITY(free), 8 * 1024 * MIB, 1) >= unpacked,
    "an inspect writes one more copy, so the unpacked tree plus that one is free / 2");
});

test("the upload check only stages the compressed file", () => {
  const need = researchPackageUploadRequirement(300 * MIB);
  assert.equal(need.diskBytes, 300 * MIB);
  assert.equal(need.memoryBytes, 256 * MIB);
  assert.doesNotThrow(() => assertResearchPackageUploadCapacity(CAPACITY(400 * MIB), 300 * MIB));
  assert.throws(() => assertResearchPackageUploadCapacity(CAPACITY(200 * MIB), 300 * MIB),
    (error: NodeJS.ErrnoException) => error.code === RESEARCH_PACKAGE_DISK_CODE);
});

test("an export is refused when available memory cannot hold one object", () => {
  assert.throws(() => assertResearchPackageExportCapacity(CAPACITY(100 * 1024 * MIB, 100 * MIB), 512 * MIB),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, RESEARCH_PACKAGE_MEMORY_CODE);
      assert.match(error.message, /可用内存不足/);
      return true;
    });
});

test("a restore is charged only the copies it still has to write", () => {
  const size = restoreSizeOf([
    { kind: "records", sizeBytes: 1_000_000 },
    { kind: "object", sizeBytes: 300 * MIB },
    { kind: "object", sizeBytes: 700 * MIB },
  ], 1_000_000);
  assert.equal(size.unpackedBytes, 1000 * MIB);
  assert.equal(size.largestObjectBytes, 700 * MIB);
  const need = researchPackageRestoreRequirement(size);
  // The unpacked upload is on disk; snapshot objects, CAS blobs and workspace files remain.
  assert.equal(need.diskBytes, 3000 * MIB + 1_000_000);
  assert.equal(need.memoryBytes, 700 * MIB + 256 * MIB, "one object at a time, plus headroom");
});

test("the unpack budget and the post-parse check agree on the same free disk", () => {
  const free = 16 * 1024 * MIB;
  const budget = researchPackageUnpackBudget(CAPACITY(free), 8 * 1024 * MIB);
  // Sit ON the bound: the tree the budget admits is the largest one the parse will
  // write, so the restore that follows it must not refuse what the budget allowed.
  // It clears by construction, up to the record size the budget cannot know yet.
  const unpacked = budget;
  const after = CAPACITY(free - unpacked);
  const need = researchPackageRestoreRequirement({ unpackedBytes: unpacked, largestObjectBytes: unpacked, recordsBytes: 1024 });
  assert.ok(need.diskBytes <= after.freeDiskBytes + 1024,
    `the budget must leave the restore within one record of fitting: needs ${need.diskBytes}, has ${after.freeDiskBytes}`);
  // Exactly on the bound the restore is satisfiable: the tree took free / 4, the
  // three remaining copies need the other three quarters.
  assert.doesNotThrow(() => assertResearchPackageRestoreCapacity(CAPACITY(free - unpacked), {
    unpackedBytes: unpacked, largestObjectBytes: unpacked, recordsBytes: 0,
  }), "the budget boundary is where the two checks meet");

  // A restore writes three more copies, so the unpacked tree gets free / 4.
  assert.equal(researchPackageUnpackBudget(CAPACITY(30 * 1024 * MIB), 48 * 1024 * MIB), 7.5 * 1024 * MIB);
  assert.equal(researchPackageUnpackBudget(CAPACITY(6 * 1024 * MIB), 8 * 1024 * MIB), 1.5 * 1024 * MIB);
  assert.equal(researchPackageUnpackBudget(CAPACITY(2 * MIB), 8 * 1024 * MIB), Math.floor((2 * MIB) / 4));
  assert.equal(researchPackageUnpackBudget(CAPACITY(Infinity), 8 * 1024 * MIB), 8 * 1024 * MIB);
});

test("the budget refusal quotes a need that exceeds the space it names", () => {
  // The review's example: a package with 2 MiB of objects on a host with 3 MiB free. The
  // budget is free / 3, so the parse stops; the message must say the import needs more
  // than the 3 MiB it has, never less (#1200 review 5).
  const free = 3 * MIB;
  const refusal = researchPackageBudgetRefusal(2 * MIB, free);
  assert.equal(refusal.needBytes, 6 * MIB, "three copies of the unpacked total");
  assert.ok(refusal.needBytes > free, "the message cannot claim there is enough room");
  assert.match(refusal.message, /至少需要约 6 MiB/);
  assert.match(refusal.message, /当前只有 3 MiB/);
});

test("a restore is refused on the unpacked size that a compressed upload hides", () => {
  // A 300 KB archive can inflate to gigabytes; only the parsed inventory knows that.
  const size = { unpackedBytes: 4096 * MIB, largestObjectBytes: 4096 * MIB, recordsBytes: 1024 };
  assert.throws(() => assertResearchPackageRestoreCapacity(CAPACITY(1024 * MIB), size),
    (error: NodeJS.ErrnoException) => error.code === RESEARCH_PACKAGE_DISK_CODE);
  assert.throws(() => assertResearchPackageRestoreCapacity(CAPACITY(64 * 1024 * MIB, 512 * MIB), size),
    (error: NodeJS.ErrnoException) => error.code === RESEARCH_PACKAGE_MEMORY_CODE);
  assert.doesNotThrow(() => assertResearchPackageRestoreCapacity(CAPACITY(64 * 1024 * MIB), size));
});

test("the measurement reports the volume and the available memory", async () => {
  const capacity = await measureResearchPackageCapacity(tmpdir());
  assert.ok(capacity.freeDiskBytes > 0);
  assert.ok(capacity.freeMemoryBytes > 0);
});

test("the unpack budget counts the copies a route writes, so inspect and restore differ", () => {
  // The same capacity and the same ceiling, two routes: an inspect unpacks one copy
  // and writes nothing else, a restore keeps three. Pinning both keeps the third
  // argument from being deleted later without a red test (#1216 review 3, #1024).
  const capacity = { freeDiskBytes: 6_000, freeMemoryBytes: Number.POSITIVE_INFINITY };
  const ceiling = 1_000_000;
  assert.equal(researchPackageUnpackBudget(capacity, ceiling, 1), 3_000, "inspect: free / 2");
  assert.equal(researchPackageUnpackBudget(capacity, ceiling), 1_500, "restore: free / 4");
  assert.notEqual(researchPackageUnpackBudget(capacity, ceiling, 1), researchPackageUnpackBudget(capacity, ceiling));
  // A ceiling still wins, and an infinite volume is never bounded.
  assert.equal(researchPackageUnpackBudget(capacity, 500, 1), 500);
  assert.equal(researchPackageUnpackBudget({ freeDiskBytes: Number.POSITIVE_INFINITY, freeMemoryBytes: 0 }, ceiling, 1), ceiling);
});


// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import {
  assertResearchPackageExportCapacity, assertResearchPackageRestoreCapacity, assertResearchPackageUploadCapacity,
  measureResearchPackageCapacity, researchPackageBudgetRefusal, researchPackageExportRequirement, researchPackageRestoreRequirement,
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
  // The unpacked upload is already on disk; the snapshot objects and the CAS blobs remain.
  assert.equal(need.diskBytes, 2000 * MIB + 1_000_000);
  assert.equal(need.memoryBytes, 700 * MIB + 256 * MIB, "one object at a time, plus headroom");
});

test("the unpack budget and the post-parse check agree on the same free disk", () => {
  // The example from the review: 12 GiB free, a 3.8 GiB package.
  const free = 12 * 1024 * MIB;
  const unpacked = Math.floor(3.8 * 1024 * MIB);
  const budget = researchPackageUnpackBudget(CAPACITY(free), 8 * 1024 * MIB);
  assert.ok(budget >= unpacked, "the parse is allowed to write the objects");
  // After the parse those bytes are on disk; only the two remaining copies are checked.
  const after = CAPACITY(free - unpacked);
  assert.doesNotThrow(() => assertResearchPackageRestoreCapacity(after, {
    unpackedBytes: unpacked, largestObjectBytes: unpacked, recordsBytes: 1024,
  }), "a package the budget allowed must not be refused once it is on disk");

  assert.equal(researchPackageUnpackBudget(CAPACITY(30 * 1024 * MIB), 8 * 1024 * MIB), 8 * 1024 * MIB);
  assert.equal(researchPackageUnpackBudget(CAPACITY(6 * 1024 * MIB), 8 * 1024 * MIB), 2 * 1024 * MIB);
  assert.equal(researchPackageUnpackBudget(CAPACITY(2 * MIB), 8 * 1024 * MIB), Math.floor((2 * MIB) / 3));
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

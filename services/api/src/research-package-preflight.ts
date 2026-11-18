// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { readFile, statfs } from "node:fs/promises";
import { freemem } from "node:os";

export const RESEARCH_PACKAGE_DISK_CODE = "RESEARCH_PACKAGE_INSUFFICIENT_DISK";
export const RESEARCH_PACKAGE_MEMORY_CODE = "RESEARCH_PACKAGE_INSUFFICIENT_MEMORY";

/** What the machine has for one package operation. */
export type PackageCapacity = { freeDiskBytes: number; freeMemoryBytes: number };

/**
 * What an export writes: one compressed archive.
 *
 * The uncompressed size bounds it from above (gzip never makes incompressible data
 * usefully larger than its input, and the cap already allows that slack), so charging
 * three copies here — as a restore needs — refused exports that only ever write one
 * file (#1200 review 3).
 */
export function researchPackageExportRequirement(bytes: number): { diskBytes: number; memoryBytes: number } {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return { diskBytes: safe, memoryBytes: Math.min(safe, 512 * 1024 * 1024) + 256 * 1024 * 1024 };
}

/**
 * What the synchronous export writes: the HTTP response, and no disk at all.
 *
 * That route streams tar -> gzip straight into `ServerResponse`, and the volume
 * the bytes land on is the client's, not `store.dataDir`'s. Charging an archive
 * here refused exports that need no space on this machine — a 4 GiB package on a
 * volume with 3 GiB free is exactly the multi-GiB case the streaming path exists
 * for (#1216 review 1). Only the memory headroom applies: the writer still holds
 * one object at a time.
 */
export function researchPackageResponseExportRequirement(bytes: number): { diskBytes: number; memoryBytes: number } {
  return { diskBytes: 0, memoryBytes: researchPackageExportRequirement(bytes).memoryBytes };
}

/** What an upload needs before anything is parsed: the staged compressed file. */
export function researchPackageUploadRequirement(bytes: number): { diskBytes: number; memoryBytes: number } {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return { diskBytes: safe, memoryBytes: 256 * 1024 * 1024 };
}

function refusal(code: string, message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

/**
 * Refuse a package operation before it starts instead of failing halfway.
 *
 * The message is user-facing: an export that dies at 80% leaves a truncated file and a
 * dialog that only says the export failed, while this says what was missing.
 */
export function assertResearchPackageExportCapacity(capacity: PackageCapacity, archiveBytes: number): void {
  assertCapacity(capacity, researchPackageExportRequirement(archiveBytes));
}

/** The response route writes no disk, so only its memory headroom is charged. */
export function assertResearchPackageResponseExportCapacity(capacity: PackageCapacity, archiveBytes: number): void {
  assertCapacity(capacity, researchPackageResponseExportRequirement(archiveBytes));
}

/** The upload is the first bound a client meets; it only stages the compressed file. */
export function assertResearchPackageUploadCapacity(capacity: PackageCapacity, uploadBytes: number): void {
  assertCapacity(capacity, researchPackageUploadRequirement(uploadBytes));
}

/** Measure the machine's capacity for a package operation on `dataDir`'s volume. */
export async function measureResearchPackageCapacity(dataDir: string): Promise<PackageCapacity> {
  let freeDiskBytes = 0;
  try {
    const stats = await statfs(dataDir);
    freeDiskBytes = stats.bavail * stats.bsize;
  } catch {
    // An unreadable statfs must not block work the disk may well hold: the operation
    // still fails honestly if it runs out, and refusing on an unknown would take the
    // feature away on platforms where this call is unsupported.
    freeDiskBytes = Number.POSITIVE_INFINITY;
  }
  return { freeDiskBytes, freeMemoryBytes: await availableMemoryBytes() };
}

/**
 * Memory the kernel could hand out, not memory that happens to be free.
 *
 * `os.freemem()` is `MemFree` on Linux, which excludes reclaimable page cache: a warm
 * host that just wrote large files reports a few hundred MiB and every package would be
 * refused with advice the user cannot act on. `MemAvailable` is the number to compare
 * against (#1200 review 2).
 */
async function availableMemoryBytes(): Promise<number> {
  try {
    const info = await readFile("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(info);
    if (match) return Number(match[1]) * 1024;
  } catch { /* not Linux, or /proc is not mounted */ }
  return freemem();
}

/** What a restore needs, known only after the archive has been parsed. */
export type PackageRestoreSize = { unpackedBytes: number; largestObjectBytes: number; recordsBytes: number };

/**
 * What a restore still has to write, from the moment it is checked.
 *
 * The unpacked objects are already on disk — the streamed import wrote them — and the
 * restore adds three more copies: the snapshot's object directory, one CAS blob per
 * object, and the workspace files (plus a version blob per version object, which for the
 * normal shape equals the object bytes). Two was one short once the workspace write is
 * counted (#1211 F5). It reads one object at a time, so its memory is the largest single
 * object.
 */
export function researchPackageRestoreRequirement(size: PackageRestoreSize): { diskBytes: number; memoryBytes: number } {
  const unpacked = Number.isFinite(size.unpackedBytes) && size.unpackedBytes > 0 ? size.unpackedBytes : 0;
  const records = Number.isFinite(size.recordsBytes) && size.recordsBytes > 0 ? size.recordsBytes : 0;
  const largest = Number.isFinite(size.largestObjectBytes) && size.largestObjectBytes > 0 ? size.largestObjectBytes : 0;
  return { diskBytes: unpacked * 3 + records, memoryBytes: Math.max(largest, records) + 256 * 1024 * 1024 };
}

/** The same refusals as `assertResearchPackageCapacity`, measured on what the restore will do. */
export function assertResearchPackageRestoreCapacity(capacity: PackageCapacity, size: PackageRestoreSize): void {
  assertCapacity(capacity, researchPackageRestoreRequirement(size));
}

/**
 * The unpacked budget the free disk can hold, given the copies the route still writes.
 *
 * `copies` counts what the route writes *after* the parse has already put the unpacked
 * tree on disk, so the divisor is `copies + 1`. A restore writes three more — the
 * snapshot's object directory, one CAS blob per object and the workspace files, which
 * `researchPackageRestoreRequirement` charges as `unpacked * 3` — so its default is
 * `free / 4`. Dividing by three admitted a tree of up to `free / 3`, expanded it, and
 * then failed the post-parse check that needs `3 x unpacked`; the refusal has to come
 * before the write, which is why the divisor follows the requirement (#1216 review 3).
 *
 * An inspect unpacks one copy and writes one more while it reads it, so it passes
 * `copies: 1` and gets `free / 2`; sharing the restore's divisor refused an inspect
 * whose objects fit.
 *
 * The bound has to reach the parser itself: checking only after the unpacking finishes
 * would let a highly compressible archive fill the disk before the check runs.
 */
export function researchPackageUnpackBudget(capacity: PackageCapacity, ceiling: number, copies = 3): number {
  if (!Number.isFinite(capacity.freeDiskBytes)) return ceiling;
  // `copies` is what the route still writes after the parse has unpacked the tree, so
  // the divisor is that plus the unpacked copy itself.
  const parts = Math.max(1, Math.floor(copies) + 1);
  return Math.max(0, Math.min(ceiling, Math.floor(capacity.freeDiskBytes / parts)));
}

/** Derive the restore's size from a parsed package's inventory. */
export function restoreSizeOf(inventory: ReadonlyArray<{ kind: string; sizeBytes: number }>, recordsBytes: number): PackageRestoreSize {
  let unpackedBytes = 0; let largestObjectBytes = 0;
  for (const entry of inventory) {
    if (entry.kind === "object") {
      unpackedBytes += entry.sizeBytes;
      largestObjectBytes = Math.max(largestObjectBytes, entry.sizeBytes);
    } else if (entry.kind === "records") continue;
  }
  return { unpackedBytes, largestObjectBytes, recordsBytes };
}

/** The disk refusal both the checks and the streamed parse's budget answer with. */
export function researchPackageDiskMessage(needBytes: number, freeBytes: number, options: { atLeast?: boolean } = {}): string {
  const amount = options.atLeast ? `至少需要约 ${formatBytes(needBytes)}` : `需要约 ${formatBytes(needBytes)}`;
  return `磁盘可用空间不足：这个证据包${amount}，当前只有 ${formatBytes(freeBytes)}。请先释放空间，或改用必要导出。`;
}

/**
 * The refusal for a parse that stopped at the free-disk budget.
 *
 * The parser knows only how much unpacked data it had summed when it stopped, and the
 * caller measures free space before it removes the staged upload; the whole import needs
 * three copies of that unpacked total (upload, snapshot, CAS), so quoting three times a
 * lower bound always exceeds the free figure that triggered the budget — the message
 * cannot contradict itself (#1200 review 5).
 */
export function researchPackageBudgetRefusal(unpackedBytes: number, freeBytes: number): { needBytes: number; message: string } {
  const unpacked = Number.isFinite(unpackedBytes) && unpackedBytes > 0 ? unpackedBytes : 0;
  const needBytes = unpacked * 3;
  return { needBytes, message: researchPackageDiskMessage(needBytes, freeBytes, { atLeast: true }) };
}

function assertCapacity(capacity: PackageCapacity, need: { diskBytes: number; memoryBytes: number }): void {
  if (capacity.freeDiskBytes < need.diskBytes) {
    throw refusal(RESEARCH_PACKAGE_DISK_CODE, researchPackageDiskMessage(need.diskBytes, capacity.freeDiskBytes));
  }
  if (capacity.freeMemoryBytes < need.memoryBytes) {
    throw refusal(RESEARCH_PACKAGE_MEMORY_CODE,
      `可用内存不足：这个证据包需要约 ${formatBytes(need.memoryBytes)}，当前只有 ${formatBytes(capacity.freeMemoryBytes)}。请关闭占用内存的程序后重试。`);
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "未知";
  const mib = bytes / (1024 * 1024);
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;
}

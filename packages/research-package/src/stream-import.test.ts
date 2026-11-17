// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createResearchPackage, importResearchPackage, importResearchPackageStreamed, sha256, RESEARCH_PACKAGE_UNPACK_BUDGET_CODE } from "./index.js";

function fixture() {
  const objects = [Buffer.from("alpha payload\n"), Buffer.from("beta payload\n")];
  const packageBytes = createResearchPackage({
    source: { projectId: "p", title: "streamed" },
    records: { sessions: [{ id: "s1", messages: [] }] },
    objects: objects.map((bytes) => ({ path: sha256(bytes), bytes })),
  }).bytes;
  return { packageBytes, objects };
}

async function* pieces(bytes: Uint8Array, size: number) {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
}

/** Re-compress a package with one extra tar entry the manifest does not list. */
function withExtraEntry(bytes: Uint8Array, name: string, payload: Buffer): Uint8Array {
  const raw = gunzipSync(Buffer.from(bytes));
  const body = raw.subarray(0, raw.length - 1024);
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  writeOctal(header, 100, 8, 0o644); writeOctal(header, 108, 8, 0); writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, payload.length); writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156); header[156] = 0; header.write("ustar\0", 257, "ascii"); header.write("00", 263, "ascii");
  let checksum = 0; for (const byte of header) checksum += byte;
  writeOctal(header, 148, 8, checksum);
  const padding = (512 - (payload.length % 512)) % 512;
  return gzipSync(Buffer.concat([body, header, payload, Buffer.alloc(padding), Buffer.alloc(1024)]), { level: 6 });
}

test("a streamed import unpacks the objects to files and reads the same records as the in-memory import", async () => {
  const directory = await mkdtemp(join(tmpdir(), "streamed-import-"));
  try {
    const { packageBytes, objects } = fixture();
    const memory = importResearchPackage(packageBytes);
    // Seven-byte chunks: every header and every payload crosses a chunk boundary.
    const streamed = await importResearchPackageStreamed(pieces(packageBytes, 7), { objectDirectory: join(directory, "objects") });
    assert.deepEqual(streamed.records, memory.records);
    assert.deepEqual(streamed.manifest.inventory, memory.manifest.inventory);
    assert.equal(streamed.receipt.packageChecksum, memory.receipt.packageChecksum);
    assert.equal(streamed.objects.size, objects.length);
    for (const bytes of objects) {
      const digest = sha256(bytes);
      assert.equal(streamed.objects.has(digest), true);
      assert.deepEqual(Buffer.from(streamed.objects.get(digest)!), bytes);
      assert.deepEqual(await readFile(join(directory, "objects", digest)), bytes);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a streamed import rejects an object whose payload does not match its address", async () => {
  const directory = await mkdtemp(join(tmpdir(), "streamed-import-"));
  try {
    const { packageBytes } = fixture();
    // Re-compress a copy with one payload byte flipped: the gzip is still valid, so
    // only the per-object digest can catch it.
    const raw = gunzipSync(Buffer.from(packageBytes));
    const at = raw.indexOf(Buffer.from("alpha payload"));
    assert.ok(at > 0, "the fixture payload is inside the tar");
    raw[at] = (raw[at] ?? 0) ^ 0x01;
    const tampered = gzipSync(raw, { level: 6 });
    await assert.rejects(
      () => importResearchPackageStreamed(pieces(tampered, 64), { objectDirectory: join(directory, "objects") }),
      /checksum mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a streamed import rejects a file the manifest does not list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "streamed-import-"));
  try {
    const { packageBytes } = fixture();
    const tampered = withExtraEntry(packageBytes, "unlisted.bin", Buffer.from("not in the inventory"));
    await assert.rejects(
      () => importResearchPackageStreamed(pieces(tampered, 64), { objectDirectory: join(directory, "objects") }),
      /not listed in the package inventory/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an import completes when a resident entry is larger than the backpressure watermark", { timeout: 60_000 }, async () => {
  // records.json grows with the session; above the 8 MiB high-water mark the parser must
  // keep draining while the producer is parked, or the import never returns.
  const directory = await mkdtemp(join(tmpdir(), "streamed-import-"));
  try {
    const blob = "x".repeat(12 * 1024 * 1024);
    const packageBytes = createResearchPackage({
      source: { projectId: "p", title: "big records" },
      records: { sessions: [], blob },
    }).bytes;
    const streamed = await importResearchPackageStreamed(pieces(packageBytes, 64 * 1024), { objectDirectory: join(directory, "objects") });
    assert.equal((streamed.records as { blob: string }).blob.length, blob.length);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a streamed import refuses an archive that ends before its entries do", async () => {
  const directory = await mkdtemp(join(tmpdir(), "streamed-import-"));
  try {
    const { packageBytes } = fixture();
    const truncated = packageBytes.subarray(0, Math.floor(packageBytes.length / 2));
    await assert.rejects(
      () => importResearchPackageStreamed(pieces(truncated, 64), { objectDirectory: join(directory, "objects") }),
      /ends before|archive|gzip|unexpected/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a streamed import stops at the measured budget and reports it as a disk refusal", async () => {
  // The budget comes from free disk, so running into it must not look like an internal
  // failure: the API maps this code to 507 with the disk message (#1200 review 4).
  const directory = await mkdtemp(join(tmpdir(), "streamed-import-"));
  try {
    const { packageBytes } = fixture();
    await assert.rejects(
      () => importResearchPackageStreamed(pieces(packageBytes, 64), { objectDirectory: join(directory, "objects"), maxBytes: 1024 }),
      (error: Error & { code?: string; unpackedBytes?: number }) => {
        assert.equal(error.code, RESEARCH_PACKAGE_UNPACK_BUDGET_CODE);
        // What the package needed, not the budget it broke: the message quotes this.
        assert.ok((error.unpackedBytes ?? 0) > 1024, "the unpacked total that broke the budget");
        assert.equal(error.message, "Research package exceeds the free disk budget");
        return true;
      });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an import completes when the archive carries zeros past its terminator", { timeout: 60_000 }, async () => {
  // The parser stops at the terminator while the decompressor still has data: without
  // draining it the producer parks at the high-water mark and the import never returns
  // (#1211 F6).
  const directory = await mkdtemp(join(tmpdir(), "streamed-import-"));
  try {
    const { packageBytes } = fixture();
    const raw = gunzipSync(Buffer.from(packageBytes));
    const withTail = gzipSync(Buffer.concat([raw, Buffer.alloc(20 * 1024 * 1024)]), { level: 6 });
    const streamed = await importResearchPackageStreamed(pieces(withTail, 1024 * 1024), { objectDirectory: join(directory, "objects") });
    assert.equal(streamed.objects.size, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an import refuses non-zero data after the terminator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "streamed-import-"));
  try {
    const { packageBytes } = fixture();
    const raw = gunzipSync(Buffer.from(packageBytes));
    const withTail = gzipSync(Buffer.concat([raw, Buffer.from("not part of the package")]), { level: 6 });
    await assert.rejects(
      () => importResearchPackageStreamed(pieces(withTail, 64), { objectDirectory: join(directory, "objects") }),
      /data after its end/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a write error rejects the import instead of terminating the process", async () => {
  // The object writer had no 'error' listener: EEXIST/EFBIG was an unhandled event that
  // killed the API process before the import could reject (#1211 F3).
  const directory = await mkdtemp(join(tmpdir(), "streamed-import-"));
  try {
    const { packageBytes, objects } = fixture();
    const objectDirectory = join(directory, "objects");
    await mkdir(objectDirectory, { recursive: true });
    await writeFile(join(objectDirectory, sha256(objects[0]!)), "already here");
    await assert.rejects(
      () => importResearchPackageStreamed(pieces(packageBytes, 64), { objectDirectory }),
      /EEXIST|exist/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

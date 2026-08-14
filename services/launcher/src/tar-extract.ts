// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Minimal streaming tar reader for the embedded payload.
 *
 * The launcher ships as a Node single-executable application, so it cannot
 * load npm dependencies at runtime; extraction is implemented against the tar
 * formats our packaging script emits (GNU, including `L`/`K` long-name records
 * and pax `x` headers). Only directories, regular files, symlinks and hard
 * links appear in the payload — anything else is a packaging bug and is
 * rejected loudly.
 */
import { link, mkdir, open, symlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

const BLOCK_BYTES = 512;
/** Cap on a single write; keeps peak memory flat for the large runtime files. */
const COPY_CHUNK_BYTES = 4 * 1024 * 1024;

interface TarHeader {
  linkName: string;
  mode: number;
  name: string;
  size: number;
  typeFlag: string;
}

function parseString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

function parseOctal(block: Buffer, offset: number, length: number): number {
  const text = parseString(block, offset, length).trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Malformed tar numeric field: ${JSON.stringify(text)}`);
  }
  return value;
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function parseHeader(block: Buffer): TarHeader {
  const prefix = parseString(block, 345, 155);
  const name = parseString(block, 0, 100);
  return {
    linkName: parseString(block, 157, 100),
    mode: parseOctal(block, 100, 8),
    name: prefix ? `${prefix}/${name}` : name,
    size: parseOctal(block, 124, 12),
    typeFlag: parseString(block, 156, 1) || "0",
  };
}

/**
 * Reject entries that would escape the destination. The payload is built by
 * our own script, but an extractor that trusts archive paths is the classic
 * path-traversal foot-gun and the check costs nothing.
 */
export function safePayloadPath(destination: string, entryName: string): string {
  const root = resolve(destination);
  const normalized = entryName.replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Refusing to extract unsafe payload path: ${entryName}`);
  }
  const target = resolve(root, normalized);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Refusing to extract payload path outside the destination: ${entryName}`);
  }
  return target;
}

/** Pulls exact byte counts off an async chunk source, buffering across chunks. */
class BlockReader {
  private buffered: Buffer = Buffer.alloc(0);

  constructor(private readonly source: AsyncIterator<Buffer>) {}

  /**
   * Returns undefined only at a block-aligned end of stream. Leftover bytes
   * mean the archive was cut mid-entry, which must not look like a clean end:
   * silently stopping there would leave a payload missing files.
   */
  async read(length: number): Promise<Buffer | undefined> {
    while (this.buffered.length < length) {
      const next = await this.source.next();
      if (next.done) {
        if (this.buffered.length > 0) {
          throw new Error(`Truncated payload: ${this.buffered.length} trailing bytes before a complete block`);
        }
        return undefined;
      }
      this.buffered = this.buffered.length === 0
        ? Buffer.from(next.value)
        : Buffer.concat([this.buffered, next.value]);
    }
    const taken = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return taken;
  }
}

/** Extract a tar stream into `destination`, creating parent directories. */
export async function extractTar(source: Readable, destination: string): Promise<void> {
  const root = resolve(destination);
  await mkdir(root, { recursive: true });
  const reader = new BlockReader(source[Symbol.asyncIterator]() as AsyncIterator<Buffer>);
  const createdDirectories = new Set<string>();
  let pendingLongName: string | undefined;
  let pendingLongLink: string | undefined;
  let consecutiveEmptyBlocks = 0;

  const ensureDirectory = async (path: string, mode?: number): Promise<void> => {
    if (createdDirectories.has(path)) return;
    await mkdir(path, { mode: mode || 0o755, recursive: true });
    createdDirectories.add(path);
  };

  /** Consume the padded body of the current entry, optionally writing it out. */
  const consumeBody = async (size: number, filePath?: string, mode?: number): Promise<Buffer> => {
    const padded = Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
    if (!filePath) {
      if (padded === 0) return Buffer.alloc(0);
      const body = await reader.read(padded);
      if (!body) throw new Error("Truncated payload while reading an archive entry");
      return body.subarray(0, size);
    }
    // A zero-size entry has no body blocks, but a regular file entry must
    // still be created: real archives carry empty marker files, and dropping
    // them breaks content-digest verification. `open` below creates it and
    // the copy loop is simply a no-op.
    const handle = await open(filePath, "w", mode || 0o644);
    try {
      let remainingPadded = padded;
      let remainingContent = size;
      while (remainingPadded > 0) {
        const take = Math.min(remainingPadded, COPY_CHUNK_BYTES);
        const chunk = await reader.read(take);
        if (!chunk) throw new Error(`Truncated payload while reading ${filePath}`);
        const content = chunk.subarray(0, Math.min(remainingContent, chunk.length));
        if (content.length > 0) await handle.write(content);
        remainingContent -= content.length;
        remainingPadded -= take;
      }
    } finally {
      await handle.close();
    }
    return Buffer.alloc(0);
  };

  for (;;) {
    const block = await reader.read(BLOCK_BYTES);
    if (!block) break;
    if (isZeroBlock(block)) {
      // Two consecutive zero blocks terminate a tar archive.
      if (++consecutiveEmptyBlocks >= 2) break;
      continue;
    }
    consecutiveEmptyBlocks = 0;

    const header = parseHeader(block);

    if (header.typeFlag === "L" || header.typeFlag === "K") {
      const value = (await consumeBody(header.size)).toString("utf8").replace(/\0+$/, "");
      if (header.typeFlag === "L") pendingLongName = value;
      else pendingLongLink = value;
      continue;
    }
    if (header.typeFlag === "x" || header.typeFlag === "g") {
      // pax extended header: `<len> key=value\n` records; only path/linkpath matter.
      const records = (await consumeBody(header.size)).toString("utf8");
      for (const match of records.matchAll(/\d+ (path|linkpath)=([^\n]*)\n/g)) {
        if (match[1] === "path") pendingLongName = match[2];
        else pendingLongLink = match[2];
      }
      continue;
    }

    const name = pendingLongName ?? header.name;
    const linkName = pendingLongLink ?? header.linkName;
    pendingLongName = undefined;
    pendingLongLink = undefined;

    if (header.typeFlag === "5") {
      await ensureDirectory(safePayloadPath(root, name), header.mode);
      continue;
    }
    if (header.typeFlag === "2") {
      const target = safePayloadPath(root, name);
      await ensureDirectory(dirname(target));
      // Payload symlinks are relative pnpm store links; they are recreated
      // verbatim and resolved inside the extracted tree at use time.
      await symlink(linkName, target);
      continue;
    }
    if (header.typeFlag === "1") {
      // pnpm hard-links duplicate package files, and tar records the repeats as
      // links to the first copy. The link target is archive-relative, so it is
      // range-checked like any other entry path.
      const target = safePayloadPath(root, name);
      await ensureDirectory(dirname(target));
      await link(safePayloadPath(root, linkName), target);
      continue;
    }
    if (header.typeFlag !== "0" && header.typeFlag !== "\0" && header.typeFlag !== "7") {
      throw new Error(`Unsupported payload entry type ${JSON.stringify(header.typeFlag)} for ${name}`);
    }

    const target = safePayloadPath(root, name);
    await ensureDirectory(dirname(target));
    await consumeBody(header.size, target, header.mode);
  }
}

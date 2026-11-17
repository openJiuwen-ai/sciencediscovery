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
 * A minimal, deterministic ustar writer and reader.
 *
 * The external skill snapshot is a tar.gz because that is what the publishing
 * workflow and the design doc agree on, and the repository has no tar
 * dependency. Every header field a rebuild could vary (mtime, uid, gid, mode,
 * file order) is pinned, so the same inputs produce the same bytes.
 */

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface TarEntry {
  bytes: Uint8Array;
  path: string;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function writeString(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error(`tar field overflow: ${value}`);
  target.set(bytes, offset);
}

function safePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) throw new Error(`unsafe tar path: ${path}`);
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error(`unsafe tar path: ${path}`);
  return path;
}

function splitName(path: string): { name: string; prefix: string } {
  const bytes = encoder.encode(path);
  if (bytes.length <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100) return { name, prefix };
  }
  throw new Error(`tar path too long: ${path}`);
}

function header(entry: TarEntry): Uint8Array {
  const { name, prefix } = splitName(safePath(entry.path));
  const block = new Uint8Array(BLOCK);
  writeString(block, 0, 100, name);
  writeString(block, 100, 8, octal(0o644, 8));
  writeString(block, 108, 8, octal(0, 8));
  writeString(block, 116, 8, octal(0, 8));
  writeString(block, 124, 12, octal(entry.bytes.byteLength, 12));
  writeString(block, 136, 12, octal(0, 12));
  block.fill(0x20, 148, 156);
  writeString(block, 156, 1, "0");
  writeString(block, 257, 6, "ustar\0");
  writeString(block, 263, 2, "00");
  writeString(block, 345, 155, prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

export function packTar(entries: TarEntry[]): Uint8Array {
  const sorted = [...entries].toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const parts: Uint8Array[] = [];
  let size = 0;
  for (const entry of sorted) {
    const head = header(entry);
    const padding = (BLOCK - (entry.bytes.byteLength % BLOCK)) % BLOCK;
    parts.push(head, entry.bytes, new Uint8Array(padding));
    size += BLOCK + entry.bytes.byteLength + padding;
  }
  parts.push(new Uint8Array(BLOCK * 2));
  size += BLOCK * 2;
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && block[end] !== 0) end += 1;
  return decoder.decode(block.subarray(offset, end));
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

export function unpackTar(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + BLOCK <= bytes.byteLength) {
    const block = bytes.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    let sum = 0;
    for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
    const stored = readOctal(block, 148, 8);
    if (stored !== sum) throw new Error(`tar checksum mismatch at offset ${offset}`);
    const name = readString(block, 0, 100);
    const prefix = readString(block, 345, 155);
    const path = safePath(prefix ? `${prefix}/${name}` : name);
    const size = readOctal(block, 124, 12);
    const type = String.fromCharCode(block[156]!);
    offset += BLOCK;
    if (type === "0" || type === "\0") {
      if (offset + size > bytes.byteLength) throw new Error(`tar entry truncated: ${path}`);
      files.set(path, bytes.slice(offset, offset + size));
    }
    offset += size + ((BLOCK - (size % BLOCK)) % BLOCK);
  }
  return files;
}

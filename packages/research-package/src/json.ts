// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createHash } from "node:crypto";

const CHUNK = 32 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

/** JSON stays byte-compatible with ordinary readers, without one aggregate JS string. */
export function* jsonTextChunks(value: unknown, sortedKeys = false): Generator<string> {
  const ancestors = new Set<object>();
  function* string(value: string): Generator<string> {
    yield '"';
    for (let offset = 0; offset < value.length; offset += CHUNK) {
      // Escaping a surrogate pair across chunks preserves the same UTF-16 value.
      yield JSON.stringify(value.slice(offset, offset + CHUNK)).slice(1, -1);
    }
    yield '"';
  }
  const normalize = (item: unknown, key: string): unknown => {
    if (item && typeof item === "object" && "toJSON" in item && typeof item.toJSON === "function") return item.toJSON(key);
    return item;
  };
  const omitted = (item: unknown) => item === undefined || typeof item === "function" || typeof item === "symbol";
  function* visit(item: unknown): Generator<string> {
    if (typeof item === "string") { yield* string(item); return; }
    if (!item || typeof item !== "object") { yield JSON.stringify(item) ?? "null"; return; }
    if (ancestors.has(item)) throw new TypeError("Cannot serialize circular research records");
    ancestors.add(item);
    if (Array.isArray(item)) {
      yield "[";
      for (let index = 0; index < item.length; index++) {
        if (index) yield ",";
        yield* visit(normalize(item[index], String(index)));
      }
      yield "]";
    } else {
      yield "{";
      let first = true;
      const keys = Object.keys(item);
      if (sortedKeys) keys.sort();
      for (const key of keys) {
        const child = normalize((item as Record<string, unknown>)[key], key);
        if (omitted(child)) continue;
        if (!first) yield ",";
        first = false;
        yield* string(key); yield ":"; yield* visit(child);
      }
      yield "}";
    }
    ancestors.delete(item);
  }
  yield* visit(normalize(value, ""));
}

export function jsonBytes(value: unknown): Uint8Array {
  const buffers: Buffer[] = [];
  let parts: string[] = [], length = 0;
  for (const part of jsonTextChunks(value)) {
    parts.push(part); length += part.length;
    if (length >= CHUNK) { buffers.push(Buffer.from(parts.join(""))); parts = []; length = 0; }
  }
  if (parts.length) buffers.push(Buffer.from(parts.join("")));
  return Buffer.concat(buffers);
}

export function jsonByteLength(value: unknown): number {
  let size = 0;
  for (const part of jsonTextChunks(value)) size += Buffer.byteLength(part);
  return size;
}

/** Compare JSON-normalized records without constructing their canonical string. */
export function jsonDigest(value: unknown): string {
  const hash = createHash("sha256");
  for (const part of jsonTextChunks(value, true)) hash.update(part);
  return hash.digest("hex");
}

/** Large records are parsed from bytes; only individual string segments become JS strings. */
export function parseJsonBytes(bytes: Uint8Array): unknown {
  if (bytes.byteLength <= 8 * 1024 * 1024) return JSON.parse(decoder.decode(bytes));
  let offset = 0;
  const invalid = (): never => { throw new SyntaxError(`Invalid research JSON at byte ${offset}`); };
  const whitespace = () => { while ([9, 10, 13, 32].includes(bytes[offset]!)) offset++; };
  const string = (): string => {
    if (bytes[offset++] !== 34) return invalid();
    let start = offset;
    const parts: string[] = [];
    while (offset < bytes.length) {
      const byte = bytes[offset]!;
      if (byte === 34) {
        parts.push(JSON.parse(`"${decoder.decode(bytes.subarray(start, offset))}"`) as string);
        offset++;
        return parts.join("");
      }
      if (byte < 32) return invalid();
      if (byte === 92) {
        offset++;
        if (offset >= bytes.length) return invalid();
        if (bytes[offset] === 117) {
          // The `u` byte plus four hexadecimal digits form one escape. The
          // offset already points at the `u`; advance over exactly those five
          // bytes and do not skip the character following the escape.
          offset += 5;
        } else {
          // A short escape consumes the escaped byte as well.
          offset++;
        }
      } else {
        offset++;
      }
      // ASCII characters and complete escapes cannot split UTF-8 code points.
      if (byte < 128 && offset - start >= CHUNK) {
        parts.push(JSON.parse(`"${decoder.decode(bytes.subarray(start, offset))}"`) as string);
        start = offset;
      }
    }
    return invalid();
  };
  const value = (): unknown => {
    whitespace();
    const token = bytes[offset];
    if (token === 34) return string();
    if (token === 91 || token === 123) {
      offset++; whitespace();
      const array = token === 91, end = array ? 93 : 125;
      const result: unknown[] | Record<string, unknown> = array ? [] : {};
      if (bytes[offset] === end) { offset++; return result; }
      while (offset < bytes.length) {
        if (array) (result as unknown[]).push(value());
        else {
          whitespace(); const key = string(); whitespace();
          if (bytes[offset++] !== 58) return invalid();
          Object.defineProperty(result, key, { value: value(), enumerable: true, configurable: true, writable: true });
        }
        whitespace();
        if (bytes[offset] === end) { offset++; return result; }
        if (bytes[offset++] !== 44) return invalid();
      }
      return invalid();
    }
    const start = offset;
    while (offset < bytes.length && ![9, 10, 13, 32, 44, 93, 125].includes(bytes[offset]!)) offset++;
    if (start === offset || offset - start > 1024) return invalid();
    const scalar = JSON.parse(decoder.decode(bytes.subarray(start, offset))) as unknown;
    if (scalar !== null && typeof scalar !== "boolean" && typeof scalar !== "number") return invalid();
    return scalar;
  };
  const result = value(); whitespace();
  if (offset !== bytes.length) return invalid();
  return result;
}

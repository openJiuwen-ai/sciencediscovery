import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { jsonByteLength, jsonBytes, jsonDigest, parseJsonBytes } from "./json.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"],
});

test("research JSON helpers agree on bytes, digest and JSON normalization", () => {
  const value = { z: 1, a: "科学😀", omitted: undefined, nested: [true, null] };
  const bytes = jsonBytes(value);
  assert.equal(jsonByteLength(value), bytes.byteLength);
  assert.deepEqual(parseJsonBytes(bytes), { z: 1, a: "科学😀", nested: [true, null] });
  assert.equal(jsonDigest(value), jsonDigest({ a: "科学😀", z: 1, nested: [true, null] }));
});

test("large JSON parser handles escaped Unicode and rejects malformed payloads", () => {
  const payload = { text: "prefix\\uD83D\\uDE00" + "x".repeat(8 * 1024 * 1024) };
  const parsed = parseJsonBytes(jsonBytes(payload)) as { text: string };
  assert.equal(parsed.text.length, payload.text.length);
  assert.throws(() => parseJsonBytes(new TextEncoder().encode('{"a":}')), /JSON|Invalid research JSON/);
  assert.throws(() => parseJsonBytes(new TextEncoder().encode('{"a":1} trailing')), /JSON|Invalid research JSON/);
});

test("JSON sizing detects circular records before an export can become non-deterministic", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(() => jsonByteLength(circular), /circular/);
});

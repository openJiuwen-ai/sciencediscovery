import test from "node:test";
import assert from "node:assert/strict";
import { createResearchPackage, createResearchPackageAsync, estimateResearchPackageBytes, importResearchPackage, inspectResearchPackage, jsonBytes, jsonByteLength, jsonDigest, parseJsonBytes, sha256, type ResearchPackageExportProfile } from "./index.js";
import { createPluginScope } from "@sciencediscovery/plugin-sdk";
import { researchPackagePlugin } from "./plugin.js";

test("exports and imports a deterministic evidence package", () => {
  const object = new TextEncoder().encode("print('hello')\n");
  const input = { source: { projectId: "p1", sessionIds: ["s1"], title: "Demo" }, createdAt: "2026-01-01T00:00:00.000Z",
    records: { claims: [{ id: "c1", text: "A result" }], provenance: { runId: "r1" } }, objects: [{ path: `objects/${sha256(object)}`, bytes: object }] };
  const first = createResearchPackage(input); const second = createResearchPackage(input);
  assert.deepEqual(first.bytes, second.bytes);
  const inspection = inspectResearchPackage(first.bytes); assert.equal(inspection.valid, true); assert.equal(inspection.objectCount, 1);
  const imported = importResearchPackage(first.bytes); assert.deepEqual(imported.records, input.records); assert.deepEqual(imported.objects.get(sha256(object)), object);
  assert.equal(imported.manifest.packageKind, "evidence"); assert.equal(imported.receipt.sourcePackageChecksum, first.receipt.packageChecksum);
});

test("asynchronous export yields a valid package with the same receipt contents", async () => {
  const object = new TextEncoder().encode("evidence payload\n");
  const input = { source: { projectId: "p-async", title: "Background export" }, createdAt: "2026-10-27T00:00:00.000Z",
    records: { messages: ["question", "answer"] }, objects: [{ path: `objects/${sha256(object)}`, bytes: object }] };
  const result = await createResearchPackageAsync(input);
  const inspected = inspectResearchPackage(result.bytes);
  assert.equal(inspected.valid, true);
  assert.deepEqual(importResearchPackage(result.bytes).records, input.records);
  assert.equal(result.receipt.packageChecksum, inspected.packageChecksum);
  assert.equal(result.receipt.objectCount, 1);
});

test("rejects tampered package bytes and unsafe objects", () => {
  const object = new TextEncoder().encode("data");
  const result = createResearchPackage({ source: { projectId: "p", title: "x" }, records: {}, objects: [{ path: sha256(object), bytes: object }] });
  const tampered = Uint8Array.from(result.bytes); tampered[tampered.length - 20] = (tampered[tampered.length - 20]! ^ 1);
  assert.throws(() => inspectResearchPackage(tampered), /Invalid|checksum|archive/);
  assert.throws(() => createResearchPackage({ source: { projectId: "p", title: "x" }, records: {}, objects: [{ path: "objects/not-a-hash", bytes: object }] }), /SHA-256/);
});

test("exposes the provider through the trusted plugin host", async () => {
  const scope = await createPluginScope([researchPackagePlugin]);
  assert.equal(scope.manifests[0]?.id, "research-package");
  assert.equal(scope.contributions[0]?.provider.extension, ".sdresearch");
  await scope.dispose();
});

test("export scope round trips through inspection and receipts while legacy packages stay compatible", () => {
  const counts = { sessions: 1, messages: 2, artifacts: 1, artifactVersions: 1, workspaceFiles: 1, executionRuns: 1, runs: 1, runEvents: 0, trajectoryEvents: 1, fileRevisions: 1, memoryNodes: 4, memoryEdges: 3 };
  const exportProfile: ResearchPackageExportProfile = { level: "necessary", included: counts, omitted: { ...counts, sessions: 0, messages: 0 },
    capabilities: { historicalVersions: false, fullTrajectory: false, fullExecutionHistory: false, fullMemoryGraph: false, continuation: true } };
  const input = { source: { projectId: "p", title: "Scope" }, records: {} };
  const result = createResearchPackage({ ...input, exportProfile });
  assert.deepEqual(result.receipt.exportProfile, exportProfile);
  assert.deepEqual(inspectResearchPackage(result.bytes).manifest.exportProfile, exportProfile);
  assert.deepEqual(importResearchPackage(result.bytes).receipt.exportProfile, exportProfile);
  assert.equal(importResearchPackage(createResearchPackage(input).bytes).manifest.exportProfile, undefined);
  assert.throws(() => createResearchPackage({ ...input, exportProfile: { ...exportProfile, included: { ...counts, messages: -1 } } }), /export profile/);
});

test("large complete records round trip without aggregate JSON.stringify or truncating evidence", () => {
  const context = { input: "科研数据\n\"内容\" \u0000 🧪 \ud800".repeat(14_000) };
  const records = { sessions: [{ trajectory: { details: Array.from({ length: 40 }, (_, id) => ({ id, context, final: `tail-${id}` })) } }] };
  // A small deterministic ceiling exercises the same failing boundary without
  // allocating hundreds of MB or depending on V8's machine-specific limit.
  const stringify = JSON.stringify;
  JSON.stringify = ((value: unknown, replacer: never, space: never) => {
    if (value && typeof value === "object") throw new RangeError("Invalid string length");
    return stringify(value, replacer, space);
  }) as typeof JSON.stringify;
  try {
    assert.throws(() => JSON.stringify(records), /Invalid string length/);
    const input = { source: { projectId: "p", title: "Large complete evidence" }, records };
    assert.ok(jsonByteLength(records) > 8 * 1024 * 1024);
    assert.ok(estimateResearchPackageBytes(input) > jsonByteLength(records));
    const exported = createResearchPackage(input);
    assert.deepEqual(importResearchPackage(exported.bytes).records, records);
    assert.equal(inspectResearchPackage(exported.bytes).recordsBytes, jsonByteLength(records));
  } finally { JSON.stringify = stringify; }
});

test("chunked JSON preserves native normalization, escaping, sparse arrays and unordered object keys", () => {
  const value = { missing: undefined, date: new Date("2026-10-26T00:00:00Z"), text: "x".repeat(32767) + "🧪\n\"\\\ud800",
    array: [undefined, NaN, , Infinity], nested: { z: 1, a: true } };
  const normalized = JSON.parse(JSON.stringify(value));
  assert.deepEqual(parseJsonBytes(jsonBytes(value)), normalized);
  assert.equal(jsonDigest(value), jsonDigest({ ...normalized, nested: { a: true, z: 1 } }));
  assert.equal(jsonByteLength(value), jsonBytes(value).byteLength);
  const circular: { self?: unknown } = {}; circular.self = circular;
  assert.throws(() => jsonBytes(circular), /circular/);
});

test("large byte parser treats prototype keys as data and rejects invalid trailing tokens", () => {
  const prefix = `"${"a".repeat(8 * 1024 * 1024)}"`;
  const bytes = Buffer.from(`{"padding":${prefix},"__proto__":{"polluted":true},"escaped":"\\uD83E\\uDDEA"}`);
  const parsed = parseJsonBytes(bytes) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.equal(parsed.escaped, "🧪");
  assert.throws(() => parseJsonBytes(Buffer.concat([bytes, Buffer.from(" false")])), /Invalid/);
  assert.throws(() => parseJsonBytes(Buffer.from(`{"padding":${prefix},}`)), /Invalid/);
});

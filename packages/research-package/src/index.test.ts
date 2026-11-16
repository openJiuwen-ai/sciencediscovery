import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { Writable } from "node:stream";
import { createResearchPackage, createResearchPackageAsync, estimateResearchPackageBytes, importResearchPackage, inspectResearchPackage, jsonBytes, jsonByteLength, jsonDigest, parseJsonBytes, researchPackageArchiveBytes, researchPackageFits, researchPackageUploadBytes, resolveResearchPackageMaxBytes, writeResearchPackage, RESEARCH_PACKAGE_DEFAULT_MAX_BYTES, RESEARCH_PACKAGE_MAX_MAX_BYTES, RESEARCH_PACKAGE_MIN_MAX_BYTES, sha256, type ResearchPackageExportProfile } from "./index.js";
import { createPluginScope } from "@sciencediscovery/plugin-sdk";
import { researchPackagePlugin } from "./plugin.js";

test("memoized JSON sizing preserves repeated immutable values and JSON normalization", () => {
  const shared = { text: '中\\\"\n' + 'x'.repeat(32767) + '😀', omitted: undefined, nested: [NaN, null] };
  const keyed = { toJSON(key: string) { return { key, shared }; } };
  const values = [{ a: shared, b: shared, first: keyed, second: keyed }, [undefined, , Symbol(), () => 1], keyed];
  const sizes = new WeakMap<object, number>();
  for (const value of values) {
    assert.equal(jsonByteLength(value, sizes), jsonByteLength(value));
    assert.equal(jsonByteLength(value, sizes), jsonBytes(value).byteLength);
  }
  const circular: { self?: unknown } = {}; circular.self = circular;
  assert.throws(() => jsonByteLength(circular, sizes), /circular/);
});

test("incremental detail sizes preserve complete package estimates including tar boundaries", () => {
  const shared = { input: "large model input ".repeat(200) };
  const details = [{ context: shared, value: "one" }, { context: shared, value: "two" }];
  const input = { source: { projectId: "p", title: "sizing" }, records: { sessions: [{ details }] } };
  const skeleton = { ...input, records: { sessions: [{ details: [] }] } };
  const sizes = new WeakMap<object, number>();
  const extra = details.reduce((sum, detail, index) => sum + jsonByteLength(detail, sizes) + (index ? 1 : 0), 0);
  assert.equal(estimateResearchPackageBytes(skeleton, undefined, extra), estimateResearchPackageBytes(input));
  assert.throws(() => estimateResearchPackageBytes(skeleton, undefined, -1), /size/i);
});

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

test("rejects exports that the importer would reject for too many entries", () => {
  const objects = Array.from({ length: 9_998 }, (_, index) => {
    const bytes = new TextEncoder().encode(`object-${index}`);
    return { path: sha256(bytes), bytes };
  });
  assert.throws(
    () => createResearchPackage({ source: { projectId: "p", title: "Too many entries" }, records: {}, objects }),
    /entry limit/,
  );
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

test("the archive-size helper matches the tar the exporter really builds, and the cap refuses at +1 byte", () => {
  const object = new TextEncoder().encode("boundary payload\n");
  const input = { source: { projectId: "p-cap", title: "Cap boundary" }, createdAt: "2026-01-01T00:00:00.000Z",
    records: { claims: [{ id: "c1" }] }, objects: [{ path: "objects/" + sha256(object), bytes: object }] };
  const predicted = researchPackageArchiveBytes(input);
  const bytes = createResearchPackage(input).bytes;
  // The claim is exactness, so compare against the real uncompressed tar, not against a second estimate.
  assert.equal(predicted, gunzipSync(bytes).byteLength);
  assert.equal(researchPackageFits(input, predicted), true);
  assert.equal(researchPackageFits(input, predicted - 1), false);
  assert.doesNotThrow(() => createResearchPackage(input, predicted));
  assert.throws(() => createResearchPackage(input, predicted - 1), /exceeds the archive size limit/);
});

test("the upload bound always covers the largest archive a cap can produce", () => {
  // The regression this replaces: a 256 MiB upload literal beneath a 512 MiB exporter.
  // Round-trip both ends of the configured range, and assert the bound sits above the
  // worst case gzip can emit for a tar at the cap.
  for (const cap of [RESEARCH_PACKAGE_MIN_MAX_BYTES, RESEARCH_PACKAGE_DEFAULT_MAX_BYTES, RESEARCH_PACKAGE_MAX_MAX_BYTES]) {
    const upload = researchPackageUploadBytes(cap);
    assert.ok(upload > cap, `upload bound ${upload} must exceed the cap ${cap}`);
    assert.ok(upload >= Math.ceil(cap * 1.05), "1.05x covers gzip's expansion on incompressible data");
  }
  // And the route derives it from the ceiling an acknowledged export may reach, so the
  // two cannot drift apart: the acknowledged maximum is importable by the same build.
  const acknowledged = researchPackageUploadBytes(RESEARCH_PACKAGE_MAX_MAX_BYTES);
  assert.ok(acknowledged > RESEARCH_PACKAGE_MAX_MAX_BYTES);
});

test("the package cap is one resolved value whose environment override fails fast", () => {
  assert.equal(resolveResearchPackageMaxBytes(""), RESEARCH_PACKAGE_DEFAULT_MAX_BYTES);
  assert.equal(resolveResearchPackageMaxBytes(""), RESEARCH_PACKAGE_DEFAULT_MAX_BYTES);
  // A bad value fails at startup instead of running at a cap nobody chose.
  assert.throws(() => resolveResearchPackageMaxBytes("not-a-number"), /positive integer/);
  assert.throws(() => resolveResearchPackageMaxBytes("5g"), /positive integer/);
  assert.throws(() => resolveResearchPackageMaxBytes("1"), /between/);
  assert.equal(resolveResearchPackageMaxBytes(String(RESEARCH_PACKAGE_MIN_MAX_BYTES)), RESEARCH_PACKAGE_MIN_MAX_BYTES);
  // Above the ceiling the value is rejected rather than quietly lowered: the ceiling
  // follows this pipeline's ~3x-payload cost, and a silent clamp would run at a cap
  // the operator never chose.
  assert.throws(() => resolveResearchPackageMaxBytes(String(9 * 1024 * 1024 * 1024)), /between/);
  assert.throws(() => resolveResearchPackageMaxBytes(String(999 * 1024 * 1024 * 1024)), /between/);
  assert.equal(resolveResearchPackageMaxBytes(String(RESEARCH_PACKAGE_MAX_MAX_BYTES)), RESEARCH_PACKAGE_MAX_MAX_BYTES);
});

test("the streaming writer emits the same archive and reads each source twice, never buffering it", async () => {
  const payload = new TextEncoder().encode("streamed evidence row\n".repeat(4096));
  const digest = sha256(payload);
  const createdAt = "2026-01-01T00:00:00.000Z";
  const base = { source: { projectId: "p-stream", title: "Streaming" }, createdAt, records: { claims: [{ id: "c1" }] } };
  const inMemory = createResearchPackage({ ...base, objects: [{ path: "objects/" + digest, bytes: payload }] }).bytes;

  let opens = 0;
  const streamed = {
    ...base,
    objects: [{
      path: "objects/" + digest,
      sizeBytes: payload.byteLength,
      open: () => {
        opens += 1;
        // Two chunks, so the writer has to reassemble a payload it never holds whole.
        return (async function* () { yield payload.subarray(0, 17); yield payload.subarray(17); })();
      },
    }],
  };
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  const receipt = await writeResearchPackage(streamed, sink);
  const written = Buffer.concat(chunks);

  assert.deepEqual(written, Buffer.from(inMemory));
  assert.equal(receipt.packageChecksum, sha256(written));
  assert.equal(opens, 2, "hashed in one pass, written in the next");
  // The manifest still carries the real checksum and size of a source it only streamed.
  const inspected = inspectResearchPackage(new Uint8Array(written));
  assert.deepEqual(inspected.files.find((entry) => entry.kind === "object"),
    { path: "objects/" + digest, sizeBytes: payload.byteLength, checksum: digest, kind: "object" });
});

test("the streaming writer refuses an over-cap package before writing anything", async () => {
  const payload = new TextEncoder().encode("x".repeat(2048));
  const digest = sha256(payload);
  const input = { source: { projectId: "p", title: "cap" }, createdAt: "2026-01-01T00:00:00.000Z", records: {},
    objects: [{ path: "objects/" + digest, bytes: payload }] };
  const size = researchPackageArchiveBytes(input);
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  await assert.rejects(() => writeResearchPackage(input, sink, size - 1), /exceeds the archive size limit/);
  assert.equal(chunks.length, 0, "nothing reached the sink");
  await assert.doesNotReject(() => writeResearchPackage(input, sink, size));
});

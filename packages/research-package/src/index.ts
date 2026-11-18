// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip, gunzipSync, gzip, gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { jsonBytes, jsonByteLength, parseJsonBytes } from "./json.js";
export { jsonBytes, jsonByteLength, jsonDigest, parseJsonBytes } from "./json.js";

export const RESEARCH_PACKAGE_FORMAT = "sciencediscovery-research-package" as const;
export const RESEARCH_PACKAGE_EXTENSION = ".sdresearch" as const;
export const RESEARCH_PACKAGE_SCHEMA_VERSION = 1 as const;
const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const TAR_BLOCK = 512;
/** The largest size an 11-digit octal tar field can hold: 8 GiB - 1. */
const TAR_MAX_ENTRY_BYTES = 8 * 1024 * MIB - 1;
/** Bound for the entries that are read whole during a streamed import. */
const MAX_METADATA_BYTES = 64 * MIB;

/**
 * One cap for every side of a research package: the uncompressed tar on export,
 * the inflated tar on import, and (derived from it) the compressed upload.
 *
 * It is deliberately not a literal at each call site any more. Two independent
 * literals (512 MiB export, 256 MiB upload) let the app produce a package its own
 * importer refuses, which is the round-trip defect this replaces.
 */
export const RESEARCH_PACKAGE_DEFAULT_MAX_BYTES = 5 * 1024 * MIB;
/**
 * Ceiling for every override, environment or per-request.
 *
 * The streaming exporter holds one object plus its chunks, not the payload, so the cap
 * no longer has to describe resident memory: what bounds it is the tar header's own
 * size field, which `writeOctal` fills with eleven octal digits. `8 GiB - 1` is the
 * largest value that field can hold, and a package cannot exceed the sum of its
 * entries, so keeping the cap under it keeps every header representable.
 */
export const RESEARCH_PACKAGE_MAX_MAX_BYTES = 8 * 1024 * MIB - 1;
export const RESEARCH_PACKAGE_MIN_MAX_BYTES = 64 * MIB;
export const RESEARCH_PACKAGE_MAX_BYTES_ENV = "SCIENCE_AGENT_RESEARCH_PACKAGE_MAX_BYTES";

/**
 * The largest upload a cap can produce.
 *
 * gzip can make an incompressible package a little larger than its tar, so the bound is
 * the cap plus 5% and a megabyte of slack — derived here, next to the cap, so a future
 * edit cannot leave the upload bound below what the exporter can emit. Callers pass the
 * ceiling an acknowledged export may reach, not the configured default.
 */
export function researchPackageUploadBytes(maxBytes: number): number {
  return Math.ceil(maxBytes * 1.05) + 1024 * 1024;
}

/** Stable code: the API answers it with 507 and the disk message, not a 500. */
export const RESEARCH_PACKAGE_UNPACK_BUDGET_CODE = "RESEARCH_PACKAGE_INSUFFICIENT_DISK";

/** The one message both sides use when a package is over the cap. */
export const RESEARCH_PACKAGE_TOO_LARGE_MESSAGE = "Research package exceeds the archive size limit";
/** Stable code: the API answers 413 with it and both clients localize it. */
export const RESEARCH_PACKAGE_TOO_LARGE_CODE = "RESEARCH_PACKAGE_TOO_LARGE";

/** The refusal carries a code so it is classified as client input, never as a 500. */
export function researchPackageTooLargeError(): Error {
  const error = new Error(RESEARCH_PACKAGE_TOO_LARGE_MESSAGE) as Error & { code?: string };
  error.code = RESEARCH_PACKAGE_TOO_LARGE_CODE;
  return error;
}

/**
 * Resolve the cap from the environment.
 *
 * A value the operator set but that cannot be honoured throws, following
 * `SCIENCE_AGENT_API_MAX_OLD_SPACE_MB`: a silent fallback would run at a cap nobody
 * chose, and the only symptom would be exports refused at a number the dialog prints
 * as "the limit".
 */
export function resolveResearchPackageMaxBytes(raw?: string): number {
  const value = raw ?? process.env[RESEARCH_PACKAGE_MAX_BYTES_ENV];
  if (value === undefined || value.trim() === "") return RESEARCH_PACKAGE_DEFAULT_MAX_BYTES;
  const requested = Number(value.trim());
  // A wrong unit or a typo must not be replaced by a number the operator did not
  // choose: the only symptom would be exports refused at a cap nobody set. This
  // follows `apiMaxOldSpaceMb`, which throws for the same reason.
  if (!Number.isInteger(requested) || requested <= 0)
    throw new Error(`${RESEARCH_PACKAGE_MAX_BYTES_ENV} must be a positive integer number of bytes, got ${JSON.stringify(value)}`);
  if (requested < RESEARCH_PACKAGE_MIN_MAX_BYTES || requested > RESEARCH_PACKAGE_MAX_MAX_BYTES)
    throw new Error(`${RESEARCH_PACKAGE_MAX_BYTES_ENV} must be between ${RESEARCH_PACKAGE_MIN_MAX_BYTES} and ${RESEARCH_PACKAGE_MAX_MAX_BYTES} bytes, got ${requested}`);
  return requested;
}

/** The cap in force for this process: one value exported to every consumer. */
export const RESEARCH_PACKAGE_MAX_BYTES = resolveResearchPackageMaxBytes();

export type ResearchPackageKind = "evidence" | "verified-reproduction" | "combined";
export type PackageObjectKind = "artifact" | "evidence" | "log" | "other";
export interface PackageObject { path: string; bytes: Uint8Array; kind?: PackageObjectKind; }
/**
 * An object that is streamed from its source instead of being resident.
 *
 * `open` must be callable more than once: the exporter hashes every object first
 * (the tar manifest carries each checksum and size) and then reads it again while
 * writing the archive. A file source satisfies that naturally; a one-shot stream
 * does not, which is why the type asks for a factory rather than an iterable.
 */
export interface PackageObjectStream { path: string; sizeBytes?: number; open: () => AsyncIterable<Uint8Array>; }

/** Bytes an object contributes to a size estimate: resident bytes, else the caller's hint. */
function objectSize(object: PackageObject | PackageObjectStream): number {
  if ("bytes" in object && object.bytes) return object.bytes.byteLength;
  return "sizeBytes" in object ? object.sizeBytes ?? 0 : 0;
}
export interface PackageSource { projectId: string; sessionIds?: readonly string[]; title: string; }
export interface PackageInventoryEntry {
  path: string; sizeBytes: number; checksum: string; kind: "manifest" | "records" | "object" | "readme";
}
export interface ResearchPackageCounts {
  sessions: number; messages: number; artifacts: number; artifactVersions: number; workspaceFiles: number;
  executionRuns: number; runs: number; runEvents: number; trajectoryEvents: number; fileRevisions: number;
  memoryNodes: number; memoryEdges: number;
}
export interface ResearchPackageExportProfile {
  level: "necessary" | "complete";
  included: ResearchPackageCounts;
  omitted: ResearchPackageCounts;
  capabilities: { historicalVersions: boolean; fullTrajectory: boolean; fullExecutionHistory: boolean; fullMemoryGraph: boolean; continuation: boolean };
}
export interface PackageManifest {
  format: typeof RESEARCH_PACKAGE_FORMAT; schemaVersion: 1; packageKind: ResearchPackageKind;
  createdAt: string; producer: { product: "ScienceDiscovery"; version: string; plugin: string; pluginVersion: string };
  source: PackageSource; inventory: PackageInventoryEntry[]; omissions: string[];
  exportProfile?: ResearchPackageExportProfile;
}
export interface ExportInput {
  packageKind?: ResearchPackageKind; producerVersion?: string; source: PackageSource;
  records: unknown; objects?: readonly (PackageObject | PackageObjectStream)[]; omissions?: readonly string[]; readme?: string;
  createdAt?: string;
  exportProfile?: ResearchPackageExportProfile;
}
export interface ExportReceipt {
  packageChecksum: string; packageKind: ResearchPackageKind; objectCount: number; totalBytes: number;
  omissions: string[]; createdAt: string;
  exportProfile?: ResearchPackageExportProfile;
}
export interface ImportReceipt {
  packageChecksum: string; sourcePackageChecksum: string; importedObjectCount: number;
  importedRecordBytes: number; omissions: string[]; createdAt: string;
  exportProfile?: ResearchPackageExportProfile;
}
export interface ImportedResearchPackage {
  manifest: PackageManifest; records: unknown; objects: ReadonlyMap<string, Uint8Array>;
  readme: Uint8Array;
  receipt: ImportReceipt;
}
export interface PackageInspection {
  manifest: PackageManifest; packageChecksum: string; files: readonly PackageInventoryEntry[];
  recordsBytes: number; objectCount: number; totalBytes: number; valid: true;
}
export interface ResearchPackageProvider {
  readonly format: typeof RESEARCH_PACKAGE_FORMAT;
  readonly extension: typeof RESEARCH_PACKAGE_EXTENSION;
  export(input: ExportInput): { bytes: Uint8Array; receipt: ExportReceipt };
  inspect(bytes: Uint8Array): PackageInspection;
  importReadOnly(bytes: Uint8Array): ImportedResearchPackage;
}

type TarEntry = { path: string; bytes: Uint8Array };
const text = (value: string) => new TextEncoder().encode(value);
const DEFAULT_README = "# ScienceDiscovery Research Package\n\nThis package contains immutable research evidence. Package bytes are not executed during import.\n";
/** One tar block plus the payload, rounded up: the size `prepareResearchPackage` charges. */
const paddedSize = (size: number) => TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
const archiveTotalBytes = (entrySizes: readonly number[]) =>
  entrySizes.reduce((total, size) => total + paddedSize(size), TAR_BLOCK * 2);
const HASH_PLACEHOLDER = "0".repeat(64);
const json = jsonBytes;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const isHash = (value: string) => /^[a-f0-9]{64}$/.test(value);

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0") + "\0";
  buffer.write(encoded.slice(-length), offset, length, "ascii");
}

function tarHeader(path: string, size: number): Uint8Array {
  if (Buffer.byteLength(path) > 100) throw new Error(`Package path is too long: ${path}`);
  // Eleven octal digits plus a terminator: 8 GiB - 1 is the largest size this header
  // can express. The cap keeps a whole package under it, so reaching this means a
  // single entry outgrew the archive bound rather than a tar limitation to work around.
  if (!Number.isSafeInteger(size) || size < 0 || size > TAR_MAX_ENTRY_BYTES)
    throw new Error(`Package entry is too large for a tar header: ${path}`);
  const header = Buffer.alloc(TAR_BLOCK);
  header.write(path, 0, "utf8");
  writeOctal(header, 100, 8, 0o644); writeOctal(header, 108, 8, 0); writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size); writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156); header[156] = 0; header.write("ustar\0", 257, "ascii"); header.write("00", 263, "ascii");
  let checksum = 0; for (const byte of header) checksum += byte;
  writeOctal(header, 148, 8, checksum);
  return header;
}

function createArchive(entries: readonly TarEntry[]): Uint8Array {
  const raw = archiveBytes(entries);
  return gzipSync(raw, { level: 6 });
}

function archiveBytes(entries: readonly TarEntry[]): Buffer {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry.path, entry.bytes.byteLength), entry.bytes);
    const padding = (TAR_BLOCK - (entry.bytes.byteLength % TAR_BLOCK)) % TAR_BLOCK;
    if (padding) parts.push(new Uint8Array(padding));
  }
  parts.push(new Uint8Array(TAR_BLOCK * 2));
  return Buffer.concat(parts);
}

function createArchiveAsync(entries: readonly TarEntry[]): Promise<Uint8Array> {
  const raw = archiveBytes(entries);
  return new Promise((resolve, reject) => {
    gzip(raw, { level: 6 }, (error, bytes) => error ? reject(error) : resolve(bytes));
  });
}

function readOctal(buffer: Uint8Array, offset: number, length: number): number {
  const value = new TextDecoder().decode(buffer.slice(offset, offset + length)).replace(/\0.*$/, "").trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function readArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  let raw: Uint8Array;
  // Import accepts the hard ceiling, not the default cap: an export acknowledged over
  // the cap must still be importable by the same build, or the 512/256 mismatch simply
  // returns under a new name.
  try { raw = gunzipSync(bytes, { maxOutputLength: RESEARCH_PACKAGE_MAX_MAX_BYTES }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw researchPackageTooLargeError();
    }
    throw new Error("Invalid .sdresearch gzip archive");
  }
  if (raw.byteLength > RESEARCH_PACKAGE_MAX_MAX_BYTES) throw researchPackageTooLargeError();
  const files = new Map<string, Uint8Array>(); let offset = 0; let total = 0;
  while (offset + TAR_BLOCK <= raw.byteLength) {
    const header = raw.slice(offset, offset + TAR_BLOCK); offset += TAR_BLOCK;
    if (header.every((byte) => byte === 0)) break;
    const path = new TextDecoder().decode(header.slice(0, 100)).replace(/\0.*$/, "");
    const size = readOctal(header, 124, 12); const type = header[156];
    if (!path || path.startsWith("/") || path.split("/").includes("..")) throw new Error("Unsafe research package path");
    if (type !== 0 && type !== 0x30) throw new Error("Research package contains a non-regular file");
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES || offset + size > raw.byteLength) throw new Error("Invalid research package entry size");
    if (files.has(path)) throw new Error(`Duplicate research package entry: ${path}`);
    // Keep views into the decompressed archive instead of copying every large
    // object. The archive buffer remains alive through the returned map.
    files.set(path, new Uint8Array(raw.buffer, raw.byteOffset + offset, size)); total += size;
    if (total > RESEARCH_PACKAGE_MAX_MAX_BYTES || files.size > MAX_ENTRIES) throw new Error("Research package exceeds its limits");
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  if (!files.has("manifest.json") || !files.has("records.json")) throw new Error("Research package is missing its manifest or records");
  return files;
}

function parseManifest(bytes: Uint8Array): PackageManifest {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("Invalid research package manifest JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid research package manifest");
  const manifest = value as Partial<PackageManifest>;
  if (manifest.format !== RESEARCH_PACKAGE_FORMAT || manifest.schemaVersion !== 1 || !manifest.source || !manifest.producer || !Array.isArray(manifest.inventory) || !Array.isArray(manifest.omissions)) throw new Error("Unsupported research package manifest");
  if (typeof manifest.createdAt !== "string" || !manifest.source || typeof manifest.source.projectId !== "string" || typeof manifest.source.title !== "string") throw new Error("Invalid research package source");
  if (manifest.producer.product !== "ScienceDiscovery" || typeof manifest.producer.version !== "string" || typeof manifest.producer.plugin !== "string" || typeof manifest.producer.pluginVersion !== "string") throw new Error("Invalid research package producer");
  if (!["evidence", "verified-reproduction", "combined"].includes(manifest.packageKind ?? "")) throw new Error("Invalid research package kind");
  if (manifest.exportProfile !== undefined) validateExportProfile(manifest.exportProfile);
  const inventoryPaths = new Set<string>();
  for (const entry of manifest.inventory) {
    if (!entry || typeof entry.path !== "string" || entry.path === "manifest.json" || entry.path.startsWith("/") || entry.path.split("/").includes("..") || inventoryPaths.has(entry.path) || !isHash(entry.checksum) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !["records", "object", "readme"].includes(entry.kind)) throw new Error("Invalid research package inventory entry");
    inventoryPaths.add(entry.path);
    if (entry.kind === "records" && entry.path !== "records.json") throw new Error("Invalid research package records entry");
    if (entry.kind === "readme" && entry.path !== "README.md") throw new Error("Invalid research package README entry");
    if (entry.kind === "object" && (!entry.path.startsWith("objects/") || !isHash(entry.path.slice("objects/".length)) || entry.path.slice("objects/".length) !== entry.checksum)) throw new Error("Invalid research package object entry");
  }
  if (!manifest.inventory.some((entry) => entry.path === "records.json" && entry.kind === "records") || !manifest.inventory.some((entry) => entry.path === "README.md" && entry.kind === "readme")) throw new Error("Research package inventory is incomplete");
  return manifest as PackageManifest;
}

function validateExportProfile(profile: ResearchPackageExportProfile): void {
  const countKeys: Array<keyof ResearchPackageCounts> = ["sessions", "messages", "artifacts", "artifactVersions", "workspaceFiles", "executionRuns", "runs", "runEvents", "trajectoryEvents", "fileRevisions", "memoryNodes", "memoryEdges"];
  const capabilityKeys: Array<keyof ResearchPackageExportProfile["capabilities"]> = ["historicalVersions", "fullTrajectory", "fullExecutionHistory", "fullMemoryGraph", "continuation"];
  if (!profile || !["necessary", "complete"].includes(profile.level)
    || [profile.included, profile.omitted].some((counts) => !counts || countKeys.some((key) => !Number.isSafeInteger(counts[key]) || counts[key] < 0))
    || !profile.capabilities || capabilityKeys.some((key) => typeof profile.capabilities[key] !== "boolean")) {
    throw new Error("Invalid research package export profile");
  }
}

function validateFiles(files: Map<string, Uint8Array>, manifest: PackageManifest): void {
  const inventory = new Map(manifest.inventory.map((entry) => [entry.path, entry]));
  for (const path of files.keys()) if (!inventory.has(path) && path !== "manifest.json") throw new Error(`File is not listed in the package inventory: ${path}`);
  for (const entry of manifest.inventory) {
    const bytes = files.get(entry.path); if (!bytes) throw new Error(`Package inventory entry is missing: ${entry.path}`);
    if (bytes.byteLength !== entry.sizeBytes || sha256(bytes) !== entry.checksum) throw new Error(`Package checksum mismatch: ${entry.path}`);
  }
}

type PreparedResearchPackage = { entries: TarEntry[]; packageKind: ResearchPackageKind; totalBytes: number; omissions: string[]; createdAt: string; exportProfile?: ResearchPackageExportProfile };

function prepareResearchPackage(input: ExportInput, maxBytes: number = RESEARCH_PACKAGE_MAX_BYTES): PreparedResearchPackage {
  if (input.exportProfile !== undefined) validateExportProfile(input.exportProfile);
  const objects = [...(input.objects ?? [])]; const objectEntries: TarEntry[] = []; const inventory: PackageInventoryEntry[] = [];
  const seen = new Set<string>(); let totalBytes = 0;
  for (const object of objects) {
    // This path builds the archive in memory, so an object without bytes cannot be
    // written here: a streaming source is only usable by `writeResearchPackage`.
    if (!("bytes" in object) || !object.bytes) throw new Error("A synchronous export cannot stream package objects");
    const checksum = sha256(object.bytes); const path = `objects/${checksum}`;
    if (object.path !== path && object.path !== checksum) throw new Error("Package object path must be its SHA-256 address");
    if (seen.has(path)) {
      throw new Error(`Duplicate package object: ${path}`);
    }
    seen.add(path);
    if (object.bytes.byteLength > MAX_FILE_BYTES) throw new Error("Package object exceeds the size limit");
    totalBytes += object.bytes.byteLength; objectEntries.push({ path, bytes: object.bytes });
    inventory.push({ path, sizeBytes: object.bytes.byteLength, checksum, kind: "object" });
  }
  const records = json(input.records); const recordsChecksum = sha256(records);
  inventory.unshift({ path: "records.json", sizeBytes: records.byteLength, checksum: recordsChecksum, kind: "records" }); totalBytes += records.byteLength;
  const packageKind = input.packageKind ?? "evidence"; const createdAt = input.createdAt ?? new Date().toISOString();
  const manifest: PackageManifest = { format: RESEARCH_PACKAGE_FORMAT, schemaVersion: 1, packageKind, createdAt,
    producer: { product: "ScienceDiscovery", version: input.producerVersion ?? "unknown", plugin: "research-package", pluginVersion: "0.1.0" },
    source: structuredClone(input.source), inventory, omissions: [...(input.omissions ?? [])], ...(input.exportProfile ? { exportProfile: structuredClone(input.exportProfile) } : {}) };
  const readme = text(input.readme ?? DEFAULT_README);
  manifest.inventory.push({ path: "README.md", sizeBytes: readme.byteLength, checksum: sha256(readme), kind: "readme" });
  const entries: TarEntry[] = [{ path: "manifest.json", bytes: json(manifest) }, { path: "records.json", bytes: records }, { path: "README.md", bytes: readme }, ...objectEntries];
  if (entries.length > MAX_ENTRIES) throw new Error("Research package exceeds the entry limit");
  const archiveBytes = archiveTotalBytes(entries.map((entry) => entry.bytes.byteLength));
  if (archiveBytes > maxBytes) throw researchPackageTooLargeError();
  return { entries, packageKind, totalBytes, omissions: [...manifest.omissions], createdAt,
    ...(manifest.exportProfile ? { exportProfile: manifest.exportProfile } : {}) };
}

/**
 * The uncompressed tar size a package would occupy, without hashing or compressing.
 *
 * Hashes and object paths have a fixed width, so a manifest built from placeholder
 * checksums is exactly as long as the real one. This is the quantity
 * `prepareResearchPackage` refuses on — not `estimateResearchPackageBytes`, which
 * pads the manifest approximately and can differ by a few percent either way.
 */
export function researchPackageArchiveBytes(input: ExportInput, objectSizes?: ReadonlyMap<string, number>,
  additionalRecordBytes = 0, unpinnedObjectBytes: readonly number[] = []): number {
  const objects = [...(input.objects ?? [])];
  const recordsBytes = jsonByteLength(input.records) + additionalRecordBytes;
  const readmeBytes = Buffer.byteLength(input.readme ?? DEFAULT_README);
  const inventory: PackageInventoryEntry[] = [{ path: "records.json", sizeBytes: recordsBytes, checksum: HASH_PLACEHOLDER, kind: "records" }];
  const sizes: number[] = [recordsBytes, readmeBytes];
  for (const object of objects) {
    const size = objectSizes?.get(object.path) ?? objectSize(object);
    inventory.push({ path: `objects/${HASH_PLACEHOLDER}`, sizeBytes: size, checksum: HASH_PLACEHOLDER, kind: "object" });
    sizes.push(size);
  }
  // Objects whose address the caller cannot name yet still occupy one inventory entry
  // and one payload each; the manifest keeps a fixed-width path for them, so leaving
  // them out of the count would under-report the archive the writer produces.
  for (const size of unpinnedObjectBytes) {
    inventory.push({ path: `objects/${HASH_PLACEHOLDER}`, sizeBytes: size, checksum: HASH_PLACEHOLDER, kind: "object" });
    sizes.push(size);
  }
  inventory.push({ path: "README.md", sizeBytes: readmeBytes, checksum: HASH_PLACEHOLDER, kind: "readme" });
  const manifest = {
    format: RESEARCH_PACKAGE_FORMAT, schemaVersion: RESEARCH_PACKAGE_SCHEMA_VERSION,
    packageKind: input.packageKind ?? "evidence", createdAt: input.createdAt ?? new Date().toISOString(),
    producer: { product: "ScienceDiscovery", version: input.producerVersion ?? "unknown", plugin: "research-package", pluginVersion: "0.1.0" },
    source: input.source, inventory, omissions: [...(input.omissions ?? [])],
    ...(input.exportProfile ? { exportProfile: input.exportProfile } : {}),
  };
  return archiveTotalBytes([jsonByteLength(manifest), ...sizes]);
}

/** Whether a package built from this input stays within maxBytes (default: the shared cap). */
export function researchPackageFits(input: ExportInput, maxBytes: number = RESEARCH_PACKAGE_MAX_BYTES,
  objectSizes?: ReadonlyMap<string, number>, additionalRecordBytes = 0): boolean {
  return researchPackageArchiveBytes(input, objectSizes, additionalRecordBytes) <= maxBytes;
}

/** Counts and hashes the compressed bytes while they flow to the sink. */
class ArchiveDigest extends Transform {
  private readonly hash = createHash("sha256");
  private compressedBytes = 0;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null, data?: Buffer) => void): void {
    this.compressedBytes += chunk.length;
    this.hash.update(chunk);
    done(null, chunk);
  }
  digest(): { packageChecksum: string; compressedBytes: number } {
    return { packageChecksum: this.hash.digest("hex"), compressedBytes: this.compressedBytes };
  }
}

type StreamEntry = { path: string; size: number; open: () => AsyncIterable<Uint8Array> };

/**
 * The tar stream for a set of entries: one header, the payload, then its padding.
 *
 * `open()` is called here and nowhere else, so a file-backed object is read exactly
 * once while writing — the earlier pass only hashed it.
 */
async function* tarChunks(entries: readonly StreamEntry[]): AsyncIterable<Uint8Array> {
  for (const entry of entries) {
    yield tarHeader(entry.path, entry.size);
    let written = 0;
    for await (const chunk of entry.open()) {
      written += chunk.byteLength;
      if (written > entry.size) throw new Error(`Package entry grew while writing: ${entry.path}`);
      yield chunk;
    }
    if (written !== entry.size) throw new Error(`Package entry shrank while writing: ${entry.path}`);
    const padding = (TAR_BLOCK - (entry.size % TAR_BLOCK)) % TAR_BLOCK;
    if (padding) yield new Uint8Array(padding);
  }
  yield new Uint8Array(TAR_BLOCK * 2);
}

/**
 * Write a package directly to `destination`: tar → gzip → sink.
 *
 * The in-memory exporter builds the whole tar and then the whole gzip output, so peak
 * RSS is payload + tar + archive. This path holds neither buffer: objects are hashed in
 * one streaming pass (the manifest needs their checksums and sizes) and then read again
 * while the archive is written, and the compressed bytes are hashed as they pass
 * through. The receipt is unchanged, including `packageChecksum`, because it is the
 * SHA-256 of exactly the bytes that reached the sink.
 */
export async function writeResearchPackage(
  input: Omit<ExportInput, "objects"> & { objects?: readonly (PackageObject | PackageObjectStream)[] },
  destination: Writable,
  maxBytes: number = RESEARCH_PACKAGE_MAX_BYTES,
): Promise<ExportReceipt> {
  if (input.exportProfile !== undefined) validateExportProfile(input.exportProfile);
  const inventory: PackageInventoryEntry[] = [];
  const objectEntries: StreamEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const object of input.objects ?? []) {
    let checksum: string;
    let size: number;
    let open: () => AsyncIterable<Uint8Array>;
    if ("bytes" in object) {
      checksum = sha256(object.bytes);
      size = object.bytes.byteLength;
      const bytes = object.bytes;
      open = async function* () { yield bytes; };
    } else {
      const hash = createHash("sha256");
      let hashed = 0;
      for await (const chunk of object.open()) { hash.update(chunk); hashed += chunk.byteLength; }
      checksum = hash.digest("hex");
      size = hashed;
      // The hint is optional and never trusted: the hash pass is the size that goes
      // into the manifest, so a caller that only knows the address still works.
      if (object.sizeBytes !== undefined && object.sizeBytes !== hashed) throw new Error("Package object size changed while hashing");
      open = object.open;
    }
    const path = `objects/${checksum}`;
    if (object.path !== path && object.path !== checksum) throw new Error("Package object path must be its SHA-256 address");
    if (seen.has(path)) throw new Error(`Duplicate package object: ${path}`);
    seen.add(path);
    if (size > MAX_FILE_BYTES) throw new Error("Package object exceeds the size limit");
    totalBytes += size;
    inventory.push({ path, sizeBytes: size, checksum, kind: "object" });
    objectEntries.push({ path, size, open });
  }

  const records = json(input.records);
  const recordsChecksum = sha256(records);
  inventory.unshift({ path: "records.json", sizeBytes: records.byteLength, checksum: recordsChecksum, kind: "records" });
  totalBytes += records.byteLength;
  const packageKind = input.packageKind ?? "evidence";
  const createdAt = input.createdAt ?? new Date().toISOString();
  const manifest: PackageManifest = { format: RESEARCH_PACKAGE_FORMAT, schemaVersion: 1, packageKind, createdAt,
    producer: { product: "ScienceDiscovery", version: input.producerVersion ?? "unknown", plugin: "research-package", pluginVersion: "0.1.0" },
    source: structuredClone(input.source), inventory, omissions: [...(input.omissions ?? [])],
    ...(input.exportProfile ? { exportProfile: structuredClone(input.exportProfile) } : {}) };
  const readme = text(input.readme ?? DEFAULT_README);
  manifest.inventory.push({ path: "README.md", sizeBytes: readme.byteLength, checksum: sha256(readme), kind: "readme" });

  const manifestBytes = json(manifest);
  const entries: StreamEntry[] = [
    { path: "manifest.json", size: manifestBytes.byteLength, open: async function* () { yield manifestBytes; } },
    { path: "records.json", size: records.byteLength, open: async function* () { yield records; } },
    { path: "README.md", size: readme.byteLength, open: async function* () { yield readme; } },
    ...objectEntries,
  ];
  if (entries.length > MAX_ENTRIES) throw new Error("Research package exceeds the entry limit");
  const archiveBytes = archiveTotalBytes(entries.map((entry) => entry.size));
  if (archiveBytes > maxBytes) throw researchPackageTooLargeError();

  const digest = new ArchiveDigest();
  await pipeline(Readable.from(tarChunks(entries)), createGzip({ level: 6 }), digest, destination);
  const { packageChecksum } = digest.digest();
  return { packageChecksum, packageKind, objectCount: objectEntries.length, totalBytes,
    omissions: [...manifest.omissions], createdAt,
    ...(manifest.exportProfile ? { exportProfile: manifest.exportProfile } : {}) };
}

/** Read an object's bytes from a file, for callers that already know its address and size. */
export function fileObjectStream(path: string, sizeBytes: number, digest: string): PackageObjectStream {
  return {
    path: `objects/${digest}`,
    sizeBytes,
    open: () => createReadStream(path) as unknown as AsyncIterable<Uint8Array>,
  };
}

/** Size of a file as a package object would charge it. */
export async function fileObjectSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

export { createReadStream, open };

function packageReceipt(bytes: Uint8Array, prepared: PreparedResearchPackage): ExportReceipt {
  return { packageChecksum: sha256(bytes), packageKind: prepared.packageKind,
    objectCount: prepared.entries.length - 3, totalBytes: prepared.totalBytes,
    omissions: [...prepared.omissions], createdAt: prepared.createdAt,
    ...(prepared.exportProfile ? { exportProfile: prepared.exportProfile } : {}) };
}

export function createResearchPackage(input: ExportInput, maxBytes: number = RESEARCH_PACKAGE_MAX_BYTES): { bytes: Uint8Array; receipt: ExportReceipt } {
  const prepared = prepareResearchPackage(input, maxBytes);
  const bytes = createArchive(prepared.entries);
  return { bytes, receipt: packageReceipt(bytes, prepared) };
}

/** Build packages with asynchronous compression so long exports do not block API requests. */
export async function createResearchPackageAsync(input: ExportInput, maxBytes: number = RESEARCH_PACKAGE_MAX_BYTES): Promise<{ bytes: Uint8Array; receipt: ExportReceipt }> {
  const prepared = prepareResearchPackage(input, maxBytes);
  const bytes = await createArchiveAsync(prepared.entries);
  return { bytes, receipt: packageReceipt(bytes, prepared) };
}

export function inspectResearchPackage(bytes: Uint8Array): PackageInspection {
  const files = readArchive(bytes); const manifest = parseManifest(files.get("manifest.json")!); validateFiles(files, manifest);
  const records = files.get("records.json")!; return { manifest, packageChecksum: sha256(bytes), files: manifest.inventory, recordsBytes: records.byteLength,
    objectCount: manifest.inventory.filter((entry) => entry.kind === "object").length, totalBytes: [...files.values()].reduce((sum, item) => sum + item.byteLength, 0), valid: true };
}

export function importResearchPackage(bytes: Uint8Array): ImportedResearchPackage {
  const files = readArchive(bytes); const manifest = parseManifest(files.get("manifest.json")!); validateFiles(files, manifest);
  let records: unknown; try { records = parseJsonBytes(files.get("records.json")!); } catch { throw new Error("Invalid research package records JSON"); }
  const objects = new Map<string, Uint8Array>(); for (const entry of manifest.inventory.filter((item) => item.kind === "object")) objects.set(entry.path.slice("objects/".length), files.get(entry.path)!);
  const packageChecksum = sha256(bytes); return { manifest, records, objects, readme: files.get("README.md")!, receipt: { packageChecksum, sourcePackageChecksum: packageChecksum,
    importedObjectCount: objects.size, importedRecordBytes: files.get("records.json")!.byteLength, omissions: [...manifest.omissions], createdAt: new Date().toISOString(), ...(manifest.exportProfile ? { exportProfile: manifest.exportProfile } : {}) } };
}

export function createResearchPackageProvider(): ResearchPackageProvider {
  return { format: RESEARCH_PACKAGE_FORMAT, extension: RESEARCH_PACKAGE_EXTENSION, export: createResearchPackage, inspect: inspectResearchPackage, importReadOnly: importResearchPackage };
}

/**
 * A package's objects unpacked to a directory: it behaves like the in-memory map, but
 * `get` reads one object at a time, so an import never holds all of them.
 */
export interface PackageObjectDirectory extends ReadonlyMap<string, Uint8Array> {}

export interface StreamedImportedPackage {
  manifest: PackageManifest; records: unknown; readme: Uint8Array;
  objects: PackageObjectDirectory; receipt: ImportReceipt;
}

/** Buffered chunks with the reads a tar parser needs, including a streaming copy. */
class ChunkQueue {
  private chunks: Buffer[] = [];
  private queued = 0;
  private ended = false;
  private failure?: Error;
  private wake: Array<() => void> = [];
  private spaceWaiters: Array<() => void> = [];
  /** Above this the producer waits, so a fast decompressor cannot outrun the parser. */
  private readonly highWater = 8 * 1024 * 1024;
  private readonly lowWater = 4 * 1024 * 1024;

  push(chunk: Buffer): void { this.chunks.push(chunk); this.queued += chunk.length; this.signal(); }
  fail(error: Error): void { this.failure = error; this.ended = true; this.signal(); }
  end(): void { this.ended = true; this.signal(); }
  private signal(): void { const waiting = this.wake; this.wake = []; for (const resume of waiting) resume(); }
  private stalled(): Promise<void> { return new Promise<void>((resume) => this.wake.push(resume)); }

  /** Backpressure for the decompressor: resolves once the parser has caught up. */
  async offer(chunk: Buffer): Promise<void> {
    this.push(chunk);
    if (this.queued <= this.highWater) return;
    await new Promise<void>((resume) => this.spaceWaiters.push(resume));
  }

  private released(): void {
    if (this.queued > this.lowWater || !this.spaceWaiters.length) return;
    const waiting = this.spaceWaiters;
    this.spaceWaiters = [];
    for (const resume of waiting) resume();
  }

  async read(size: number): Promise<Buffer> {
    // Drain incrementally: waiting for `size` bytes before consuming any of them would
    // deadlock an entry larger than the high-water mark, because the producer that owes
    // the rest is parked by `offer` until this loop calls `released()` (#1200 review 2).
    const out = Buffer.allocUnsafe(size); let offset = 0;
    while (offset < size) {
      while (this.queued === 0 && !this.ended) await this.stalled();
      if (this.failure) throw this.failure;
      if (this.queued === 0) throw new Error("Invalid .sdresearch archive: it ends before its entries do");
      const head = this.chunks[0]!;
      const take = Math.min(head.length, size - offset);
      head.copy(out, offset, 0, take); offset += take;
      if (take === head.length) this.chunks.shift(); else this.chunks[0] = head.subarray(take);
      this.queued -= take;
      this.released();
    }
    return out;
  }

  /** Yield the rest of the stream, waking the producer as it goes. */
  async *drain(): AsyncGenerator<Buffer> {
    for (;;) {
      if (this.failure) throw this.failure;
      if (this.queued === 0) {
        if (this.ended) return;
        await this.stalled();
        continue;
      }
      const head = this.chunks.shift()!;
      this.queued -= head.length;
      this.released();
      yield head;
    }
  }

  /** Consume exactly `size` bytes in whatever pieces have arrived. */
  async stream(size: number, write: (chunk: Buffer) => Promise<void> | void): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      while (this.queued === 0 && !this.ended) await this.stalled();
      if (this.failure) throw this.failure;
      if (this.queued === 0) throw new Error("Invalid .sdresearch archive: it ends before its entries do");
      const head = this.chunks[0]!;
      const take = Math.min(head.length, remaining);
      const piece = head.subarray(0, take);
      if (take === head.length) this.chunks.shift(); else this.chunks[0] = head.subarray(take);
      this.queued -= take; remaining -= take;
      await write(piece);
      this.released();
    }
  }
}

class DirectoryObjects implements PackageObjectDirectory {
  constructor(private readonly directory: string, private readonly paths: readonly string[]) {}
  get size(): number { return this.paths.length; }
  has(path: string): boolean { return this.paths.includes(path); }
  get(path: string): Uint8Array { return readFileSync(join(this.directory, path)); }
  private *generate(): Generator<[string, Uint8Array]> { for (const path of this.paths) yield [path, this.get(path)]; }
  private *generateValues(): Generator<Uint8Array> { for (const path of this.paths) yield this.get(path); }
  values(): MapIterator<Uint8Array> { return this.generateValues() as unknown as MapIterator<Uint8Array>; }
  keys(): MapIterator<string> { return this.paths.values() as unknown as MapIterator<string>; }
  entries(): MapIterator<[string, Uint8Array]> { return this.generate() as unknown as MapIterator<[string, Uint8Array]>; }
  [Symbol.iterator](): MapIterator<[string, Uint8Array]> { return this.entries(); }
  forEach(callback: (value: Uint8Array, key: string, map: ReadonlyMap<string, Uint8Array>) => void, thisArg?: unknown): void {
    for (const [path, bytes] of this.generate()) callback.call(thisArg, bytes, path, this);
  }
}

/**
 * Import a package straight from its compressed bytes.
 *
 * The archive is decompressed as it arrives and each object is written to
 * `objectDirectory/<checksum>` while being hashed, so neither the compressed package
 * nor the inflated tar is ever resident — only the manifest, records and readme are.
 * Stage 2 of #1152 exists for packages whose payload cannot fit in memory.
 */
export async function importResearchPackageStreamed(
  source: AsyncIterable<Uint8Array>,
  options: { objectDirectory: string; maxBytes?: number; signal?: AbortSignal },
): Promise<StreamedImportedPackage> {
  const maxBytes = options.maxBytes ?? RESEARCH_PACKAGE_MAX_MAX_BYTES;
  await mkdir(options.objectDirectory, { recursive: true });
  const queue = new ChunkQueue();
  const compressed = createHash("sha256");
  const meter = new Transform({ transform(chunk: Buffer, _encoding, done) { compressed.update(chunk); done(null, chunk); } });
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) { queue.offer(chunk).then(() => done(), (error: Error) => done(error)); },
    final(done) { queue.end(); done(); },
  });
  const conveying = pipeline(Readable.from(source), meter, createGunzip(), sink);
  conveying.catch((error: Error) => queue.fail(error));
  try {
    const files = new Map<string, Uint8Array>();
    const objectPaths: string[] = [];
    const objectSizes = new Map<string, number>();
    let total = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      const header = await queue.read(TAR_BLOCK);
      if (header.every((byte) => byte === 0)) break;
      const path = new TextDecoder().decode(header.slice(0, 100)).replace(/\0.*$/, "");
      const size = readOctal(header, 124, 12); const type = header[156];
      if (!path || path.startsWith("/") || path.split("/").includes("..")) throw new Error("Unsafe research package path");
      if (type !== 0 && type !== 0x30) throw new Error("Research package contains a non-regular file");
      if (!Number.isSafeInteger(size) || size < 0 || size > TAR_MAX_ENTRY_BYTES) throw new Error("Invalid research package entry size");
      if (files.has(path) || objectPaths.some((digest) => `objects/${digest}` === path)) throw new Error(`Duplicate research package entry: ${path}`);
      total += size;
      // A bound tighter than the absolute ceiling can only be a caller's measured budget
      // (free disk), so it gets its own code: the API answers that with a disk refusal
      // instead of a 500, while an overrun of the ceiling stays a client-input error.
      if (total > maxBytes && maxBytes < RESEARCH_PACKAGE_MAX_MAX_BYTES) {
        // Carry what the package has needed so far, not the budget it broke: the budget is
        // free disk / 3, and quoting it back would tell the user they have more room than
        // the package needs (#1200 review 5). Parsing stopped early, so it is a lower bound.
        const error = new Error("Research package exceeds the free disk budget") as Error & { code?: string; unpackedBytes?: number };
        error.code = RESEARCH_PACKAGE_UNPACK_BUDGET_CODE;
        error.unpackedBytes = total;
        throw error;
      }
      if (total > maxBytes || files.size + objectPaths.length >= MAX_ENTRIES) throw new Error("Research package exceeds its limits");
      if (path.startsWith("objects/")) {
        const digest = path.slice("objects/".length);
        if (!isHash(digest)) throw new Error("Invalid research package object entry");
        const digesting = createHash("sha256");
        const file = createWriteStream(resolve(options.objectDirectory, digest), { flags: "wx" });
        // An open/flush error has no other listener: without this the 'error' event is
        // unhandled and terminates the process instead of failing the import (#1211 F3).
        const failed = new Promise<never>((_, reject) => file.on("error", reject));
        let written = 0;
        try {
          await Promise.race([
            queue.stream(size, async (chunk) => {
              digesting.update(chunk); written += chunk.length;
              if (!file.write(chunk)) await once(file, "drain");
            }),
            failed,
          ]);
          await new Promise<void>((done, failWrite) => { file.end((error?: Error | null) => error ? failWrite(error) : done()); });
        } catch (error) {
          file.destroy();
          throw error;
        }
        if (written !== size || digesting.digest("hex") !== digest) throw new Error(`Package checksum mismatch: ${path}`);
        objectPaths.push(digest); objectSizes.set(digest, size);
      } else {
        // Manifest, records and readme are read whole, so they get their own small bound
        // instead of the package cap: one 5 GiB "metadata" entry must not be attempted.
        if (size > MAX_METADATA_BYTES) throw new Error("Research package metadata entry is too large");
        files.set(path, Buffer.from(await queue.read(size)));
      }
      const padding = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
      if (padding) await queue.read(padding);
    }
    // The parser stopped at the terminator; the decompressor is still producing. Keep
    // draining (that wakes the parked sink) so the pipeline can finish, and treat any
    // non-zero byte after the end as data the archive declared it did not carry (#1211 F6).
    for await (const chunk of queue.drain()) {
      if (chunk.some((byte) => byte !== 0)) throw new Error("Research package carries data after its end");
    }
    await conveying;

    const manifestBytes = files.get("manifest.json"), recordsBytes = files.get("records.json"), readme = files.get("README.md");
    if (!manifestBytes || !recordsBytes || !readme) throw new Error("Research package is missing its manifest or records");
    const manifest = parseManifest(manifestBytes);
    for (const entry of manifest.inventory) {
      if (entry.kind === "object") {
        const digest = entry.path.slice("objects/".length);
        if (!objectSizes.has(digest)) throw new Error(`Package inventory entry is missing: ${entry.path}`);
        if (objectSizes.get(digest) !== entry.sizeBytes) throw new Error(`Package checksum mismatch: ${entry.path}`);
        continue;
      }
      const bytes = files.get(entry.path);
      if (!bytes || bytes.byteLength !== entry.sizeBytes || sha256(bytes) !== entry.checksum) throw new Error(`Package checksum mismatch: ${entry.path}`);
    }
    // Reject in both directions, like the in-memory import: an object or a metadata file
    // the manifest does not list is a package the two paths would otherwise disagree on.
    const expectedObjects = new Set(manifest.inventory.filter((entry) => entry.kind === "object").map((entry) => entry.path.slice("objects/".length)));
    for (const digest of objectPaths) if (!expectedObjects.has(digest)) throw new Error(`File is not listed in the package inventory: objects/${digest}`);
    const expectedFiles = new Set(manifest.inventory.filter((entry) => entry.kind !== "object").map((entry) => entry.path));
    for (const path of files.keys()) {
      if (path === "manifest.json") continue;
      if (!expectedFiles.has(path)) throw new Error(`File is not listed in the package inventory: ${path}`);
    }
    let records: unknown; try { records = parseJsonBytes(recordsBytes); } catch { throw new Error("Invalid research package records JSON"); }
    const packageChecksum = compressed.digest("hex");
    return { manifest, records, readme, objects: new DirectoryObjects(options.objectDirectory, objectPaths),
      receipt: { packageChecksum, sourcePackageChecksum: packageChecksum, importedObjectCount: objectPaths.length,
        importedRecordBytes: recordsBytes.byteLength, omissions: [...manifest.omissions],
        createdAt: new Date().toISOString(), ...(manifest.exportProfile ? { exportProfile: manifest.exportProfile } : {}) } };
  } catch (error) {
    sink.destroy();
    await conveying.catch(() => undefined);
    queue.fail(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

export { canonical, sha256 };

/**
 * Uncompressed estimate: never compress an archive solely to display a size.
 *
 * `unpinnedObjectBytes` covers objects the writer will add whose address a caller
 * cannot name without reading them — a preview of a workspace file the exporter
 * hashes while it copies. They are counted exactly like an object entry, because
 * that is what they become, rather than being folded into the record bytes.
 */
export function estimateResearchPackageBytes(input: ExportInput, objectSizes?: ReadonlyMap<string, number>,
  additionalRecordBytes = 0, unpinnedObjectBytes: readonly number[] = []): number {
  if (!Number.isSafeInteger(additionalRecordBytes) || additionalRecordBytes < 0) throw new Error("Invalid additional record size");
  const padded = (size: number) => TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  const recordBytes = jsonByteLength(input.records) + additionalRecordBytes;
  const readmeBytes = Buffer.byteLength(input.readme ?? "# ScienceDiscovery Research Package\n\nThis package contains immutable research evidence. Package bytes are not executed during import.\n");
  const objectCount = (input.objects?.length ?? 0) + unpinnedObjectBytes.length;
  // Inventory and manifest metadata are small compared with evidence payloads.
  const manifestEstimate = jsonByteLength({ source: input.source, omissions: input.omissions, exportProfile: input.exportProfile })
    + 1024 + objectCount * 256;
  return padded(recordBytes) + padded(readmeBytes) + padded(manifestEstimate)
    + (input.objects ?? []).reduce((sum, object) => sum + padded(objectSizes?.get(object.path) ?? objectSize(object)), 0)
    + unpinnedObjectBytes.reduce((sum, size) => sum + padded(size), 0) + TAR_BLOCK * 2;
}

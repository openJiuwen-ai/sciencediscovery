// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export const RESEARCH_PACKAGE_FORMAT = "sciencediscovery-research-package" as const;
export const RESEARCH_PACKAGE_EXTENSION = ".sdresearch" as const;
export const RESEARCH_PACKAGE_SCHEMA_VERSION = 1 as const;
const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024 * 1024;
const TAR_BLOCK = 512;

export type ResearchPackageKind = "evidence" | "verified-reproduction" | "combined";
export type PackageObjectKind = "artifact" | "evidence" | "log" | "other";
export interface PackageObject { path: string; bytes: Uint8Array; kind?: PackageObjectKind; }
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
  records: unknown; objects?: readonly PackageObject[]; omissions?: readonly string[]; readme?: string;
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
const json = (value: unknown) => text(JSON.stringify(value, (_key, item) => item, 2) + "\n");
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
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry.path, entry.bytes.byteLength), entry.bytes);
    const padding = (TAR_BLOCK - (entry.bytes.byteLength % TAR_BLOCK)) % TAR_BLOCK;
    if (padding) parts.push(new Uint8Array(padding));
  }
  parts.push(new Uint8Array(TAR_BLOCK * 2));
  const raw = Buffer.concat(parts.map((part) => Buffer.from(part)));
  return gzipSync(raw, { level: 6 });
}

function readOctal(buffer: Uint8Array, offset: number, length: number): number {
  const value = new TextDecoder().decode(buffer.slice(offset, offset + length)).replace(/\0.*$/, "").trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function readArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  let raw: Uint8Array;
  try { raw = gunzipSync(bytes); } catch { throw new Error("Invalid .sdresearch gzip archive"); }
  if (raw.byteLength > MAX_TOTAL_BYTES) throw new Error("Research package exceeds the archive size limit");
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
    files.set(path, Uint8Array.from(raw.slice(offset, offset + size))); total += size;
    if (total > MAX_TOTAL_BYTES || files.size > MAX_ENTRIES) throw new Error("Research package exceeds its limits");
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

export function createResearchPackage(input: ExportInput): { bytes: Uint8Array; receipt: ExportReceipt } {
  if (input.exportProfile !== undefined) validateExportProfile(input.exportProfile);
  const objects = [...(input.objects ?? [])]; const objectEntries: TarEntry[] = []; const inventory: PackageInventoryEntry[] = [];
  const seen = new Set<string>(); let totalBytes = 0;
  for (const object of objects) {
    const checksum = sha256(object.bytes); const path = `objects/${checksum}`;
    if (object.path !== path && object.path !== checksum) throw new Error("Package object path must be its SHA-256 address");
    if (seen.has(path)) throw new Error(`Duplicate package object: ${path}`); seen.add(path);
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
  const readme = text(input.readme ?? "# ScienceDiscovery Research Package\n\nThis package contains immutable research evidence. Package bytes are not executed during import.\n");
  manifest.inventory.push({ path: "README.md", sizeBytes: readme.byteLength, checksum: sha256(readme), kind: "readme" });
  const entries: TarEntry[] = [{ path: "manifest.json", bytes: json(manifest) }, { path: "records.json", bytes: records }, { path: "README.md", bytes: readme }, ...objectEntries];
  const packageBytes = createArchive(entries); const packageChecksum = sha256(packageBytes);
  return { bytes: packageBytes, receipt: { packageChecksum, packageKind, objectCount: objectEntries.length, totalBytes, omissions: [...manifest.omissions], createdAt, ...(manifest.exportProfile ? { exportProfile: manifest.exportProfile } : {}) } };
}

export function inspectResearchPackage(bytes: Uint8Array): PackageInspection {
  const files = readArchive(bytes); const manifest = parseManifest(files.get("manifest.json")!); validateFiles(files, manifest);
  const records = files.get("records.json")!; return { manifest, packageChecksum: sha256(bytes), files: manifest.inventory, recordsBytes: records.byteLength,
    objectCount: manifest.inventory.filter((entry) => entry.kind === "object").length, totalBytes: [...files.values()].reduce((sum, item) => sum + item.byteLength, 0), valid: true };
}

export function importResearchPackage(bytes: Uint8Array): ImportedResearchPackage {
  const files = readArchive(bytes); const manifest = parseManifest(files.get("manifest.json")!); validateFiles(files, manifest);
  let records: unknown; try { records = JSON.parse(new TextDecoder().decode(files.get("records.json")!)); } catch { throw new Error("Invalid research package records JSON"); }
  const objects = new Map<string, Uint8Array>(); for (const entry of manifest.inventory.filter((item) => item.kind === "object")) objects.set(entry.path.slice("objects/".length), files.get(entry.path)!);
  const packageChecksum = sha256(bytes); return { manifest, records, objects, readme: files.get("README.md")!, receipt: { packageChecksum, sourcePackageChecksum: packageChecksum,
    importedObjectCount: objects.size, importedRecordBytes: files.get("records.json")!.byteLength, omissions: [...manifest.omissions], createdAt: new Date().toISOString(), ...(manifest.exportProfile ? { exportProfile: manifest.exportProfile } : {}) } };
}

export function createResearchPackageProvider(): ResearchPackageProvider {
  return { format: RESEARCH_PACKAGE_FORMAT, extension: RESEARCH_PACKAGE_EXTENSION, export: createResearchPackage, inspect: inspectResearchPackage, importReadOnly: importResearchPackage };
}

export { canonical, sha256 };

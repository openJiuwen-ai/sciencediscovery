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
 * The session-package contract between the producers and the hub.
 *
 * The site build only reads the published `sessions/index.json`; the package
 * itself is unpacked during a manual publish (`sessions-index.ts`). Nothing in
 * a package is ever executed, and `records.json` is hashed but never parsed.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import {
  RESEARCH_PACKAGE_FORMAT,
  RESEARCH_PACKAGE_SCHEMA_VERSION,
} from "../../packages/research-package/src/index.js";

import type { PackageInventoryEntry, PackageManifest } from "../../packages/research-package/src/index.js";
import type {
  RelatedAsset,
  SessionAsset,
  SessionBenchmark,
  SessionCategory,
  SessionContents,
  SessionRun,
} from "./types.js";

export const SESSIONS_INDEX = "index.json";

/** Measured real exports are 28 and 36 MiB; 50 MiB leaves room without hiding a runaway package. */
export const MAX_SESSION_PACKAGE_BYTES = 50 * 1024 * 1024;

export interface SessionSidecar {
  benchmark: SessionBenchmark;
  category: SessionCategory;
  description: string;
  name: string;
  readme?: string;
  related?: RelatedAsset;
  run: SessionRun | null;
}

/** One published package, persisted in `sessions/index.json` and read by every build. */
export interface SessionIndexEntry {
  benchmark: SessionBenchmark;
  category: SessionCategory;
  contents: SessionContents;
  createdAt: string;
  description: string;
  download: { sha256: string; size: number; url: string };
  id: string;
  name: string;
  packageKind: string;
  producer: PackageManifest["producer"];
  publishedAt: string;
  readme: string;
  related?: RelatedAsset;
  run: SessionRun | null;
}

export interface SessionIndex {
  schemaVersion: 1;
  sessions: SessionIndexEntry[];
  updatedAt: string | null;
}

export interface SessionPackageSummary {
  manifest: PackageManifest;
  readme: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function field(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`field "${name}" must be a non-empty string`);
  return value.trim();
}

function optionalField(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`field "${name}" must be a string`);
  return value.trim() || undefined;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`field "${name}" must be a number`);
  return value;
}

function optionalCount(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`field "${name}" must be a non-negative integer`);
  }
  return value;
}

function optionalIds(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`field "${name}" must be an array of asset ids`);
  }
  const ids = [...new Set((value as string[]).map((item) => item.trim()))];
  return ids.length ? ids : undefined;
}

/** Validates the sidecar; every message names the field so a producer knows what to fix. */
export function validateSidecar(value: unknown): SessionSidecar {
  if (!isRecord(value)) throw new Error("the sidecar must be a JSON object");
  if (!isRecord(value.benchmark)) throw new Error(`field "benchmark" must be an object`);
  const commit = optionalField(value.benchmark.commit, "benchmark.commit");
  const dataset = optionalField(value.benchmark.dataset, "benchmark.dataset");
  const rubric = optionalField(value.benchmark.rubric, "benchmark.rubric");
  const runAt = optionalField(value.benchmark.runAt, "benchmark.runAt");
  const score = optionalNumber(value.benchmark.score, "benchmark.score");
  const benchmark: SessionBenchmark = {
    caseId: field(value.benchmark.caseId, "benchmark.caseId"),
    name: field(value.benchmark.name, "benchmark.name"),
    ...(commit ? { commit } : {}),
    ...(dataset ? { dataset } : {}),
    ...(rubric ? { rubric } : {}),
    ...(runAt ? { runAt } : {}),
    ...(score !== undefined ? { score } : {}),
  };
  let category: SessionCategory = { source: "manual" };
  if (value.category !== undefined) {
    if (!isRecord(value.category)) throw new Error(`field "category" must be an object`);
    const task = optionalField(value.category.task, "category.task");
    const domain = optionalField(value.category.domain, "category.domain");
    category = {
      ...(task ? { task } : {}),
      ...(domain ? { domain } : {}),
      source: optionalField(value.category.source, "category.source") ?? "manual",
    };
  }
  let run: SessionRun | null = null;
  if (value.run !== undefined) {
    if (!isRecord(value.run)) throw new Error(`field "run" must be an object`);
    const durationMs = optionalCount(value.run.durationMs, "run.durationMs");
    const model = optionalField(value.run.model, "run.model");
    const productVersion = optionalField(value.run.productVersion, "run.productVersion");
    const tokens = optionalCount(value.run.tokens, "run.tokens");
    run = {
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(model ? { model } : {}),
      ...(productVersion ? { productVersion } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
    };
    if (!Object.keys(run).length) run = null;
  }
  let related: RelatedAsset | undefined;
  if (value.related !== undefined) {
    if (!isRecord(value.related)) throw new Error(`field "related" must be an object`);
    const parsed: RelatedAsset = {
      connectors: optionalIds(value.related.connectors, "related.connectors"),
      skills: optionalIds(value.related.skills, "related.skills"),
      specialists: optionalIds(value.related.specialists, "related.specialists"),
    };
    related = Object.values(parsed).some((item) => item !== undefined) ? parsed : undefined;
  }
  const readme = optionalField(value.readme, "readme");
  return {
    benchmark,
    category,
    description: field(value.description, "description"),
    name: field(value.name, "name"),
    ...(readme ? { readme } : {}),
    ...(related ? { related } : {}),
    run,
  };
}

/** Counts come from the package, never from the sidecar. */
export function contentsOf(manifest: PackageManifest): SessionContents {
  const profile = manifest.exportProfile;
  if (!profile) {
    throw new Error("manifest.exportProfile is missing, so the content counts cannot be shown");
  }
  const included = profile.included;
  if (!included || typeof included !== "object" || !profile.capabilities || typeof profile.capabilities !== "object") {
    throw new Error("manifest.exportProfile is incomplete");
  }
  const counts = [included.messages, included.artifacts, included.workspaceFiles, included.executionRuns, included.memoryNodes];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("manifest.exportProfile.included has an invalid count");
  }
  return {
    artifacts: included.artifacts,
    executions: included.executionRuns,
    files: included.workspaceFiles,
    memoryNodes: included.memoryNodes,
    messages: included.messages,
    trajectory: profile.capabilities.fullTrajectory ? "complete" : "summary",
  };
}

interface ScannedEntry {
  sha256: string;
  size: number;
}

/** Pulls bytes out of the inflated gzip stream without holding the archive in memory. */
class ByteStream {
  private buffered = 0;
  private chunks: Uint8Array[] = [];
  private ended = false;

  constructor(private readonly iterator: AsyncIterator<Uint8Array>) {}

  private async pull(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    if (next.value.byteLength) {
      this.chunks.push(next.value);
      this.buffered += next.value.byteLength;
    }
    return true;
  }

  private take(length: number): Uint8Array {
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = this.chunks[0]!;
      const size = Math.min(chunk.byteLength, length - offset);
      out.set(chunk.subarray(0, size), offset);
      offset += size;
      this.buffered -= size;
      if (size === chunk.byteLength) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(size);
    }
    return out;
  }

  async read(length: number): Promise<Uint8Array | null> {
    while (this.buffered < length && await this.pull()) { /* fill until the request is satisfied */ }
    return this.buffered < length ? null : this.take(length);
  }

  /** Discards `length` bytes, optionally hashing them on the way. */
  async drain(length: number, hash?: ReturnType<typeof createHash>): Promise<void> {
    let left = length;
    while (left > 0) {
      if (!this.buffered && !(await this.pull())) throw new Error("the archive ends inside an entry");
      const chunk = this.chunks[0]!;
      const size = Math.min(chunk.byteLength, left);
      hash?.update(chunk.subarray(0, size));
      left -= size;
      this.buffered -= size;
      if (size === chunk.byteLength) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(size);
    }
  }

  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}

function tarText(header: Uint8Array, offset: number, length: number): string {
  return new TextDecoder().decode(header.subarray(offset, offset + length)).replace(/\0[\s\S]*$/u, "").trim();
}

function tarNumber(header: Uint8Array, offset: number, length: number): number {
  const raw = tarText(header, offset, length);
  return raw ? Number.parseInt(raw, 8) : 0;
}

interface ScanResult {
  entries: Map<string, ScannedEntry>;
  manifestBytes: Uint8Array;
  readmeBytes: Uint8Array;
}

async function scanPackage(bytes: Uint8Array): Promise<ScanResult> {
  const stream = Readable.from([bytes]).pipe(createGunzip());
  const reader = new ByteStream(stream[Symbol.asyncIterator]());
  const entries = new Map<string, ScannedEntry>();
  let manifestBytes: Uint8Array | null = null;
  let readmeBytes: Uint8Array | null = null;
  try {
    for (;;) {
      const header = await reader.read(512);
      if (!header) throw new Error("the tar stream ends without an end-of-archive block");
      if (header.every((byte) => byte === 0)) break;
      const name = tarText(header, 0, 100);
      const prefix = tarText(header, 345, 155);
      const entryPath = prefix ? `${prefix}/${name}` : name;
      if (!entryPath || entryPath.startsWith("/") || entryPath.split("/").includes("..")) {
        throw new Error(`the archive contains an unsafe path: ${JSON.stringify(entryPath)}`);
      }
      if (header[156] !== 0 && header[156] !== 0x30) throw new Error(`${entryPath} is not a regular file`);
      const size = tarNumber(header, 124, 12);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${entryPath} has an invalid size`);
      if (entries.has(entryPath)) throw new Error(`the archive contains ${entryPath} twice`);
      const hash = createHash("sha256");
      if (entryPath === "manifest.json" || entryPath === "README.md") {
        const payload = await reader.read(size);
        if (!payload) throw new Error(`${entryPath} is truncated`);
        hash.update(payload);
        if (entryPath === "manifest.json") manifestBytes = payload;
        else readmeBytes = payload;
      } else {
        await reader.drain(size, hash);
      }
      entries.set(entryPath, { sha256: hash.digest("hex"), size });
      const padding = (512 - (size % 512)) % 512;
      if (padding) await reader.drain(padding);
    }
  } finally {
    await reader.close();
  }
  if (!manifestBytes) throw new Error("the package has no manifest.json");
  if (!readmeBytes) throw new Error("the package has no README.md");
  return { entries, manifestBytes, readmeBytes };
}

function parseManifest(bytes: Uint8Array): PackageManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }
  if (!isRecord(value)) throw new Error("manifest.json is not an object");
  if (value.format !== RESEARCH_PACKAGE_FORMAT || value.schemaVersion !== RESEARCH_PACKAGE_SCHEMA_VERSION) {
    throw new Error(`manifest.json has an unsupported format or schemaVersion (${String(value.format)}/${String(value.schemaVersion)})`);
  }
  const manifest = value as unknown as PackageManifest;
  if (!isRecord(manifest.source) || !isRecord(manifest.producer) || !Array.isArray(manifest.inventory) || !Array.isArray(manifest.omissions)) {
    throw new Error("manifest.json is incomplete");
  }
  if (typeof manifest.createdAt !== "string" || typeof manifest.source.projectId !== "string" || typeof manifest.source.title !== "string") {
    throw new Error("manifest.json has an invalid source or createdAt");
  }
  if (manifest.producer.product !== "ScienceDiscovery" || typeof manifest.producer.version !== "string") {
    throw new Error("manifest.json has an invalid producer");
  }
  if (!["evidence", "verified-reproduction", "combined"].includes(manifest.packageKind)) {
    throw new Error(`manifest.json has an invalid packageKind: ${String(manifest.packageKind)}`);
  }
  return manifest;
}

function validateInventory(manifest: PackageManifest, scanned: Map<string, ScannedEntry>): void {
  const listed = new Set<string>();
  for (const entry of manifest.inventory as PackageInventoryEntry[]) {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.checksum !== "string" || !Number.isSafeInteger(entry.sizeBytes)) {
      throw new Error("manifest.json has an invalid inventory entry");
    }
    if (listed.has(entry.path)) throw new Error(`manifest.json lists ${entry.path} twice in its inventory`);
    listed.add(entry.path);
    const found = scanned.get(entry.path);
    if (!found) throw new Error(`inventory entry ${entry.path} is missing from the archive`);
    if (found.size !== entry.sizeBytes) {
      throw new Error(`${entry.path} is ${found.size} bytes but the manifest says ${entry.sizeBytes}`);
    }
    if (found.sha256 !== entry.checksum) throw new Error(`${entry.path} does not match its manifest checksum`);
  }
  for (const entryPath of scanned.keys()) {
    if (entryPath !== "manifest.json" && !listed.has(entryPath)) {
      throw new Error(`${entryPath} is not listed in the manifest inventory`);
    }
  }
  for (const required of ["records.json", "README.md"]) {
    if (!listed.has(required)) throw new Error(`manifest.json does not list ${required}`);
  }
}

/**
 * Reads only what the page needs: the manifest and README are kept, every
 * other entry is hashed and discarded. The whole package is verified against
 * its manifest, so a damaged upload fails before it is published.
 */
export async function readSessionPackage(bytes: Uint8Array): Promise<SessionPackageSummary> {
  if (bytes.byteLength > MAX_SESSION_PACKAGE_BYTES) {
    throw new Error(`the package is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB, over the 50 MiB limit`);
  }
  let scanned: ScanResult;
  try {
    scanned = await scanPackage(bytes);
  } catch (error) {
    throw new Error(`the package cannot be unpacked: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = parseManifest(scanned.manifestBytes);
  validateInventory(manifest, scanned.entries);
  let readme: string;
  try {
    readme = new TextDecoder("utf-8", { fatal: true }).decode(scanned.readmeBytes);
  } catch {
    throw new Error("README.md is not valid UTF-8");
  }
  return { manifest, readme };
}

function relativePath(value: unknown, where: string): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.split("/").includes("..")) {
    throw new Error(`${where} must be a relative path inside the sessions prefix`);
  }
  return value;
}

/** Validate the persisted index before a build trusts it. */
function validateIndex(value: unknown): SessionIndex {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.sessions)) {
    throw new Error("sessions/index.json has an unsupported schemaVersion or is incomplete");
  }
  const seen = new Set<string>();
  for (const entry of value.sessions) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.id)) {
      throw new Error("sessions/index.json has an entry with an unsafe id");
    }
    if (seen.has(entry.id)) throw new Error(`sessions/index.json lists ${entry.id} twice`);
    seen.add(entry.id);
    if (typeof entry.name !== "string" || typeof entry.description !== "string" || typeof entry.createdAt !== "string") {
      throw new Error(`sessions/index.json entry ${entry.id} has no name, description or createdAt`);
    }
    if (!isRecord(entry.benchmark) || typeof entry.benchmark.name !== "string" || typeof entry.benchmark.caseId !== "string") {
      throw new Error(`sessions/index.json entry ${entry.id} has an invalid benchmark`);
    }
    if (!isRecord(entry.category) || typeof entry.category.source !== "string") {
      throw new Error(`sessions/index.json entry ${entry.id} has an invalid category`);
    }
    if (!isRecord(entry.contents) || ["messages", "artifacts", "files", "executions", "memoryNodes"]
      .some((key) => !Number.isSafeInteger((entry.contents as Record<string, unknown>)[key]))) {
      throw new Error(`sessions/index.json entry ${entry.id} has invalid contents`);
    }
    if (!isRecord(entry.producer) || typeof entry.producer.version !== "string") {
      throw new Error(`sessions/index.json entry ${entry.id} has an invalid producer`);
    }
    if (!isRecord(entry.download) || !/^[0-9a-f]{64}$/.test(String(entry.download.sha256))) {
      throw new Error(`sessions/index.json entry ${entry.id} has an invalid download`);
    }
    relativePath(entry.download.url, `sessions/index.json entry ${entry.id} download.url`);
    relativePath(entry.readme, `sessions/index.json entry ${entry.id} readme`);
  }
  return value as unknown as SessionIndex;
}

const EMPTY_INDEX: SessionIndex = { schemaVersion: 1, sessions: [], updatedAt: null };

/**
 * Missing index is not an error: a site that has never published a package
 * still builds, showing an empty tab.
 */
export async function loadSessionIndex(source: { dir: string } | { url: string }): Promise<SessionIndex> {
  if ("dir" in source) {
    try {
      return validateIndex(JSON.parse(await readFile(path.join(source.dir, SESSIONS_INDEX), "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_INDEX;
      throw error;
    }
  }
  const response = await fetch(source.url, { signal: AbortSignal.timeout(60_000) });
  if (response.status === 404) return EMPTY_INDEX;
  if (!response.ok) throw new Error(`sessions index download failed: ${response.status} ${source.url}`);
  return validateIndex(await response.json() as unknown);
}

export function sessionUrl(baseUrl: string, relative: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${relative.replace(/^\/+/u, "")}`;
}

/** Turns the published index into catalog assets; the browser fetches bytes from the sessions prefix. */
export function collectSessions(index: SessionIndex, baseUrl: string): SessionAsset[] {
  return index.sessions.map((entry) => ({
    author: null,
    benchmark: entry.benchmark,
    category: entry.category,
    contents: entry.contents,
    description: entry.description,
    download: {
      sha256: entry.download.sha256,
      size: entry.download.size,
      url: sessionUrl(baseUrl, entry.download.url),
    },
    id: entry.id,
    kind: "session-package",
    name: entry.name,
    readme: sessionUrl(baseUrl, entry.readme),
    related: entry.related,
    run: entry.run,
    source: "manual",
    tags: [],
    version: entry.producer.version,
  }));
}

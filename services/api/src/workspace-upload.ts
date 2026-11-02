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

import { access, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

import { resolveWorkspaceFile } from "@sciencediscovery/workspace";
import { sha256, sha256File } from "@sciencediscovery/cas";
import type { WorkspaceFile } from "@sciencediscovery/schema";

export type WorkspaceConflictPolicy = "reject" | "overwrite" | "rename";

/** Per-file multipart upload default: 1 GiB. 0 = unlimited. */
export const DEFAULT_WORKSPACE_UPLOAD_MAX_FILE_BYTES = 1_073_741_824;
/** Multipart request body default: 10 GiB, aligned with workspace total. 0 = unlimited. */
export const DEFAULT_WORKSPACE_UPLOAD_MAX_REQUEST_BYTES = 10_737_418_240;
/** Align with runner default workspace quota: 10 GiB. 0 = unlimited. */
export const DEFAULT_WORKSPACE_MAX_BYTES = 10_737_418_240;

export interface WorkspaceUploadLimits {
  maxFileBytes: number;
  maxRequestBytes: number;
  maxWorkspaceBytes: number;
}

export interface MultipartUploadPart {
  bytes: Buffer;
  fieldName: string;
  filename: string;
}

export interface WorkspaceUploadItemResult {
  error?: string;
  hash?: string;
  originalName: string;
  path?: string;
  /** Byte size of the uploaded content; absent on failed entries. */
  size?: number;
  status: "created" | "overwritten" | "renamed" | "failed";
}

export interface WorkspaceUploadResult {
  errors: Array<{ error: string; name: string }>;
  files: WorkspaceFile[];
  uploaded: WorkspaceUploadItemResult[];
}

export function parseConflictPolicy(value: string | null | undefined): WorkspaceConflictPolicy {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "rename") return "rename";
  if (normalized === "overwrite" || normalized === "reject") return normalized;
  throw new Error("conflict must be one of rename, overwrite, or reject");
}

export function sanitizeUploadFilename(filename: string): string {
  const normalized = filename.replaceAll("\\", "/").trim();
  if (!normalized) {
    throw Object.assign(new Error("Upload filename is missing or invalid"), { code: "INVALID_UPLOAD_PATH" });
  }
  if (normalized.includes("\0")) {
    throw Object.assign(new Error("Upload filename contains a NUL byte"), { code: "INVALID_UPLOAD_PATH" });
  }
  // Reject traversal / absolute / nested paths instead of silently taking basename.
  // Accept only a plain single-segment basename (WSP-003).
  const absoluteOrDrive =
    normalized.startsWith("/")
    || /^[a-zA-Z]:(\/|$)/.test(normalized)
    || normalized.startsWith("//");
  const hasSeparator = normalized.includes("/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const hasTraversal = segments.some((segment) => segment === "." || segment === "..");
  if (absoluteOrDrive || hasSeparator || hasTraversal || normalized === "." || normalized === "..") {
    throw Object.assign(
      new Error("Upload filename must be a plain basename without path separators or traversal"),
      { code: "INVALID_UPLOAD_PATH" },
    );
  }
  const base = basename(normalized);
  if (!base || base === "." || base === "..") {
    throw Object.assign(new Error("Upload filename is missing or invalid"), { code: "INVALID_UPLOAD_PATH" });
  }
  return base;
}

export async function readMultipartUploads(
  request: IncomingMessage,
  maxRequestBytes: number,
): Promise<MultipartUploadPart[]> {
  const contentType = request.headers["content-type"] ?? "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary || boundary.length > 200) {
    throw Object.assign(new Error("Workspace upload must be multipart/form-data with a valid boundary"), {
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
  }

  const body = await readLimitedBytes(request, maxRequestBytes, "Workspace upload");
  const delimiter = Buffer.from(`--${boundary}`);
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  const parts: MultipartUploadPart[] = [];
  let cursor = body.indexOf(delimiter);
  while (cursor >= 0) {
    cursor += delimiter.length;
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) break;
    if (!body.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) {
      throw new Error("Workspace upload multipart body is malformed");
    }
    const headerStart = cursor + 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd < 0) throw new Error("Workspace upload multipart headers are malformed");
    const headers = body.subarray(headerStart, headerEnd).toString("utf8");
    const contentDisposition = headers.split("\r\n").find((line) => /^content-disposition:/i.test(line));
    const parameters = contentDisposition ? contentDispositionParameters(contentDisposition) : new Map<string, string>();
    const fieldName = parameters.get("name") ?? "";
    // RFC 7578 4.2: only `filename*` is percent-encoded; a plain `filename`
    // is sent verbatim (browsers escape only quote, CR and LF).
    const extendedFilename = parameters.get("filename*");
    const filename = extendedFilename === undefined
      ? parameters.get("filename")
      : decodeExtendedFilename(extendedFilename);
    const contentStart = headerEnd + 4;
    const contentEnd = body.indexOf(nextDelimiter, contentStart);
    if (contentEnd < 0) throw new Error("Workspace upload multipart body has no closing boundary");
    if ((fieldName === "file" || fieldName === "files") && filename) {
      const bytes = Buffer.from(body.subarray(contentStart, contentEnd));
      // Keep 0-byte parts: empty templates/placeholders are valid uploads.
      parts.push({ bytes, fieldName, filename });
    }
    cursor = contentEnd + 2;
  }
  if (!parts.length) throw new Error("Workspace upload must contain at least one file field");
  return parts;
}

/**
 * Split `Content-Disposition` parameters the way a multipart part is written:
 * `;` separates parameters only outside a quoted-string, and a quoted value
 * runs to its closing quote, where a backslash escapes the next character.
 * The disposition type before the first `;` is not a parameter.
 */
function contentDispositionParameters(header: string): Map<string, string> {
  const parameters = new Map<string, string>();
  const value = header.slice(header.indexOf(":") + 1);
  let index = value.indexOf(";");
  while (index >= 0 && index < value.length) {
    while (index < value.length && (value[index] === ";" || /\s/.test(value[index]!))) index += 1;
    if (index >= value.length) break;
    const equals = value.indexOf("=", index);
    if (equals < 0) break;
    const separator = value.indexOf(";", index);
    if (separator >= 0 && separator < equals) {
      index = separator + 1;
      continue;
    }
    const name = value.slice(index, equals).trim().toLowerCase();
    index = equals + 1;
    let parsed = "";
    if (value[index] === '"') {
      index += 1;
      while (index < value.length && value[index] !== '"') {
        if (value[index] === "\\" && index + 1 < value.length) index += 1;
        parsed += value[index];
        index += 1;
      }
      if (value[index] === '"') index += 1;
    } else {
      const end = value.indexOf(";", index);
      parsed = (end < 0 ? value.slice(index) : value.slice(index, end)).trim();
      index = end < 0 ? value.length : end;
    }
    if (name && !parameters.has(name)) parameters.set(name, parsed);
  }
  return parameters;
}

/** RFC 5987 value (`charset'lang'percent-encoded`), decoded exactly once. */
function decodeExtendedFilename(value: string): string {
  const encoded = /^[^']*'[^']*'(.*)$/.exec(value)?.[1] ?? value;
  try {
    return decodeURIComponent(encoded.trim());
  } catch {
    return encoded.trim();
  }
}

async function readLimitedBytes(request: IncomingMessage, maxBytes: number, label: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    // maxBytes === 0 means unlimited (same as per-file / workspace quotas)
    if (maxBytes > 0 && total > maxBytes) {
      throw Object.assign(new Error(`${label} exceeds the ${maxBytes} byte limit`), { code: "PAYLOAD_TOO_LARGE" });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function measureWorkspaceBytes(workspaceRoot: string): Promise<number> {
  let total = 0;
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const metadata = await stat(fullPath);
      total += metadata.size;
    }
  }
  await visit(workspaceRoot);
  return total;
}

async function assertSafeWorkspaceTarget(workspaceRoot: string, relativePath: string): Promise<string> {
  const target = resolveWorkspaceFile(workspaceRoot, relativePath);
  const root = resolve(workspaceRoot);
  let current = root;
  const segments = relative(root, target).split(sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`Path escapes the workspace through a symbolic link: ${relativePath}`);
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw new Error(`Upload path parent is not a directory: ${relativePath}`);
    }
    if (index === segments.length - 1 && !metadata.isFile() && !metadata.isDirectory()) {
      throw new Error(`Refusing to write special device path: ${relativePath}`);
    }
  }
  return target;
}

export async function allocateUploadPath(
  workspaceRoot: string,
  filename: string,
  conflict: WorkspaceConflictPolicy,
): Promise<{ path: string; status: "created" | "overwritten" | "renamed" }> {
  const safeName = sanitizeUploadFilename(filename);
  const primary = await assertSafeWorkspaceTarget(workspaceRoot, safeName);
  try {
    await access(primary);
  } catch {
    return { path: safeName, status: "created" };
  }
  if (conflict === "reject") {
    throw Object.assign(new Error(`File already exists: ${safeName}`), { code: "CONFLICT" });
  }
  if (conflict === "overwrite") {
    return { path: safeName, status: "overwritten" };
  }
  const extension = extname(safeName);
  const stem = extension ? safeName.slice(0, -extension.length) : safeName;
  for (let index = 1; index < 10_000; index += 1) {
    const candidateName = `${stem}-${index}${extension}`;
    const candidate = await assertSafeWorkspaceTarget(workspaceRoot, candidateName);
    try {
      await access(candidate);
    } catch {
      return { path: candidateName, status: "renamed" };
    }
  }
  throw new Error(`Could not allocate a unique name for ${safeName}`);
}

export async function writeWorkspaceUpload(options: {
  bytes: Buffer;
  conflict: WorkspaceConflictPolicy;
  filename: string;
  limits: WorkspaceUploadLimits;
  workspaceRoot: string;
  workspaceBytes?: number;
}): Promise<WorkspaceUploadItemResult & { absolutePath: string; bytesWritten: number }> {
  const originalName = sanitizeUploadFilename(options.filename);
  if (options.limits.maxFileBytes > 0 && options.bytes.length > options.limits.maxFileBytes) {
    throw Object.assign(
      new Error(`File exceeds the ${options.limits.maxFileBytes} byte upload limit`),
      { code: "PAYLOAD_TOO_LARGE" },
    );
  }
  const allocation = await allocateUploadPath(options.workspaceRoot, originalName, options.conflict);
  const target = await assertSafeWorkspaceTarget(options.workspaceRoot, allocation.path);
  const currentBytes = options.workspaceBytes ?? await measureWorkspaceBytes(options.workspaceRoot);
  let replacedBytes = 0;
  if (allocation.status === "overwritten") {
    try {
      replacedBytes = (await stat(target)).size;
    } catch {
      replacedBytes = 0;
    }
  }
  if (
    options.limits.maxWorkspaceBytes > 0
    && currentBytes - replacedBytes + options.bytes.length > options.limits.maxWorkspaceBytes
  ) {
    throw Object.assign(
      new Error(`Upload would exceed the ${options.limits.maxWorkspaceBytes} byte workspace quota`),
      { code: "QUOTA_EXCEEDED" },
    );
  }
  await mkdir(dirname(target), { recursive: true });
  const staging = `${target}.uploading-${process.pid}-${Date.now()}`;
  try {
    await writeFile(staging, options.bytes);
    const staged = await lstat(staging);
    if (!staged.isFile()) throw new Error("Upload staging path is not a regular file");
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    absolutePath: target,
    bytesWritten: options.bytes.length,
    hash: sha256(options.bytes),
    originalName,
    path: allocation.path,
    status: allocation.status,
  };
}

export async function uploadWorkspaceParts(options: {
  conflict: WorkspaceConflictPolicy;
  limits: WorkspaceUploadLimits;
  listFiles: () => Promise<WorkspaceFile[]>;
  parts: MultipartUploadPart[];
  registerArtifact?: (path: string) => Promise<void>;
  workspaceRoot: string;
}): Promise<WorkspaceUploadResult> {
  const uploaded: WorkspaceUploadItemResult[] = [];
  const errors: Array<{ error: string; name: string }> = [];
  let workspaceBytes = await measureWorkspaceBytes(options.workspaceRoot);
  for (const part of options.parts) {
    try {
      if (options.limits.maxFileBytes > 0 && part.bytes.length > options.limits.maxFileBytes) {
        throw Object.assign(
          new Error(`File exceeds the ${options.limits.maxFileBytes} byte upload limit`),
          { code: "PAYLOAD_TOO_LARGE" },
        );
      }
      const written = await writeWorkspaceUpload({
        bytes: part.bytes,
        conflict: options.conflict,
        filename: part.filename,
        limits: options.limits,
        workspaceBytes,
        workspaceRoot: options.workspaceRoot,
      });
      workspaceBytes += written.bytesWritten;
      if (written.status === "overwritten") {
        // replaced size already subtracted inside writeWorkspaceUpload quota check via replacedBytes,
        // but workspaceBytes tracker here only adds; remeasure cheaply for correctness after overwrite.
        workspaceBytes = await measureWorkspaceBytes(options.workspaceRoot);
      }
      if (written.path && options.registerArtifact) await options.registerArtifact(written.path);
      uploaded.push({
        hash: written.hash,
        originalName: written.originalName,
        path: written.path,
        size: written.bytesWritten,
        status: written.status,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "INVALID_UPLOAD_PATH") throw error;
      const message = error instanceof Error ? error.message : "Upload failed";
      const name = (() => {
        try {
          return sanitizeUploadFilename(part.filename);
        } catch {
          return part.filename || "unnamed";
        }
      })();
      uploaded.push({ error: message, originalName: name, status: "failed" });
      errors.push({ error: message, name });
    }
  }
  return {
    errors,
    files: await options.listFiles(),
    uploaded,
  };
}

export async function readFileSha256(path: string): Promise<string> {
  return await sha256File(path);
}

/** Map an upload filename to a media type by extension, for the memory graph's
 * SourceFile node. Returns ``undefined`` for unknown extensions so the graph
 * stores an absent (not a wrong) media_type. Case-insensitive on the suffix. */
export function inferMediaType(filename: string): string | undefined {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".csv":
      return "text/csv";
    case ".tsv":
      return "text/tab-separated-values";
    case ".json":
      return "application/json";
    case ".jsonl":
      return "application/jsonl+json";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".parquet":
      return "application/vnd.apache.parquet";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".h5":
    case ".hdf5":
      return "application/x-hdf5";
    // Common research formats beyond the basics. None of these are PDFs —
    // what matters for the graph's cite gates is only that a known non-PDF
    // type is recorded, so the claim route (cites_source_file_aliases) can
    // proceed; the specific string is informational.
    case ".npy":
      return "application/x-npy";
    case ".npz":
      return "application/x-npz";
    case ".pkl":
    case ".pickle":
      return "application/x-pickle";
    case ".fasta":
    case ".fa":
    case ".fna":
    case ".faa":
      return "text/x-fasta";
    case ".fastq":
    case ".fq":
      return "text/x-fastq";
    case ".vcf":
      return "text/x-vcf";
    case ".hypo":
      return "application/octet-stream";
    case ".zip":
      return "application/zip";
    case ".tar":
      return "application/x-tar";
    case ".gz":
    case ".tgz":
      return "application/gzip";
    case ".xml":
      return "application/xml";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".toml":
      return "application/toml";
    case ".rds":
      return "application/x-rds";
    case ".dta":
      return "application/x-stata";
    case ".sav":
      return "application/x-spss-sav";
    case ".mat":
      return "application/x-matlab-data";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".bmp":
      return "image/bmp";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}

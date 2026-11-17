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

import type { IncomingMessage } from "node:http";
import { open, rm } from "node:fs/promises";

import { SKILL_LIMITS } from "@sciencediscovery/specialist";

const MAX_BODY_BYTES = 1_500_000;
const MAX_SKILL_IMPORT_BODY_BYTES = SKILL_LIMITS.archiveBytes + 1024 * 1024;

export async function readBytes(request: IncomingMessage, maxBytes: number, label: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw payloadTooLarge(label);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function payloadTooLarge(label: string): Error {
  // The client shows localized copy keyed on the code; a raw byte count is an
  // internal number that leaked into the dialog and reads as gibberish there.
  const error = new Error(`${label} exceeds its size limit`) as NodeJS.ErrnoException & { limitLabel?: string };
  error.code = "PAYLOAD_TOO_LARGE";
  error.limitLabel = label;
  return error;
}

/**
 * Stream a request body to a file instead of a buffer.
 *
 * A research package can be far larger than the process should hold, so the upload
 * lands on disk while it arrives and the caller parses it from there (#1152 stage 2).
 */
export async function readBytesToFile(request: IncomingMessage, maxBytes: number, label: string, path: string): Promise<{ bytes: number }> {
  const handle = await open(path, "wx");
  let total = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) throw payloadTooLarge(label);
      await handle.write(buffer);
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return { bytes: total };
}

export async function readJson<T>(request: IncomingMessage): Promise<T> {
  const bytes = await readBytes(request, MAX_BODY_BYTES, "Request body");
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

export async function readOptionalJson<T>(request: IncomingMessage): Promise<T | undefined> {
  const bytes = await readBytes(request, MAX_BODY_BYTES, "Request body");
  if (bytes.length === 0) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

export async function readMultipartSkill(request: IncomingMessage): Promise<{ bytes: Buffer; filename: string }> {
  const contentType = request.headers["content-type"] ?? "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary || boundary.length > 200) throw new Error("Skill import must be multipart/form-data with a valid boundary");
  const body = await readBytes(request, MAX_SKILL_IMPORT_BODY_BYTES, "Skill import");
  const delimiter = Buffer.from(`--${boundary}`);
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  let cursor = body.indexOf(delimiter);
  while (cursor >= 0) {
    cursor += delimiter.length;
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) break;
    if (!body.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) {
      throw new Error("Skill import multipart body is malformed");
    }
    const headerStart = cursor + 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd < 0) throw new Error("Skill import multipart headers are malformed");
    const headers = body.subarray(headerStart, headerEnd).toString("utf8");
    const contentDisposition = headers.split("\r\n").find((line) => /^content-disposition:/i.test(line));
    const fieldName = contentDisposition?.match(/\bname="([^"]+)"/i)?.[1];
    const filename = contentDisposition?.match(/\bfilename="([^"]*)"/i)?.[1];
    const contentStart = headerEnd + 4;
    const contentEnd = body.indexOf(nextDelimiter, contentStart);
    if (contentEnd < 0) throw new Error("Skill import multipart body has no closing boundary");
    if (fieldName === "file" && filename) {
      const bytes = Buffer.from(body.subarray(contentStart, contentEnd));
      if (!bytes.length) throw new Error("Skill import file is empty");
      return { bytes, filename };
    }
    cursor = contentEnd + 2;
  }
  throw new Error("Skill import must contain one file field");
}

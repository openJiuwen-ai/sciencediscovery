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

import { SKILL_LIMITS } from "@sciencediscovery/specialist";

const MAX_BODY_BYTES = 1_500_000;
const MAX_SKILL_IMPORT_BODY_BYTES = SKILL_LIMITS.archiveBytes + 1024 * 1024;

export async function readBytes(request: IncomingMessage, maxBytes: number, label: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error = new Error(`${label} exceeds the ${maxBytes} byte limit`) as NodeJS.ErrnoException;
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T>(request: IncomingMessage): Promise<T> {
  const bytes = await readBytes(request, MAX_BODY_BYTES, "Request body");
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

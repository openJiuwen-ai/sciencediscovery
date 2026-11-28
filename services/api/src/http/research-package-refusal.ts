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

/** Stable codes a client can branch on when the uploaded file is not a package
 *  it can import. They are the answer for caller input, so a client may show
 *  the message as it is instead of an internal-error string (#1540). */
export const RESEARCH_PACKAGE_INVALID_CODE = "RESEARCH_PACKAGE_INVALID";
export const RESEARCH_PACKAGE_TRUNCATED_CODE = "RESEARCH_PACKAGE_TRUNCATED";
/** The archive itself is within its cap, but one entry inside it is not. */
export const RESEARCH_PACKAGE_METADATA_TOO_LARGE_CODE = "RESEARCH_PACKAGE_TOO_LARGE";

export interface ResearchPackageRefusal {
  status: 400 | 413;
  code: string;
  message: string;
}

/** The two package endpoints a bad file can reach. */
const RESEARCH_PACKAGE_UPLOAD_PATH = /^\/api\/projects\/[^/]+\/research-package\/(?:inspect|import)$/u;

/** Sentences `importResearchPackageStreamed` raises for a package it refuses.
 *  Each one is spelled out, and none is a prefix of an exporter-side fault:
 *  "Package object size changed while hashing" and "A synchronous export
 *  cannot stream package objects" describe our own failures and must keep
 *  their 500. A refusal added to the parser therefore has to be added here
 *  too, or it keeps answering 500 — which is the safe direction. */
const PARSER_REFUSAL = new RegExp([
  String.raw`^(?:Invalid|Unsafe|Unsupported|Duplicate) (?:\.sdresearch |research package|package)\b`,
  String.raw`^Research package (?:is missing|inventory is incomplete|carries data|exceeds its limits|metadata entry|contains a non-regular file)`,
  String.raw`^Package (?:checksum mismatch|inventory entry is missing): `,
  String.raw`^File is not listed in the package inventory: `,
].join("|"), "u");

const TRUNCATED_REFUSAL: ResearchPackageRefusal = {
  status: 400,
  code: RESEARCH_PACKAGE_TRUNCATED_CODE,
  message: "This file is not a valid research package: it ends before the archive does.",
};

const NOT_AN_ARCHIVE_REFUSAL: ResearchPackageRefusal = {
  status: 400,
  code: RESEARCH_PACKAGE_INVALID_CODE,
  message: "This file is not a valid research package: it is not a gzip archive.",
};

/** A `.sdresearch` whose gzip magic is intact but whose deflate stream or CRC is
 *  damaged: `Z_DATA_ERROR` also carries "invalid bit length repeat" and
 *  "incorrect data check", so the sentence must not claim the file is not an
 *  archive at all. */
const CORRUPT_REFUSAL: ResearchPackageRefusal = {
  status: 400,
  code: RESEARCH_PACKAGE_INVALID_CODE,
  message: "This file is not a valid research package: its archive is corrupt.",
};

const METADATA_TOO_LARGE_REFUSAL: ResearchPackageRefusal = {
  status: 413,
  code: RESEARCH_PACKAGE_METADATA_TOO_LARGE_CODE,
  message: "This file is not a valid research package: one of its metadata entries is over the size limit.",
};

/** What to answer for `error` when it came from parsing an uploaded package, or
 *  `undefined` when it is not the caller's file (a filesystem failure, our own
 *  fault) and the caller keeps the existing classification.
 *
 *  The decompressor reports the two shapes the issue names — random bytes and a
 *  file that is not gzip raise `Z_DATA_ERROR` / "incorrect header check", a
 *  truncated one raises `Z_BUF_ERROR` / "unexpected end of file" — and the
 *  parser raises its own sentences for a package whose content is wrong. */
export function researchPackageRefusal(error: unknown, path: string): ResearchPackageRefusal | undefined {
  if (!(error instanceof Error)) return undefined;
  if (!RESEARCH_PACKAGE_UPLOAD_PATH.test(path)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "Z_BUF_ERROR" || /\bunexpected end of file\b/iu.test(error.message)) return TRUNCATED_REFUSAL;
  // A file that never had the gzip header says so with these two messages; every
  // other decompressor refusal is a stream that started as gzip and is damaged.
  if (/\bincorrect header check\b|\bnot in gzip format\b/iu.test(error.message)) return NOT_AN_ARCHIVE_REFUSAL;
  if (code === "Z_DATA_ERROR" || code === "Z_NEED_DICT"
    || /\binvalid bit length repeat\b|\bincorrect data check\b/iu.test(error.message)) return CORRUPT_REFUSAL;
  if (/\bmetadata entry is too large\b/iu.test(error.message)) return METADATA_TOO_LARGE_REFUSAL;
  if (PARSER_REFUSAL.test(error.message)) {
    return {
      status: 400,
      code: RESEARCH_PACKAGE_INVALID_CODE,
      message: `This file is not a valid research package (${error.message}).`,
    };
  }
  return undefined;
}
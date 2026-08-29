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
 * Model-facing projection of one Artifact version's stored bytes.
 *
 * The previous projection returned the whole object: UTF-8 for a short
 * media-type allowlist, base64 for everything else. Base64 is the worse of the
 * two — it inflates the payload by a third and carries no information the
 * model can use — so binary versions now return type and size only, and text
 * versions return one page.
 */

import {
  boundText,
  DEFAULT_READ_PAGE_MAX_BYTES,
  DEFAULT_TOOL_OUTPUT_MAX_LINES,
  splitKeepingLineEndings,
} from "@sciencediscovery/tools";
import type { ArtifactTextPage } from "@sciencediscovery/schema";

import { isBinaryContent } from "./file-page.js";

/** Upper bound on the bytes decoded for paging; the page itself is far smaller. */
export const MAX_ARTIFACT_TEXT_BYTES = 8 * 1_024 * 1_024;

export interface ArtifactContentProjection {
  binary: boolean;
  content?: string;
  encoding: "binary" | "utf8";
  mediaType: string;
  /** Actionable explanation of anything line offsets cannot reach. */
  note?: string;
  page?: ArtifactTextPage;
  size: number;
  /** True when the version is larger than the decodable text window. */
  truncated: boolean;
}

/** Media types that are text even though they are not under `text/`. */
function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/")
    || /(?:json|javascript|xml|x-ipynb|x-tex|yaml|csv)/.test(mediaType);
}

/**
 * Classify then page. The media type only promotes content to text; it never
 * demotes it, so a scientific format registered as `chemical/x-pdb` or an
 * unlabeled `application/octet-stream` upload is judged by its bytes.
 */
export function projectArtifactContent(
  bytes: Buffer,
  mediaType: string,
  options: { limit?: number; offset?: number } = {},
): ArtifactContentProjection {
  const sample = bytes.subarray(0, 8_192);
  const binary = !isTextMediaType(mediaType) && isBinaryContent(sample, bytes.length > sample.length);
  if (binary) {
    return { binary: true, encoding: "binary", mediaType, size: bytes.length, truncated: false };
  }

  const truncated = bytes.length > MAX_ARTIFACT_TEXT_BYTES;
  const text = bytes.subarray(0, MAX_ARTIFACT_TEXT_BYTES).toString("utf8");
  const lines = splitKeepingLineEndings(text);
  const startLine = Math.max(1, Math.trunc(options.offset ?? 1));
  const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_TOOL_OUTPUT_MAX_LINES));

  // Slice by line, then re-bound by bytes so a caller-chosen limit — or one
  // very wide line, as in a single-line JSON artifact — cannot exceed the page
  // budget.
  const requested = lines.slice(startLine - 1, startLine - 1 + limit).join("");
  const page = boundText(requested, { keep: "head", maxBytes: DEFAULT_READ_PAGE_MAX_BYTES, maxLines: limit });
  const pageLines = page.totalLines - page.omittedLines;
  const endLine = startLine + pageLines - 1;
  // `hasMore` states one thing only: that line paging can still advance inside
  // the decodable window. Folding `truncated` or `partialLine` in here would
  // promise a next page that no offset can reach — past the window `nextOffset`
  // would equal the offset just used, and the model would page forever.
  const hasMore = endLine < lines.length;
  const note = describeUnreachable(lines.length, truncated, page.partialLine, startLine, bytes.length);
  return {
    binary: false,
    content: page.text,
    encoding: "utf8",
    mediaType,
    ...(note ? { note } : {}),
    page: {
      bytes: Buffer.byteLength(page.text, "utf8"),
      endLine,
      hasMore,
      ...(hasMore ? { nextOffset: endLine + 1 } : {}),
      partialLine: page.partialLine,
      startLine,
      totalLines: lines.length,
    },
    size: bytes.length,
    truncated,
  };
}

/**
 * Whatever the line protocol cannot address has to be said out loud, because
 * `hasMore: false` on its own reads as "you have seen everything".
 */
function describeUnreachable(
  windowLines: number,
  truncated: boolean,
  partialLine: boolean,
  startLine: number,
  size: number,
): string | undefined {
  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `Only the first ${MAX_ARTIFACT_TEXT_BYTES} bytes of this ${size}-byte version are readable as text,`
      + ` which is ${windowLines} lines; offset cannot reach past line ${windowLines}.`
      + " Process the rest with run_python or run_shell.",
    );
  }
  if (partialLine) {
    notes.push(
      `Line ${startLine} is wider than one page and was cut. Line offsets cannot address the rest of that`
      + " line; read it with run_python or run_shell instead.",
    );
  }
  return notes.length ? notes.join(" ") : undefined;
}

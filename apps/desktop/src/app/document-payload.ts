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
 * What a document's bytes become inside a tab.
 *
 * The panel used to read every document as text, which is right for a script
 * and wrong for everything a picture, a PDF or a workbook is: `response.text()`
 * turns a PNG into replacement characters. A document is now read as bytes and
 * turned into one of two representations here — the text it decodes to, or a
 * data URL a frame or an `<img>` can draw — and a document this app has no
 * renderer for is kept out of the tab entirely rather than shown as mojibake;
 * a container among them keeps its bytes for the download alone.
 */

import { documentKind, isBinaryDocument } from "./preview-kind.js";

/**
 * The largest document the panel will hold inline. A data URL is a third
 * larger than the bytes it carries and lives in the tab's state, so a very
 * large document would cost the whole app memory to show one page of it; past
 * this the reader gets the name, the size and the download.
 */
export const MAX_INLINE_BYTES = 24 * 1024 * 1024;

export interface DocumentPayload {
  /** The document's text, for everything that is read rather than drawn. */
  content?: string;
  /** The document's bytes as a data URL, for everything that is drawn. */
  dataUrl?: string;
  /** The type the server sent, or the type the name implies where the server
   *  answered `application/octet-stream`. */
  mediaType: string;
  /** Too large to hold inline; the tab says so instead of showing a page. */
  tooLarge?: boolean;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 without `btoa`, which none of this module's tests can rely on and
 *  which takes a binary string rather than the bytes that arrived. */
export function base64Of(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const value = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    chunks.push(
      BASE64_ALPHABET[(value >> 18) & 63]!,
      BASE64_ALPHABET[(value >> 12) & 63]!,
      BASE64_ALPHABET[(value >> 6) & 63]!,
      BASE64_ALPHABET[value & 63]!,
    );
  }
  const left = bytes.length - index;
  if (left === 1) {
    const value = bytes[index]! << 16;
    chunks.push(BASE64_ALPHABET[(value >> 18) & 63]!, BASE64_ALPHABET[(value >> 12) & 63]!, "==");
  } else if (left === 2) {
    const value = (bytes[index]! << 16) | (bytes[index + 1]! << 8);
    chunks.push(
      BASE64_ALPHABET[(value >> 18) & 63]!,
      BASE64_ALPHABET[(value >> 12) & 63]!,
      BASE64_ALPHABET[(value >> 6) & 63]!,
      "=",
    );
  }
  return chunks.join("");
}

/** The bytes a data URL carries, for the reader that has to look inside them —
 *  a workbook is a zip before it is a table. */
export function bytesOfDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const binary = atob(comma < 0 ? dataUrl : dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The one decision a document read makes.
 *
 * The name decides what kind of document it is, and the kind decides whether
 * the bytes are decoded as UTF-8 or carried as a data URL. A type is chosen
 * that a browser and a reader would both recognise — the server's own answer
 * where it knows the extension, the name's where it does not.
 */
export function documentPayload(bytes: Uint8Array, name: string, mediaType = ""): DocumentPayload {
  const kind = documentKind(name, mediaType);
  const type = usableMediaType(kind, name, mediaType);
  if (bytes.byteLength > MAX_INLINE_BYTES) return { mediaType: type, tooLarge: true };
  // A container this build has no renderer for — a .docx, a .pptx, an archive —
  // never becomes text: decoding one is what showed `PK\u0003\u0004\u0014…`. Its
  // bytes are still carried, because the notice that replaces the page leaves
  // the download as the way to open the document.
  if (kind === "unrenderable" || isBinaryDocument(kind)) {
    return { dataUrl: `data:${type};base64,${base64Of(bytes)}`, mediaType: type };
  }
  return { content: new TextDecoder("utf-8").decode(bytes), mediaType: type };
}

const KIND_TYPES: Record<string, string> = {
  csv: "text/csv",
  html: "text/html",
  image: "application/octet-stream",
  json: "application/json",
  markdown: "text/markdown",
  pdf: "application/pdf",
  prose: "text/plain",
  python: "text/x-python",
  sheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  source: "text/plain",
  unrenderable: "application/octet-stream",
};

const IMAGE_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};

/**
 * The type to put on a data URL. `application/octet-stream` is what the server
 * answers for every extension its static table lacks, and it is useless to a
 * renderer, so the name fills it in; an image also takes its own type from its
 * extension, since one image wrong type makes a frame refuse it.
 */
function usableMediaType(kind: ReturnType<typeof documentKind>, name: string, mediaType: string): string {
  const type = (mediaType.split(";", 1)[0] ?? "").trim().toLowerCase();
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (kind === "image") return IMAGE_TYPES[extension] ?? (type.startsWith("image/") ? type : "application/octet-stream");
  if (type !== "" && type !== "application/octet-stream") return type;
  return KIND_TYPES[kind] ?? "application/octet-stream";
}

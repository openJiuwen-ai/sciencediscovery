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

import { uploadFileName } from "../api/sessions.js";

/**
 * The files waiting in the composer, and the decisions about them that do not
 * need a browser: what kind of file each one is, how its size reads, how many
 * of a selection fit under the cap, and what the server's answer does to the
 * cards.
 *
 * Kept out of `use-workspace` and the view for the same reason as `upload.ts`:
 * the test environment has no DOM, so the parts worth testing are the parts
 * that take values and return values.
 */

/** The ceiling the design sets for one turn's attachments. */
export const MAX_ATTACHMENTS = 20;

/**
 * How a file is drawn: a page in the type's colour with the type's glyph.
 * `file` is the fallback — the handoff draws it as a grey page with a question
 * mark, and it is what any extension this app has no badge for gets.
 */
export type AttachmentKind =
  | "archive"
  | "audio"
  | "code"
  | "csv"
  | "excel"
  | "file"
  | "image"
  | "markdown"
  | "pdf"
  | "ppt"
  | "text"
  | "video"
  | "word";

export type AttachmentStatus = "failed" | "uploaded" | "uploading";

/** One card in the composer. `file` is kept so a failure can be retried — the
 *  browser has it, and the session does not until it is sent. */
export interface Attachment {
  error?: string;
  file: File;
  id: string;
  name: string;
  /** Where the server put it. A collision is renamed, so this is not the name. */
  path?: string;
  size: number;
  status: AttachmentStatus;
}

const EXTENSION_KINDS: Record<string, AttachmentKind> = {
  "7z": "archive",
  aac: "audio",
  avi: "video",
  bz2: "archive",
  c: "code",
  cc: "code",
  cjs: "code",
  cpp: "code",
  css: "code",
  csv: "csv",
  doc: "word",
  docx: "word",
  flac: "audio",
  gif: "image",
  go: "code",
  gz: "archive",
  h: "code",
  hpp: "code",
  htm: "code",
  html: "code",
  ipynb: "code",
  java: "code",
  jpeg: "image",
  jpg: "image",
  js: "code",
  json: "code",
  jsx: "code",
  m4a: "audio",
  md: "markdown",
  mkv: "video",
  mov: "video",
  mp3: "audio",
  mp4: "video",
  ods: "excel",
  odt: "word",
  pdf: "pdf",
  png: "image",
  ppt: "ppt",
  pptx: "ppt",
  py: "code",
  rar: "archive",
  rb: "code",
  rtf: "word",
  sh: "code",
  svg: "image",
  tar: "archive",
  tex: "text",
  tif: "image",
  tiff: "image",
  ts: "code",
  tsv: "csv",
  tsx: "code",
  txt: "text",
  wav: "audio",
  webm: "video",
  webp: "image",
  xls: "excel",
  xlsx: "excel",
  xml: "code",
  yaml: "code",
  yml: "code",
  zip: "archive",
};

/** The type a file is drawn as. The extension decides, because that is what the
 *  card prints; the MIME type is the fallback for a file whose name has none —
 *  a dropped screenshot can arrive without an extension. */
export function attachmentKind(name: string, mime?: string): AttachmentKind {
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const fromName = EXTENSION_KINDS[extension];
  if (fromName !== undefined) return fromName;
  const family = (mime ?? "").split("/")[0];
  if (family === "image") return "image";
  if (family === "audio") return "audio";
  if (family === "video") return "video";
  return "file";
}

/**
 * The type the card prints beside the size: the extension in capitals, the way
 * a file manager names it. A name with no extension prints nothing — the card
 * then shows the size alone, rather than inventing a type from the MIME string,
 * which is not what the user would call the file.
 */
export function attachmentType(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toUpperCase();
}

/**
 * A file's size at the card's scale: one decimal below a hundred units
 * (`16.5KB`, the handoff's own example), a whole number above it (`256KB`), and
 * the unit the size is actually in.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0KB";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)}B`;
  const rounded = value < 100 ? Number(value.toFixed(1)) : Math.round(value);
  return `${rounded}${units[unit]}`;
}

/**
 * Take as many of `files` as the tray has room for.
 *
 * The cap is on the turn, not on the gesture, so a second drop has to count
 * what is already there. The selection keeps its order — the files the user
 * picked first are the ones that make it — and the number left out is returned
 * rather than dropped silently: the caller says so in a toast.
 */
export function takeWithinLimit<T>(files: readonly T[], room: number): { accepted: T[]; overflow: number } {
  if (files.length <= room) return { accepted: [...files], overflow: 0 };
  const take = Math.max(room, 0);
  return { accepted: files.slice(0, take), overflow: files.length - take };
}

/** What the upload route answers, in the shape this module reads. The server
 *  sends one entry per file, failed ones included. */
export interface UploadAnswer {
  errors: ReadonlyArray<{ error: string; name: string }>;
  uploaded: ReadonlyArray<{ error?: string; originalName: string; path?: string; status: string }>;
}

/**
 * Fold the server's answer into the cards that were sent.
 *
 * The answer is matched to the batch by name, in order, and each name is used
 * once: the same file chosen twice in one selection appears twice on the wire
 * and must not have both cards read from its first answer. A card the answer
 * does not mention is a failure — the request succeeded, so the file is not
 * where the user expects it, and a card that stayed in 上传中 would say the app
 * is still waiting for something that is never coming.
 *
 * The name compared is the one the request sent, not the one the browser held:
 * a file whose name carries path segments travels under its last segment, and
 * the answer can only name it that way. Matching the card's own `file.name`
 * left every such upload looking refused while its bytes were safely stored.
 */
export function mergeUpload(
  attachments: readonly Attachment[],
  sent: readonly string[],
  answer: UploadAnswer,
): Attachment[] {
  const pending = new Map<string, Array<{ error?: string; path?: string; status: string }>>();
  for (const entry of answer.uploaded) {
    const list = pending.get(entry.originalName) ?? [];
    list.push(entry);
    pending.set(entry.originalName, list);
  }
  const resolved = new Map<string, Pick<Attachment, "error" | "path" | "status">>();
  for (const id of sent) {
    const card = attachments.find((item) => item.id === id);
    if (card === undefined) continue;
    const name = uploadFileName(card.name) ?? card.name;
    const entry = pending.get(name)?.shift();
    const error = entry?.status === "failed" ? entry.error ?? answer.errors.find((item) => item.name === name)?.error : undefined;
    resolved.set(id, entry === undefined || entry.status === "failed"
      ? { error, status: "failed" }
      : { path: entry.path, status: "uploaded" });
  }
  return attachments.map((item) => {
    const outcome = resolved.get(item.id);
    return outcome === undefined ? item : { ...item, ...outcome };
  });
}

/** Mark a batch as failed, for the whole-request failure the route's own
 *  per-file answer cannot describe. */
export function failUpload(
  attachments: readonly Attachment[],
  sent: readonly string[],
  error: string,
): Attachment[] {
  const ids = new Set(sent);
  return attachments.map((item) => (ids.has(item.id) ? { ...item, error, status: "failed" } : item));
}

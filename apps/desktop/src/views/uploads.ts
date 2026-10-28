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

import type { ChatMessage, WorkspaceFile } from "../api/types.js";
import { fileName } from "../app/paths.js";

/** The families a file card paints. One icon per family, coloured the way the
 *  handoff colours them: PDF red, sheets green, documents blue, and so on. */
export type UploadKind =
  | "archive"
  | "audio"
  | "code"
  | "data"
  | "document"
  | "image"
  | "pdf"
  | "sheet"
  | "slides"
  | "text"
  | "unknown"
  | "video";

const KINDS: Readonly<Record<string, UploadKind>> = {
  "7z": "archive",
  aac: "audio",
  avi: "video",
  bash: "code",
  bib: "text",
  bmp: "image",
  bz2: "archive",
  c: "code",
  cfg: "text",
  cjs: "code",
  conf: "text",
  cpp: "code",
  css: "code",
  csv: "sheet",
  design: "text",
  doc: "document",
  docx: "document",
  flac: "audio",
  flv: "video",
  gif: "image",
  go: "code",
  gz: "archive",
  h: "code",
  heic: "image",
  hpp: "code",
  htm: "code",
  html: "code",
  ico: "image",
  ini: "text",
  ipynb: "code",
  java: "code",
  jpeg: "image",
  jpg: "image",
  js: "code",
  json: "data",
  jsonl: "data",
  jsx: "code",
  key: "slides",
  less: "code",
  log: "text",
  m4a: "audio",
  m4v: "video",
  markdown: "text",
  md: "text",
  mjs: "code",
  mkv: "video",
  mov: "video",
  mp3: "audio",
  mp4: "video",
  odp: "slides",
  ods: "sheet",
  odt: "document",
  ogg: "audio",
  pages: "document",
  pdf: "pdf",
  png: "image",
  pps: "slides",
  ppt: "slides",
  pptx: "slides",
  py: "code",
  r: "code",
  rar: "archive",
  rst: "text",
  rtf: "document",
  rs: "code",
  scss: "code",
  sh: "code",
  sql: "code",
  svg: "image",
  tar: "archive",
  tex: "text",
  tgz: "archive",
  tif: "image",
  tiff: "image",
  toml: "data",
  ts: "code",
  tsv: "sheet",
  tsx: "code",
  txt: "text",
  wav: "audio",
  webm: "video",
  webp: "image",
  wma: "audio",
  wmv: "video",
  xls: "sheet",
  xlsb: "sheet",
  xlsm: "sheet",
  xlsx: "sheet",
  xml: "data",
  xz: "archive",
  yaml: "data",
  yml: "data",
  zip: "archive",
  zsh: "code",
};

/** One uploaded file, as the transcript draws it. */
export interface UploadedFile {
  kind: UploadKind;
  name: string;
  path: string;
}

/** Where each upload belongs in the transcript. */
export interface UploadPlacement {
  /** Files to draw above one persisted message, keyed by that message's id. */
  byMessage: Map<string, UploadedFile[]>;
  /** Files uploaded since the last reader's turn: they belong to the question
   *  the reader is about to send, so the composer's own bubble carries them. */
  trailing: UploadedFile[];
}

/** The family a file name belongs to, by its extension. */
export function uploadKindOf(name: string): UploadKind {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "unknown";
  return KINDS[name.slice(dot + 1).toLowerCase()] ?? "unknown";
}

/**
 * A name split for the card: the stem is the line the reader scans, and the
 * extension is the quieter line under it. A dotfile keeps its whole name as
 * the stem — `.gitignore` has no extension to put below.
 */
export function splitFileName(name: string): { extension: string; stem: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { extension: "", stem: name };
  return { extension: name.slice(dot + 1).toLowerCase(), stem: name.slice(0, dot) };
}

function uploadedAt(file: WorkspaceFile): number {
  const at = Date.parse(file.provenance?.recordedAt ?? "");
  return Number.isNaN(at) ? 0 : at;
}

function messageAt(message: ChatMessage): number {
  const at = Date.parse(message.createdAt);
  return Number.isNaN(at) ? 0 : at;
}

function isFile(message: ChatMessage): boolean {
  return message.role === "user" && (message.kind === undefined || message.kind === "message");
}

/**
 * Which reader's turn each uploaded file belongs above.
 *
 * An upload is a workspace file whose provenance says it arrived by upload —
 * not a field on the message that carried it, because there is no such field.
 * Time is the link that does exist: the reader uploads, then asks. So a file
 * belongs above the first of their turns at or after the moment it was
 * recorded. A file uploaded after their last turn is waiting for the next one,
 * and the caller draws it above the pending bubble.
 *
 * The workspace lists what is there now, so an uploaded file the agent has
 * since rewritten no longer says `upload` and is not drawn: the card stands
 * for what the reader sent, and that file is no longer it.
 */
export function placeUploads(
  files: readonly WorkspaceFile[],
  messages: readonly ChatMessage[],
): UploadPlacement {
  const turns = messages.filter(isFile);
  const uploads = files
    .filter((file) => file.provenance?.origin === "upload")
    .sort((left, right) => uploadedAt(left) - uploadedAt(right));

  const byMessage = new Map<string, UploadedFile[]>();
  const trailing: UploadedFile[] = [];
  for (const file of uploads) {
    const name = fileName(file.path);
    const upload: UploadedFile = {
      kind: uploadKindOf(name),
      name,
      path: file.path,
    };
    const at = uploadedAt(file);
    const turn = turns.find((message) => messageAt(message) >= at);
    if (turn === undefined) {
      trailing.push(upload);
      continue;
    }
    const held = byMessage.get(turn.id);
    if (held === undefined) byMessage.set(turn.id, [upload]);
    else held.push(upload);
  }
  return { byMessage, trailing };
}

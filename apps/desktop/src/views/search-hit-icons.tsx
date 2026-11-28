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

import type { WorkbenchSearchResultKind } from "../api/types.js";

/** The kind of mark a hit's row carries. A Project is the column's folder, a
 *  Session a bubble, and an artifact the mark of the file it is — a suffix worth
 *  telling apart at a glance, and a plain page for everything else. */
export type HitIcon =
  | "bubble"
  | "code"
  | "doc"
  | "file"
  | "folder"
  | "image"
  | "json"
  | "sheet"
  | "slides";

const ICON_BY_SUFFIX: Record<string, HitIcon> = {
  avif: "image", bmp: "image", gif: "image", jpeg: "image", jpg: "image",
  png: "image", svg: "image", tif: "image", tiff: "image", webp: "image",
  c: "code", cc: "code", cpp: "code", cs: "code", css: "code", go: "code",
  h: "code", hpp: "code", java: "code", js: "code", jsx: "code", kt: "code",
  mjs: "code", php: "code", py: "code", rb: "code", rs: "code", sh: "code",
  ts: "code", tsx: "code",
  json: "json", jsonl: "json", toml: "json", yaml: "json", yml: "json",
  doc: "doc", docx: "doc", markdown: "doc", md: "doc", pdf: "doc", rst: "doc",
  rtf: "doc", tex: "doc", txt: "doc",
  csv: "sheet", ods: "sheet", tsv: "sheet", xls: "sheet", xlsx: "sheet",
  key: "slides", odp: "slides", ppt: "slides", pptx: "slides",
};

/** The mark for one hit: its kind, and for an artifact the file it is. */
export function hitIcon(kind: WorkbenchSearchResultKind, path?: string): HitIcon {
  if (kind === "project") return "folder";
  if (kind === "session") return "bubble";
  const name = (path ?? "").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "file";
  return ICON_BY_SUFFIX[name.slice(dot + 1).toLowerCase()] ?? "file";
}

/** The marks themselves. The folder is the column's own Project glyph, so a hit
 *  and the column read the same; the Session mark is drawn as a round bubble
 *  rather than a squared box, which is what a speech mark looks like at 15px. */
const PATHS: Record<HitIcon, string[]> = {
  folder: ["M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"],
  bubble: [
    "M12 4.6c4.7 0 8.5 2.9 8.5 6.5s-3.8 6.5-8.5 6.5S3.5 14.7 3.5 11.1 7.3 4.6 12 4.6z",
    "m7.9 16.9-1.3 3.2 4.6-1.8",
  ],
  file: [
    "M13.5 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V8z",
    "M13.5 3.5V8H18",
  ],
  doc: [
    "M13.5 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V8z",
    "M13.5 3.5V8H18",
    "M9 13h6",
    "M9 16.5h4",
  ],
  code: ["m9.5 8-4 4 4 4", "m14.5 8 4 4-4 4"],
  json: [
    "M10 4c-1.9 0-2.2 1.5-2.2 3v2.1c0 1.1-.6 1.7-1.8 1.9 1.2.2 1.8.8 1.8 1.9V15c0 1.5.3 3 2.2 3",
    "M14 4c1.9 0 2.2 1.5 2.2 3v2.1c0 1.1.6 1.7 1.8 1.9-1.2.2-1.8.8-1.8 1.9V15c0 1.5-.3 3-2.2 3",
  ],
  image: [
    "M4.5 4.5h15a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z",
    "m4 16.5 4.6-4.6 3.4 3 2.6-2.4 4.4 4",
  ],
  sheet: [
    "M4.5 4.5h15a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z",
    "M3.5 9.5h17",
    "M3.5 14.5h17",
    "M10.5 4.5v15",
  ],
  slides: [
    "M4.5 4.5h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z",
    "M12 16.5v3",
    "M9.5 19.5h5",
    "m10.5 8 4 2.5-4 2.5z",
  ],
};

/** The mark in front of a hit's name. */
export function SearchHitIcon({ kind, path, size = 15 }: {
  kind: WorkbenchSearchResultKind;
  path?: string;
  size?: number;
}) {
  return (
    <svg
      aria-hidden="true"
      className="search-hit-icon"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      {PATHS[hitIcon(kind, path)].map((d) => (
        <path d={d} key={d} />
      ))}
    </svg>
  );
}

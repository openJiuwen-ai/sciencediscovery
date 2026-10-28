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

import { useEffect, useRef, useState, type ReactNode } from "react";

import { TEXT } from "../text.js";
import { splitFileName, type UploadKind, type UploadedFile } from "./uploads.js";

/** How many cards the row draws before it folds the rest behind the count. */
const SHOWN = 2;

/** The handoff's palette, one colour per family: the colour is what makes a
 *  PDF distinguishable from a sheet at a glance in a row of cards. */
const TONES: Readonly<Record<UploadKind, string>> = {
  archive: "#715afb",
  audio: "#2cb8c9",
  code: "#14b8a6",
  data: "#f2a33c",
  document: "#1476ff",
  image: "#d41dbc",
  pdf: "#e02128",
  sheet: "#09aa71",
  slides: "#ff7737",
  text: "#8c8c8c",
  unknown: "#777777",
  video: "#62b42e",
};

const LINES = "M8.6 10.6h6.8M8.6 13.1h6.8M8.6 15.6h4.2";

const GLYPHS: Readonly<Record<UploadKind, ReactNode>> = {
  archive: <path d="M11 9.6h2M11 11.8h2M11 14h2M12 16.2v1.6" />,
  audio: (
    <>
      <path d="M10.4 16.4v-5.2l4.8-1.2v5.3" />
      <circle cx="9.4" cy="16.8" r="1.1" />
      <circle cx="14.2" cy="15.6" r="1.1" />
    </>
  ),
  code: <path d="M10.3 10.7 8.1 13l2.2 2.3M13.7 10.7 15.9 13l-2.2 2.3M12.7 9.9l-1.4 6.2" />,
  data: <path d="M10.4 9.7c-1.5 0-1.5 1.2-1.5 3.3s0 3.3-1.5 3.3M13.6 9.7c1.5 0 1.5 1.2 1.5 3.3s0 3.3 1.5 3.3" />,
  document: <path d={LINES} />,
  image: (
    <>
      <circle cx="10" cy="11.2" r="1.1" />
      <path d="M8.5 17l2.9-3.3 1.8 1.9 1.3-1.5 1.7 2.9" />
    </>
  ),
  pdf: <path d={LINES} />,
  sheet: (
    <>
      <path d="M8.6 10.6h6.8v6.8H8.6z" />
      <path d="M8.6 13.2h6.8M12 10.6v6.8" />
    </>
  ),
  slides: <path d="M8.8 16.8v-2.9M12 16.8v-6.1M15.2 16.8v-4.3" />,
  text: <path d={LINES} />,
  unknown: (
    <>
      <path d="M10.3 11.2a1.8 1.8 0 1 1 2.8 1.6c-.7.5-1.1.9-1.1 1.7" />
      <circle cx="12" cy="17" r=".8" fill="#fff" stroke="none" />
    </>
  ),
  video: <path d="M10.4 10.4 15 13l-4.6 2.6z" />,
};

/** The page icon: one shape in the family's colour, a folded corner, and a
 *  white mark that says which family it is. */
function FileGlyph({ kind, size }: { kind: UploadKind; size: number }) {
  return (
    <svg aria-hidden="true" className="upload-glyph" height={size} viewBox="0 0 24 24" width={size}>
      <path
        d="M22 7.35V21a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V3a3 3 0 0 1 3-3h9.93c.27 0 .53.1.72.29l5.07 4.94c.18.18.28.43.28.72Z"
        fill={TONES[kind]}
      />
      <path d="M15.34 0 22 6.5h-4.66a2 2 0 0 1-2-2V0Z" fill="#fff" fillOpacity=".55" />
      <g fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4">
        {GLYPHS[kind]}
      </g>
    </svg>
  );
}

interface Props {
  files: readonly UploadedFile[];
}

/**
 * The files the reader sent with a question, above its bubble.
 *
 * Two cards are enough to recognise what was attached; a third would push the
 * question itself down the transcript. The rest are still reachable: the count
 * card opens the list, and the full name (which a card can only ellipsize) is
 * there in one line.
 */
export function UploadCards({ files }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (root.current !== null && target instanceof Node && !root.current.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const shown = files.slice(0, SHOWN);
  const rest = files.slice(SHOWN);
  // The row's width is its own, not the sum the layout engine happens to
  // derive: an intrinsic width would let the two cards shrink against a flex
  // container's guess at their content and stop at neither 207 nor the
  // handoff's proportions.
  const sizing = `is-${shown.length === 1 ? "one" : "two"}${rest.length === 0 ? "" : " has-more"}`;

  return (
    <div className={`upload-cards ${sizing}`} ref={root}>
      {shown.map((file) => {
        const { extension, stem } = splitFileName(file.name);
        return (
          <div className="upload-card" key={file.path} title={file.name}>
            <FileGlyph kind={file.kind} size={32} />
            <div className="upload-card-text">
              <strong>{stem}</strong>
              {extension === "" ? null : <small>{extension}</small>}
            </div>
          </div>
        );
      })}
      {rest.length === 0 ? null : (
        <div className="upload-more">
          <button
            aria-expanded={open}
            aria-label={TEXT.conversation.uploads.more(rest.length)}
            className="upload-more-button"
            onClick={() => setOpen(!open)}
            type="button"
          >
            +{rest.length}
          </button>
          {open ? (
            <div
              aria-label={TEXT.conversation.uploads.rest}
              className="upload-more-list"
              role="list"
            >
              {rest.map((file) => (
                <div className="upload-more-row" key={file.path} role="listitem" title={file.name}>
                  <FileGlyph kind={file.kind} size={16} />
                  <span>{file.name}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

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

/** The disclosure chevron on a folder row, drawn rather than typed: a glyph
 *  from the font sits off the row's centre line. */
export function CaretGlyph({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="skill-tree-caret-glyph"
      fill="none"
      height="12"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="12"
    >
      {open ? <path d="m6 15 6-6 6 6" /> : <path d="m9 6 6 6-6 6" />}
    </svg>
  );
}

export function NodeGlyph({ folder, open }: { folder: boolean; open?: boolean }) {
  if (!folder) {
    return (
      <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" viewBox="0 0 24 24" width="16">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
        <path d="M14 3v5h5" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" viewBox="0 0 24 24" width="16">
      {open
        ? <path d="M3 8a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        : <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />}
    </svg>
  );
}

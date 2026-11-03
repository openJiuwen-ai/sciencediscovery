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

/** The mark of the evolve surface: a root that branches into trials and keeps
 *  the branch that scored best. Drawn here rather than imported because it is
 *  the only icon of its kind in the app. */
export function EvolveGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <circle cx="12" cy="4.6" r="2.1" />
      <circle cx="6.2" cy="13" r="2.1" />
      <circle cx="17.8" cy="13" r="2.1" />
      <circle cx="12" cy="20" r="2.1" />
      <path d="M10.7 6.5 7.5 11.1M13.3 6.5l3.2 4.6M7.4 14.8l3.2 3.3M16.6 14.8l-3.2 3.3" />
    </svg>
  );
}

/** The plus in the shelf's 新建实验 button. */
export function PlusGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24" width="14">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** The magnifier in the candidate filter. */
export function SearchGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" viewBox="0 0 24 24" width="14">
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 4.5 4.5" />
    </svg>
  );
}

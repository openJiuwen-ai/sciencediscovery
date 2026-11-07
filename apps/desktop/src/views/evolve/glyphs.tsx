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

/** The tree on the seeded command token: one root above three trials, with the
 *  sibling edge the reference draws between the first two. Small enough that
 *  the circles read as nodes rather than counters, so the stroke is heavier
 *  than the surface mark above. */
export function EvolveTreeGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.2"
      viewBox="0 0 24 24"
      width={size}
    >
      <circle cx="12" cy="5" r="2.9" />
      <circle cx="4" cy="18.6" r="2.9" />
      <circle cx="12" cy="19.2" r="2.9" />
      <circle cx="20" cy="18.6" r="2.9" />
      <path d="M10.3 7.5 5.6 16M13.7 7.5l4.4 8.5M12 7.9v8.4M6.9 18.6h2.2" />
    </svg>
  );
}

/** The crown that marks the best node: on the tree, on the row, in the drawer
 *  header and as the chart's legend key. Solid rather than stroked, because at
 *  ten pixels a line-art crown reads as a smudge. The shape is the handoff's:
 *  two side knobs at the top corners, a narrow neck under the ball, and a body
 *  that tapers to a flat foot. */
export function CrownGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <path
        d="M2.8 10.9C2.6 9.9 3 9.05 3.9 9.05 4.8 9.05 5.2 9.7 5.3 10.35 6.4 10.75 7.6 10.75 8.7 10.45L10.8 10.3 10.8 8.6 13.2 8.6 13.2 10.3 15.3 10.45 16.4 10.75 17.6 10.75 18.7 10.35 18.8 9.7 19.2 9.05 20.1 9.05 21 9.05 21.4 9.9 21.2 10.9 16.1 19.5Q12 20.35 7.9 19.5Z"
        fill="currentColor"
      />
      <circle cx="12" cy="6.6" fill="currentColor" r="2.05" />
    </svg>
  );
}

/** The trophy on the best node's score tile. */
export function TrophyGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" />
      <path d="M8 6H5v1.6A3.4 3.4 0 0 0 8.4 11M16 6h3v1.6A3.4 3.4 0 0 1 15.6 11M12 13v4M8.6 20h6.8M9.8 17h4.4l.8 3H9l.8-3Z" />
    </svg>
  );
}

/** The child count tile: one node branching into two. */
export function ChildrenGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
      width={size}
    >
      <circle cx="12" cy="5" r="2.6" />
      <circle cx="6" cy="19" r="2.6" />
      <circle cx="18" cy="19" r="2.6" />
      <path d="M10.4 7.2 7.4 16.5M13.6 7.2l3 9.3" />
    </svg>
  );
}

/** Open the source in its own window. */
export function ExpandGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      <path d="M9 9 4 4M15 9l5-5M9 15l-5 5M15 15l5 5" />
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

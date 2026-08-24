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
 * A line diff, because the winning program is usually its parent plus an idea.
 *
 * Written here rather than pulled in: it is one LCS table over a few hundred
 * lines of Python, it has to run in a browser tab that already carries a 4.6MB
 * chart bundle for something else, and a diff library's line-level output would
 * need reshaping into these rows anyway.
 *
 * Longest common subsequence rather than a naive line-by-line walk: a candidate
 * that inserts three lines at the top would otherwise show as "everything
 * changed", which is exactly the reading the diff exists to prevent.
 */

export type DiffKind = "added" | "context" | "removed";

export interface DiffRow {
  kind: DiffKind;
  /** 1-based, and absent on the side a row does not exist in. */
  leftLine?: number;
  rightLine?: number;
  text: string;
}

/** Above this the table is built but the quadratic part is skipped: a pair of
 *  20k-character programs is ~600 lines a side, and the cap is the point at
 *  which an LCS stops being free on the UI thread. */
const MAX_LINES = 3_000;

export function diffLines(before: string, after: string): DiffRow[] {
  const left = before.length ? before.split("\n") : [];
  const right = after.length ? after.split("\n") : [];

  if (left.length > MAX_LINES || right.length > MAX_LINES) {
    // Degrading to "all removed, all added" rather than freezing the tab. It is
    // a worse diff and it is honest about being one.
    return [
      ...left.map((text, at) => ({ kind: "removed" as const, leftLine: at + 1, text })),
      ...right.map((text, at) => ({ kind: "added" as const, rightLine: at + 1, text })),
    ];
  }

  // `lcs[i][j]` is the length of the longest common subsequence of `left[i:]`
  // and `right[j:]`, so the walk below can be greedy from the front.
  const lcs: number[][] = Array.from(
    { length: left.length + 1 },
    () => new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = left[i] === right[j]
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      rows.push({ kind: "context", leftLine: i + 1, rightLine: j + 1, text: left[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ kind: "removed", leftLine: i + 1, text: left[i]! });
      i += 1;
    } else {
      rows.push({ kind: "added", rightLine: j + 1, text: right[j]! });
      j += 1;
    }
  }
  for (; i < left.length; i += 1) rows.push({ kind: "removed", leftLine: i + 1, text: left[i]! });
  for (; j < right.length; j += 1) rows.push({ kind: "added", rightLine: j + 1, text: right[j]! });
  return rows;
}

/**
 * Drop long stretches of unchanged lines, keeping `context` around each change.
 *
 * The reason the detail view shows a diff at all is that a winning program
 * grows from a few hundred characters to a few thousand: without collapsing,
 * the change is three lines somewhere inside two screens of identical code.
 * Returns the rows to draw plus how many were hidden, because a fold that does
 * not say how much it hid is indistinguishable from a short file.
 */
export function collapseContext(rows: readonly DiffRow[], context = 3): {
  hidden: number;
  rows: DiffRow[];
} {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, at) => {
    if (row.kind === "context") return;
    for (let near = Math.max(0, at - context); near <= Math.min(rows.length - 1, at + context); near += 1) {
      keep[near] = true;
    }
  });
  const kept = rows.filter((_row, at) => keep[at]);
  return { hidden: rows.length - kept.length, rows: kept };
}

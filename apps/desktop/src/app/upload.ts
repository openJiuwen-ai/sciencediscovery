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
 * The parts of uploading that are decisions rather than plumbing, kept out of
 * the components so they can be tested: this repository's test environment has
 * no DOM, so anything that reads a `DataTransfer` or a rendered node is out of
 * reach. What is left here is what the upload actually depends on — which files
 * are small enough, and whether a drag is carrying files at all.
 */

/** What the app assumes when `GET /api/health` cannot be read — the route's own
 *  compiled-in default (1 GiB). Guessing high is the safe direction: a file the
 *  server refuses comes back as a per-file error the user can read, while
 *  refusing locally on a guess the server would have accepted is a dead end
 *  with no way around it. */
export const DEFAULT_MAX_FILE_BYTES = 1_073_741_824;

/** The ladder the limit is written in: a limit is a round number to compare a
 *  file against, so it is stated the way it is configured (`1 GiB`) rather than
 *  to one decimal the way a file's own size is (`1.0 GiB`).
 *
 *  `undefined` for a non-positive limit, which the server reads as "no limit";
 *  wording that is the caller's, because every user-visible string in this app
 *  lives in `src/text.ts`. */
export function formatByteLimit(bytes: number): string | undefined {
  if (bytes <= 0) return undefined;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Number.isInteger(value) ? value : Number(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
}

/**
 * Split a selection into what can be sent and what the route would refuse.
 *
 * A limit of `0` means no limit — that is how the server reads its own quota, so
 * filtering everything out against it would refuse every file on a machine
 * configured for no limit at all. The two lists keep the selection's order, so
 * the files the user picked first are the ones uploaded first.
 */
export function splitBySize<T extends { name: string; size: number }>(
  files: readonly T[],
  maxFileBytes: number,
): { accepted: T[]; oversized: T[] } {
  if (maxFileBytes <= 0) return { accepted: [...files], oversized: [] };
  const accepted: T[] = [];
  const oversized: T[] = [];
  for (const file of files) {
    if (file.size > maxFileBytes) oversized.push(file);
    else accepted.push(file);
  }
  return { accepted, oversized };
}

/**
 * Whether a drag is carrying files, which is the only kind this app takes.
 *
 * A drag of selected text also fires `dragenter`/`dragover` on the window, so
 * without this test the whole shell would announce an upload for a drag that
 * could never produce one. `types` is a `DOMStringList`-like live list, hence
 * the read rather than a spread by the caller.
 */
export function carriesFiles(types: readonly string[]): boolean {
  return types.includes("Files");
}

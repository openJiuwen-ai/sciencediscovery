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
 * The last segment of a workspace path.
 *
 * Artifact names are relative paths (`antibody_pipeline/runs/foo.csv`), and a
 * panel column is too narrow to show them: what the reader needs is which
 * artifact this is, and the directory is the same for every row of a run. The
 * full path stays available — as the row's tooltip, or as the `<small>` under
 * the title once the document is open — so nothing is lost by shortening the
 * label.
 *
 * Trailing slashes are ignored, and a path that is empty or nothing but
 * separators is returned unchanged rather than becoming the empty string.
 */
export function fileName(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.at(-1) ?? path;
}

/**
 * The folder a workspace path lives in, by name, or "" when it has none.
 *
 * Two artifacts can carry the same file name — a subagent writes `trace.md`
 * into its own workspace and the next one writes another — and the last
 * segment alone cannot tell them apart. The containing folder is what does, so
 * it is shown beside the name whenever the names collide. Only the nearest
 * folder is named: the path above it (`subagents/`) is shared, and a truncated
 * prefix would hide the part that differs.
 */
export function fileFolder(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.length < 2 ? "" : segments.at(-2)!;
}

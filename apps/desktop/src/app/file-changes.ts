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

import type { WorkspaceFile } from "../api/types.js";

/** What says a file's bytes changed: the listing already carries both, so a
 *  refresh compares them instead of reading every file back. */
function fingerprint(file: WorkspaceFile): string {
  return `${file.size}:${file.modifiedAt}`;
}

/**
 * The files a run wrote since the panel last listed the workspace.
 *
 * A file the listing had not shown before counts as changed: a document the
 * user already has open under that path — an uploaded file replaced by the
 * run, a report rewritten in place — must show what is there now, and the
 * first listing after opening a Session is the only chance to tell. Files
 * that disappeared are not reported: the tree drops them, and an open tab of
 * a file that is gone keeps the text it was read from.
 */
export function changedFiles(
  previous: readonly WorkspaceFile[],
  next: readonly WorkspaceFile[],
): WorkspaceFile[] {
  const before = new Map(previous.map((file) => [file.path, fingerprint(file)]));
  return next.filter((file) => before.get(file.path) !== fingerprint(file));
}

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
 * OS adaptation surface for packages/cas (platform facade convention).
 * Consumers import only index.ts; platform files are never imported directly.
 */
export interface OsAdaptation {
  /**
   * Persist a directory's entries (fsync the directory handle). POSIX only:
   * Windows cannot fsync a directory handle (EPERM) and NTFS has no
   * equivalent durability API, so the win32 implementation is a deliberate
   * no-op — file-level syncs and the atomic link/rename above it still hold.
   */
  syncDirectory(path: string): Promise<void>;

  /**
   * Lock/coordination file basename for a workspace key. Windows MAX_PATH (260)
   * leaves no room for a 64-hex sha256 digest under deep dataDir layouts: the
   * SQLite rollback journal ("-journal", +8 chars) overruns the limit and
   * BEGIN IMMEDIATE fails with SQLITE_CANTOPEN. 128 bits of sha256 stays
   * collision-safe for machine-local lock names; win32 shortens to 128 bits
   * while posix keeps the historical full-length name (compatibility with
   * existing coordination files).
   */
  lockFileName(key: string): string;
}

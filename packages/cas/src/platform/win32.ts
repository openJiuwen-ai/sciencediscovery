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

import { createHash } from "node:crypto";

import type { OsAdaptation } from "./types.js";

/**
 * Windows cannot fsync a directory handle (FlushFileBuffers on a directory
 * fails with ERROR_ACCESS_DENIED → EPERM), and NTFS offers no
 * directory-durability equivalent. The file-level sync and atomic publish
 * (link/rename) above still provide crash consistency for the object bytes;
 * the directory entry flush is best-effort on POSIX and intentionally absent
 * here — matching what other cross-platform stores (e.g. Git on Windows) do.
 */
export const win32Adaptation: OsAdaptation = {
  syncDirectory(_path) {
    return Promise.resolve();
  },
  // Keep the lock basename short enough that path + "-journal"
  // stays under MAX_PATH (260) for realistic dataDir layouts.
  lockFileName(key) {
    return createHash("sha256").update(key).digest("hex").slice(0, 32);
  },
};

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
 * Write-to-temp-then-rename, including the part Windows needs.
 *
 * Every record this server owns is written this way so a crash leaves either
 * the old file or the new one, never half of one. On POSIX the rename is a
 * single syscall that cannot fail because someone is reading the target. On
 * Windows it can: `MoveFileEx` refuses (EPERM, once in a while EACCES or
 * EBUSY) while another handle has the destination open without delete sharing,
 * and a freshly created temp file is exactly what a virus scanner or the search
 * indexer opens. That handle is gone a few milliseconds later, so the supported
 * answer is to try again rather than to fail a run over it.
 *
 * Real failures — a full disk, a read-only volume, a path that is not there —
 * carry their own code and are not in the retry set, so they still surface as
 * themselves and immediately.
 */

import { rename as renameFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** The errors a Windows rename raises while a transient handle holds the file.
 *  Deliberately not every code: retrying `ENOSPC` only makes the caller wait
 *  a second for the same answer. */
const TRANSIENT = new Set(["EACCES", "EBUSY", "EPERM"]);

/** Ten attempts, 1 + 2 + 4 + … + 512 ms. A scanner's grip is milliseconds; a
 *  person's patience with a save is well over a second. */
const ATTEMPTS = 10;

export type Rename = (from: string, to: string) => Promise<void>;

/** Test seams: a real rename, and a real timer, unless a test says otherwise. */
export interface ReplaceFileOptions {
  rename?: Rename;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

/** Replace `to` with `from`, retrying a rename that Windows refused transiently. */
export async function replaceFile(
  from: string,
  to: string,
  options: ReplaceFileOptions = {},
): Promise<void> {
  const rename = options.rename ?? renameFile;
  const sleep = options.sleep ?? delay;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !TRANSIENT.has(code) || attempt >= ATTEMPTS) throw error;
      await sleep(2 ** attempt);
    }
  }
}

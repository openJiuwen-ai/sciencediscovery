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

import { rename } from "node:fs/promises";

/**
 * Errnos a replace reports while another handle briefly owns the freshly
 * written file. Windows has the widest window — an antivirus scanner, a search
 * indexer or a backup agent opens the new file between `writeFile` and the
 * `MoveFileEx`-backed rename — and reports `EPERM`/`EBUSY` there. `EACCES` is
 * kept deliberately even though on POSIX it often means a lasting permission
 * problem: an SMB or NFS share returns it transiently while another client
 * holds the file, and waiting is exactly what heals that case. A genuinely
 * unwritable directory therefore pays the full patience below before failing,
 * which is the trade this list makes on purpose.
 */
const TRANSIENT_REPLACE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * 20 attempts with the backoff below spend ~5.2 s of patience (19 waits:
 * `19 × 50 ms + 25 ms × (0 + … + 18) = 5,225 ms`), far longer than the
 * tens-of-milliseconds window those holders keep.
 */
export const REPLACE_ATTEMPTS = 20;

export type RenameFile = (source: string, destination: string) => Promise<void>;

export interface ReplaceFileOptions {
  /** The rename primitive; production passes the platform adaptation. */
  renameFile?: RenameFile;
  attempts?: number;
  /** Delay before retry number `attempt` (0-based). */
  delayMs?: (attempt: number) => number;
}

/**
 * A replace that exhausted its retries. It keeps the errno in `code` and the
 * last failure in `cause` so a caller can classify the loss (a locked file
 * versus a full disk) instead of parsing the message.
 */
export class FileReplaceError extends Error {
  constructor(
    readonly destination: string,
    readonly attempts: number,
    readonly code: string | undefined,
    cause: unknown,
  ) {
    super(`Could not replace ${destination} after ${attempts} attempts${code ? ` (${code})` : ""}`, { cause });
    this.name = "FileReplaceError";
  }
}

/**
 * Replace `destination` with `source` atomically, retrying the transient
 * sharing violations a bare rename rejects with. A non-transient failure (a
 * missing directory, a full disk) is thrown unchanged on the first attempt:
 * waiting cannot heal it.
 */
export async function replaceFile(
  source: string,
  destination: string,
  options: ReplaceFileOptions = {},
): Promise<void> {
  const renameFile = options.renameFile ?? rename;
  const attempts = Math.max(1, options.attempts ?? REPLACE_ATTEMPTS);
  const delayMs = options.delayMs ?? ((attempt: number) => 50 + attempt * 25);
  let lastCode: string | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_REPLACE_CODES.has(code)) throw error;
      lastCode = code;
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs(attempt)));
    }
  }
  throw new FileReplaceError(destination, attempts, lastCode, lastError);
}

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
 * Errnos a replace retries because another handle briefly owns the freshly
 * written file.
 *
 * Windows has the widest window — an antivirus scanner, a search indexer or a
 * backup agent opens the new file between `writeFile` and the
 * `MoveFileEx`-backed rename — and its redirector reports all three of
 * `EPERM`/`EACCES`/`EBUSY` for that same hold.
 *
 * POSIX keeps only `EPERM` and `EBUSY`: an `EACCES` there is a lasting
 * mode/ownership problem (the parent directory is not writable for this uid),
 * and waiting cannot heal it. That matters beyond correctness: `writeArray` is
 * on the chat run path, so retrying a permanent `EACCES` would add 5.2 s to
 * every state write of an already-unwritable store instead of failing at once.
 */
export function transientReplaceCodes(platform: NodeJS.Platform = process.platform): ReadonlySet<string> {
  return platform === "win32"
    ? new Set(["EPERM", "EACCES", "EBUSY"])
    : new Set(["EPERM", "EBUSY"]);
}

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
  /** Override the retried errno set; defaults to `transientReplaceCodes()`. */
  transientCodes?: ReadonlySet<string>;
}

/**
 * A replace that exhausted its retries. It keeps the errno in `code` and the
 * last failure in `cause` so a caller can classify the loss (a locked file
 * versus a full disk) instead of parsing the message.
 *
 * The OS-level fields of the last failure are copied out as well: a caller that
 * classified state-write failures by `errno`/`syscall`/`path`/`dest` keeps
 * working when the retries are exhausted, instead of losing them because the
 * thrown value is no longer the original `SystemError`. `cause` still holds
 * that original, so `instanceof`-style checks on it remain exact.
 */
export class FileReplaceError extends Error {
  readonly errno: number | string | undefined;
  readonly syscall: string | undefined;
  readonly path: string | undefined;
  readonly dest: string | undefined;
  constructor(
    readonly destination: string,
    readonly attempts: number,
    readonly code: string | undefined,
    cause: unknown,
  ) {
    super(`Could not replace ${destination} after ${attempts} attempts${code ? ` (${code})` : ""}`, { cause });
    this.name = "FileReplaceError";
    const failure = cause as (NodeJS.ErrnoException & { dest?: string }) | undefined;
    this.errno = failure?.errno;
    this.syscall = failure?.syscall;
    this.path = failure?.path;
    this.dest = failure?.dest;
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
  const transient = options.transientCodes ?? transientReplaceCodes();
  let lastCode: string | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !transient.has(code)) throw error;
      lastCode = code;
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs(attempt)));
    }
  }
  throw new FileReplaceError(destination, attempts, lastCode, lastError);
}

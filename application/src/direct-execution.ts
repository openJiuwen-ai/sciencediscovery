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
 * Shell-owned opt-in for direct (unsandboxed) candidate execution on macOS.
 *
 * [mac-direct] The installation-level switch of the same two-door contract
 * Windows already runs: the desktop sets it here (设置 › 连接 › 沙箱网络), the shell
 * injects SCIENCE_AGENT_EVOLVE_UNISOLATED into every stack spawn when it is
 * on, and the evolve API still refuses any run whose goal does not carry the
 * user's per-run confirmation (`--allow-direct`) — that second door lives in
 * pre-flight and needs no shell support.
 *
 * Storage follows the shell-locale precedent: one tiny file under userData
 * ("direct-execution", contents "1" for on, anything else/missing for off),
 * best-effort reads and writes, no schema. It is a shell-owned preference, so
 * the service never sees the file — only the env flag it implies. A change
 * applies on the NEXT stack spawn: the running stack keeps its provider until
 * then, and the settings row says so.
 *
 * The default stays OFF everywhere: a fresh install answers false, and only
 * an explicit user action ever turns it on. On win32 the flag is not a
 * preference at all (the shell always sets it — there is no sandbox to
 * decline), so this module is consulted on darwin only; keeping it read-gated
 * by the caller rather than by the platform makes the win32 path impossible
 * to reach by accident while leaving the pure functions testable everywhere.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The userData-relative file name. Sits beside the `locale` file. */
export const DIRECT_EXECUTION_FILE = "direct-execution";

/** Pure parse: file contents → the switch state. Anything but an exact "1"
 *  is OFF — a truncated or hand-edited file must never read as opted-in. */
export function parseDirectExecutionFlag(raw: string | null): boolean {
  return raw === "1";
}

/** Pure render: the switch state → what the file holds. */
export function renderDirectExecutionFlag(on: boolean): string {
  return on ? "1" : "";
}

/** Read the persisted switch. Missing/unreadable file = OFF (fail-closed:
 *  the sandboxed default never depends on a file we failed to read). */
export function readDirectExecution(userDataDir: string): boolean {
  try {
    return parseDirectExecutionFlag(readFileSync(join(userDataDir, DIRECT_EXECUTION_FILE), "utf8").trim());
  } catch {
    return false;
  }
}

/** Persist the switch, best-effort. A failed write logs nothing here — the
 *  caller re-reads to confirm, and the IPC reply carries the observed value
 *  so a silent write failure surfaces as "the toggle bounced back" rather
 *  than a stale switch the next spawn does not honour. */
export function writeDirectExecution(userDataDir: string, on: boolean): boolean {
  try {
    writeFileSync(join(userDataDir, DIRECT_EXECUTION_FILE), renderDirectExecutionFlag(on), "utf8");
  } catch {
    // fall through: the re-read below reports the truth
  }
  return readDirectExecution(userDataDir);
}

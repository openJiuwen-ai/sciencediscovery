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
 * The `/evolve-design` command's flags, read on the server.
 *
 * `allowUnisolated` is a tool argument, and a tool argument is the model's
 * word: on a Windows install, where the process opts into direct candidate
 * execution, any text the model read while designing — the goal, a dataset
 * row, a file — could make it set the field, and a model mistake could do it
 * on its own. The command the user's client put in the turn is the record
 * that the user answered the warning, so that is what the server reads.
 *
 * This mirrors `apps/desktop/src/evolve/command.ts`: flags are the leading
 * run after the command, across spaces and tabs only. A goal that itself
 * begins with `--` follows a line break, and the break ends the run.
 */

const COMMAND = "/evolve-design";

const LEADING_FLAGS = /^[ \t]*(?:--(?:algorithm[ \t]+(?:puct|openevolve)|no-confirm|allow-direct)\b[ \t]*)+/;

/** Whether this text is a `/evolve-design` command at the start of a message. */
export function isEvolveCommand(content: string): boolean {
  return new RegExp(`^${COMMAND}(?:\\s|$)`).test(content.trim());
}

/** The leading run of flags, as written after `/evolve-design`. */
function leadingFlags(content: string): string {
  if (!isEvolveCommand(content)) return "";
  const text = content.trim();
  return text.slice(COMMAND.length).match(LEADING_FLAGS)?.[0] ?? "";
}

/** Whether this text is a `/evolve-design` command that carried
 *  `--allow-direct` — the client wrote it when the user turned on the
 *  no-isolation warning, or the user typed it themselves.
 *
 *  A goal that merely mentions the flag keeps it as text and does not count:
 *  only the command's own leading run is a flag. */
export function evolveCommandApprovesUnisolated(content: string): boolean {
  return /--allow-direct\b/.test(leadingFlags(content));
}

/** Whether the latest `/evolve-design` command in a session approved direct
 *  execution.
 *
 *  The latest command is the one the run belongs to: a second design started
 *  with a plain `/evolve-design` inherits nothing from an earlier yes. A
 *  checkpoint answer does not move the anchor, because it is not a command —
 *  so the design this run was created under is still the latest one there. */
export function latestEvolveCommandApprovesUnisolated(
  messages: readonly { role: string; content: string }[],
): boolean {
  const latest = messages.findLast(
    (message) => message.role === "user" && isEvolveCommand(message.content),
  );
  return latest !== undefined && evolveCommandApprovesUnisolated(latest.content);
}

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
 * The one command the evolve surface puts in the composer.
 *
 * The search is not started by a form on the client: the agent designs the
 * scorecard in conversation, checks that it can rank, and only then creates
 * the run. So "新建实验" is a shortcut into that conversation, not a second
 * way of starting a search.
 *
 * The command also carries the choices the dialog collects: which search,
 * whether the design pauses at its checkpoints, and — on Windows, where there
 * is no sandbox — that the user accepted candidates running unconfined. All
 * are flags the agent reads, not fields on a request — the conversation is
 * still what designs the run.
 */

import type { EvolveAlgorithm, EvolveCheckpointMode } from "@sciencediscovery/schema";

export const EVOLVE_COMMAND = "/evolve-design";

/** The skill the command names, as `/api/skills` reports it. Picking it from
 *  the composer's palette opens the setup dialog rather than writing a bare
 *  command: the two choices that dialog collects are exactly the command's
 *  flags, and typing them by hand is the part nobody should have to learn. */
export const EVOLVE_SKILL_ID = "evolve-design";

export function isEvolveSkill(skill: { id: string }): boolean {
  return skill.id === EVOLVE_SKILL_ID;
}

/** The flags the surface may put after the command, in any order. Only the
 *  leading run of them is consumed: a goal that happens to start with a dash
 *  keeps its own text. */
const LEADING_FLAGS = /^(?:\s*--(?:algorithm\s+(?:puct|openevolve)|no-confirm|allow-direct)\b)+/;

export function isEvolveCommand(text: string): boolean {
  return new RegExp(`^${EVOLVE_COMMAND}(?:\\s|$)`).test(text.trim());
}

function afterCommand(text: string): string {
  return text.trim().slice(EVOLVE_COMMAND.length);
}

/** What the user typed after the command, without its flags.
 *
 *  A draft that was typed directly has to survive the setup detour: if the
 *  runtime is not installed, the dialog opens with this sentence already in
 *  its goal field rather than asking the user to write it twice. */
export function evolveCommandGoal(text: string): string | undefined {
  if (!isEvolveCommand(text)) return undefined;
  return afterCommand(text).replace(LEADING_FLAGS, "").trim();
}

/** Whether the design pauses at each checkpoint, as the command says.
 *
 *  Read here so the setup detour keeps the choice: a command typed with
 *  `--no-confirm` opens the dialog with the switch already off, rather than
 *  quietly putting it back on. */
export function evolveCommandCheckpointMode(text: string): EvolveCheckpointMode | undefined {
  if (!isEvolveCommand(text)) return undefined;
  return /(^|\s)--no-confirm\b/.test(afterCommand(text)) ? "auto" : "confirm";
}

/** Whether the command already carries the user's approval to run candidates
 *  without a sandbox.
 *
 *  Only Windows needs it, and the dialog is what writes it — reading it back
 *  keeps a setup detour from silently dropping an approval the user gave. */
export function evolveCommandAllowUnisolated(text: string): boolean | undefined {
  if (!isEvolveCommand(text)) return undefined;
  return /(^|\s)--allow-direct\b/.test(afterCommand(text));
}

/** The message that starts the design conversation. */
export function evolveCommand(
  algorithm: EvolveAlgorithm,
  goal: string,
  checkpointMode: EvolveCheckpointMode = "confirm",
  allowUnisolated = false,
): string {
  const flags = `${EVOLVE_COMMAND} --algorithm ${algorithm}`
    + (checkpointMode === "auto" ? " --no-confirm" : "")
    + (allowUnisolated ? " --allow-direct" : "");
  return `${flags} ${goal.trim()}`.trimEnd();
}

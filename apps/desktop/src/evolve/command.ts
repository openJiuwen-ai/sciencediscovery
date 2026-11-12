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
 *  leading run of them is consumed, and only across spaces and tabs: a goal
 *  that itself begins with a flag is introduced by a line break, so the break
 *  — not the dash — is what ends the flags. A goal that merely mentions a
 *  flag keeps its own text. */
const LEADING_FLAGS = /^[ \t]*(?:--(?:algorithm[ \t]+(?:puct|openevolve)|no-confirm|allow-direct)\b[ \t]*)+/;

export function isEvolveCommand(text: string): boolean {
  return new RegExp(`^${EVOLVE_COMMAND}(?:\\s|$)`).test(text.trim());
}

function afterCommand(text: string): string {
  return text.trim().slice(EVOLVE_COMMAND.length);
}

/** The command's own flags: its leading run, before the goal. */
function leadingFlags(text: string): string {
  return afterCommand(text).match(LEADING_FLAGS)?.[0] ?? "";
}

/** What the user typed after the command, without its flags.
 *
 *  A draft that was typed directly has to survive the setup detour: if the
 *  runtime is not installed, the dialog opens with this sentence already in
 *  its goal field rather than asking the user to write it twice. */
export function evolveCommandGoal(text: string): string | undefined {
  if (!isEvolveCommand(text)) return undefined;
  return afterCommand(text).slice(leadingFlags(text).length).trim();
}

/** The task a composer draft carries into the setup dialog.
 *
 *  A command contributes the sentence after its flags. Any other draft that is
 *  not a slash command is a sentence the person wrote before opening the
 *  surface, and it becomes the task rather than being thrown away. A bare
 *  slash query is a palette pick, not a task. */
export function evolveDraftTask(text: string): string | undefined {
  const goal = evolveCommandGoal(text);
  if (goal !== undefined) return goal === "" ? undefined : goal;
  const draft = text.trim();
  if (draft === "" || draft.startsWith("/")) return undefined;
  return draft;
}

/** Whether the design pauses at each checkpoint, as the command says.
 *
 *  Read here so the setup detour keeps the choice: a command typed with
 *  `--no-confirm` opens the dialog with the switch already off, rather than
 *  quietly putting it back on. */
export function evolveCommandCheckpointMode(text: string): EvolveCheckpointMode | undefined {
  if (!isEvolveCommand(text)) return undefined;
  return /--no-confirm\b/.test(leadingFlags(text)) ? "auto" : "confirm";
}

/** The pace of the design the Session is on: its latest `/evolve-design`
 *  command, or the one still being sent.
 *
 *  The auto-continue reads this to decide whether it may act at all. A design
 *  started with pauses is waiting for a person by construction, and a client
 *  that pushed it forward would be answering a question the user asked to be
 *  asked. Reading it from the transcript rather than remembering a switch
 *  keeps a second client's design, and a reopened Session, on the same rule. */
export function latestEvolveCheckpointMode(
  messages: ReadonlyArray<{ content: string; role: string }>,
  pending?: string,
): EvolveCheckpointMode | undefined {
  const commands = messages
    .filter((message) => message.role === "user" && isEvolveCommand(message.content))
    .map((message) => message.content);
  if (pending !== undefined && isEvolveCommand(pending)) commands.push(pending);
  const latest = commands.at(-1);
  return latest === undefined ? undefined : evolveCommandCheckpointMode(latest);
}

/** Whether the design the Session is on already has a search of its own.
 *
 *  A search the Session holds may belong to an earlier design: the run list is
 *  per Session and survives a new `/evolve-design`. Asking it the Session-wide
 *  question would silence the cardless-stall push for a second no-confirm
 *  design that has not started anything yet — the exact stall the push exists
 *  for. A run counts only when it was created after the latest design command,
 *  which is also what makes the answer survive a reopened window: both times
 *  come from the server, not from a counter this client keeps.
 *
 *  `pending` is the message being sent right now. The hook acts on the running
 *  → idle transition, and at that moment the design's command is still only
 *  that pending message — the transcript is written when the turn settles. The
 *  persisted latest command would then be the *previous* design's, and its run
 *  would answer yes for a design that owns nothing. A design whose command is
 *  not persisted yet cannot own a run, so the answer is no; a run this very
 *  turn created is already covered by `run.evolveRunsCreated`. */
export function designHasSearch(
  runs: ReadonlyArray<{ createdAt: string }>,
  messages: ReadonlyArray<{ content: string; createdAt: string; role: string }>,
  pending?: string,
): boolean {
  if (pending !== undefined && isEvolveCommand(pending)) return false;
  const command = messages
    .filter((message) => message.role === "user" && isEvolveCommand(message.content))
    .at(-1);
  const startedAt = command === undefined ? Number.NaN : Date.parse(command.createdAt);
  if (Number.isNaN(startedAt)) return false;
  return runs.some((run) => {
    const created = Date.parse(run.createdAt);
    return !Number.isNaN(created) && created >= startedAt;
  });
}

/** The search the command names, as `--algorithm` says.
 *
 *  Read here so the setup detour keeps the choice: a command typed with
 *  `--algorithm openevolve` opens the dialog with that search selected, rather
 *  than on the dialog's own default, which would replace what was typed. */
export function evolveCommandAlgorithm(text: string): EvolveAlgorithm | undefined {
  if (!isEvolveCommand(text)) return undefined;
  const match = /--algorithm[ \t]+(puct|openevolve)\b/.exec(leadingFlags(text));
  return match?.[1] as EvolveAlgorithm | undefined;
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
  return composeEvolveMessage(flags, goal);
}

/** The flags and the sentence as one message.
 *
 *  The composer shows the flags as a token of their own and lets the user
 *  finish the sentence after it, so the two halves are joined here — with the
 *  same rule `evolveCommand` uses: a goal that begins with a flag would
 *  otherwise be read back as one — both by this module, when the setup detour
 *  re-opens the dialog, and by the agent, which reads the command's leading
 *  run. A line break ends that run, so the goal keeps its own text. */
export function composeEvolveMessage(flags: string, goal: string): string {
  const text = goal.trim();
  if (text === "") return flags;
  return text.startsWith("--") ? `${flags}\n${text}` : `${flags} ${text}`;
}

/** A whole message split back into the token and the sentence, so the dialog's
 *  command can be placed in the composer as flags the user completes rather
 *  than as a message already sent. */
export function splitEvolveCommand(text: string): { command: string; goal: string } {
  if (!isEvolveCommand(text)) return { command: text.trim(), goal: "" };
  return {
    command: `${EVOLVE_COMMAND}${leadingFlags(text)}`.trimEnd(),
    goal: evolveCommandGoal(text) ?? "",
  };
}

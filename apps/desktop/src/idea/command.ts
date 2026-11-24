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
 * `/idea-tree <task>` is a message, like every other command: the agent runs its
 * preparation and starts the research through `create_idea_research`. The desktop
 * recognises the command only to know that a research is expected, so its panel
 * can open when it appears.
 */

const IDEA_TREE_COMMANDS = ["/idea-tree-team", "/idea-tree"] as const;

/** The command 会话设置's `idea-tree` row seeds into the composer once its card
 *  is confirmed.
 *
 *  The card collects parameters; the research starts when the reader sends the
 *  message that carries this token, so the card never sends anything itself.
 *  The team variant is the one that row seeds — the research flow with its
 *  collaborator skills — and the parameters the card just wrote reach it through
 *  the Session override the server reads when the research is created. */
export const IDEA_TREE_TEAM_COMMAND = "/idea-tree-team";

/** True when the draft is one of the Idea Tree commands (longest prefix first).
 *
 *  The command itself is never intercepted: it is sent as a message so the agent
 *  runs its preparation and calls `create_idea_research`, which is the only path
 *  that carries the evidence the engine cannot gather. Recognising it here is
 *  only what lets the panel open when the research it starts appears. */
export function isIdeaTreeCommand(text: string): boolean {
  const trimmed = text.trim();
  return IDEA_TREE_COMMANDS.some((command) => trimmed === command || trimmed.startsWith(`${command} `));
}

/** The Idea Tree command a draft starts with, or undefined when it starts with
 *  something else.
 *
 *  The toggle the parameters card seeds is exactly this: a typed `/idea-tree`
 *  keeps saying `/idea-tree`, and the settings row seeds the team variant. */
export function ideaCommandOf(text: string): string | undefined {
  const trimmed = text.trim();
  return IDEA_TREE_COMMANDS.find((command) => trimmed === command || trimmed.startsWith(`${command} `));
}

/** The task a draft carries, with a leading Idea Tree command taken off.
 *
 *  A draft that is itself the command contributes no task, which is what keeps a
 *  token from becoming another token's objective: typing `/idea-tree-team`, then
 *  adjusting the parameters instead of pressing Enter, used to send
 *  `/idea-tree-team /idea-tree-team …`. */
export function ideaTaskOf(text: string): string {
  const trimmed = text.trim();
  const command = ideaCommandOf(trimmed);
  if (command === undefined) return trimmed;
  return trimmed.slice(command.length).trim();
}

/** The message a seeded token sends: the command, then the task the reader wrote
 *  under it.
 *
 *  Total by design, but the composer never calls it with an empty task: its send
 *  button and Enter both require one, so an Idea Tree message always carries the
 *  question the reader typed. A bare command would leave the agent asking for
 *  the objective the reader could have written in the same box. */
export function composeIdeaMessage(command: string, task: string): string {
  const trimmed = task.trim();
  return trimmed === "" ? command : `${command} ${trimmed}`;
}

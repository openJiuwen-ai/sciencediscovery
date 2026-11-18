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
 * `/idea-tree` typed in the composer opens the launch dialog, the way `/evolve-design`
 * opens the design dialog: the sentence is a task, not a message, and the settings it
 * may start with are chosen before the research exists rather than after.
 */

const IDEA_TREE_COMMANDS = ["/idea-tree-team", "/idea-tree"] as const;

/** True when the draft is one of the Idea Tree commands (longest prefix first). */
export function isIdeaTreeCommand(text: string): boolean {
  const trimmed = text.trim();
  return IDEA_TREE_COMMANDS.some((command) => trimmed === command || trimmed.startsWith(`${command} `));
}

/** The task after the command, trimmed; empty when nothing was typed after it. */
export function ideaTreeCommandTask(text: string): string {
  const trimmed = text.trim();
  for (const command of IDEA_TREE_COMMANDS) {
    if (trimmed === command) return "";
    if (trimmed.startsWith(`${command} `)) return trimmed.slice(command.length).trim();
  }
  return trimmed;
}

/** The command a task should be sent with, so the agent still sees the handoff. */
export function ideaTreeCommand(task: string): string {
  return task.trim() ? `/idea-tree ${task.trim()}` : "/idea-tree";
}

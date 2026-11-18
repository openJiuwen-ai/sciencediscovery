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

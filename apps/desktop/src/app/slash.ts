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

import type { SkillDescriptor } from "../api/types.js";

/**
 * The filter a draft is asking a skill for, or `undefined` when the draft is
 * not a skill pick at all.
 *
 * The palette belongs to a draft that is one `/` command and nothing else: a
 * leading slash, then characters with no space among them. A space ends it —
 * that is the boundary between the skill and the request written after it — so
 * typing `/` on a later line of a longer message does not open it, and a
 * message that merely mentions a path does not either.
 */
export function slashQuery(text: string): string | undefined {
  const match = /^\/([^\s/]*)$/.exec(text);
  return match?.[1];
}

/** How many skills the palette shows at once; past this the list is a search. */
const PALETTE_LIMIT = 8;

/** The skills whose name or id matches what was typed after the slash. */
export function skillChoices(skills: SkillDescriptor[], query: string): SkillDescriptor[] {
  const needle = query.trim().toLocaleLowerCase();
  const matches = needle === ""
    ? skills
    : skills.filter((skill) =>
      skill.name.toLocaleLowerCase().includes(needle)
      || skill.id.toLocaleLowerCase().includes(needle));
  return matches.slice(0, PALETTE_LIMIT);
}

/**
 * The draft after picking a skill: the command by id, then a space, so the
 * next keystroke is the request rather than more of the name. The service
 * expands the ids it knows into full prompts and passes the rest through as
 * the user wrote them.
 */
export function skillDraft(skill: SkillDescriptor): string {
  return `/${skill.id} `;
}

/**
 * The mark a skill is drawn with wherever a list of skills appears: its
 * initial, in the same box 设置 › 技能 gives it. Shared rather than repeated,
 * because two lists of the same catalog should not disagree about what a
 * skill looks like.
 */
export function skillMark(skill: { name: string }): string {
  return skill.name.slice(0, 1).toUpperCase();
}

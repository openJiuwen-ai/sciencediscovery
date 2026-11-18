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

import type { SkillDescriptor } from "../../api/types.js";
import { TEXT } from "../../text.js";

/**
 * A Skill's version and file count, as a reader speaks about them.
 *
 * Two of those used to be the server's own labels rather than a reader's.
 * `version` is `revision:N` for a package that declared none, and printing it
 * after a `v` produced `vrevision:1`; a declared version is a version and
 * reads as one, and a package without one is described by its revision.
 *
 * `resourceSummary.files` counts the files *beside* SKILL.md — that is what a
 * skill's resources are — so a skill whose package is SKILL.md and nothing
 * else counted zero files. A reader counting the skill's files counts
 * SKILL.md, and the package always has it.
 */
export function skillMeta(skill: SkillDescriptor): string {
  const version = skill.declaredVersion === undefined
    ? TEXT.settings.skills.revision(skill.currentRevision)
    : `v${skill.declaredVersion}`;
  return [
    version,
    TEXT.workspace.filesCount(skill.resourceSummary.files + 1),
  ].join(" · ");
}

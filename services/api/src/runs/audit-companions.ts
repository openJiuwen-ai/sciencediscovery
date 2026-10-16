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
 * Pre-finish audit companions (phase V, V1-C1): a skill declaring
 * preFinishAudit gets its `audit-<id>` checklist skill auto-selected for the
 * run, so the finish-gate directive can point at versioned audit content —
 * read_skill only resolves skills selected for the run. Missing companions
 * are skipped (the gate then falls back to its generic checklist), and an
 * already-selected audit skill is never duplicated.
 *
 * Scope note: only catalog (built-in/managed) skills carry the
 * preFinishAudit flag — SkillLibraryCatalog.resolveSkills never reads the
 * declaration, so library skills neither fire the gate (pre-existing) nor
 * gain companions here. Closing that gap is a recorded follow-up.
 */

export function auditCompanionIds(
  activeSkills: readonly { id: string; preFinishAudit?: boolean }[],
  catalog: { get(id: string): unknown },
): string[] {
  const activeIds = new Set(activeSkills.map((skill) => skill.id));
  return activeSkills
    .filter((skill) => skill.preFinishAudit)
    .map((skill) => `audit-${skill.id}`)
    .filter((id) => !activeIds.has(id) && catalog.get(id) !== undefined);
}

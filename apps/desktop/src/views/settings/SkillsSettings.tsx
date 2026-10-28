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

import { useState } from "react";

import type { ApiClient } from "../../api/client.js";
import { getProjectSettings, getSkill, listSkills, setEnabledSkills } from "../../api/settings.js";
import type { RuntimeSettingsOverrides, SkillDescriptor, SkillDetail, SkillSource } from "../../api/types.js";
import { skillMark } from "../../app/slash.js";
import { useLoaded } from "../../app/use-loaded.js";
import { TEXT } from "../../text.js";
import { SettingsModal } from "./SettingsModal.js";
import { SkillForm } from "./SkillForm.js";
import { BulkToggles, Group, LoadGate, Switch, Tag } from "./rows.js";

interface Props {
  activeProjectId?: string;
  /** Owned by the settings surface, where the 新增技能 button lives. */
  adding: boolean;
  client: ApiClient;
  onAddingChange: (next: boolean) => void;
}

interface SkillPage {
  enabled: string[];
  overrides: RuntimeSettingsOverrides;
  skills: SkillDescriptor[];
}

/** The expanded card's SKILL.md body: absent while it is being read. */
interface OpenDetail {
  failed?: boolean;
  id: string;
  instructions?: string;
}

const SOURCE_LABEL: Record<SkillSource, string> = {
  "built-in": TEXT.settings.skills.source.builtIn,
  managed: TEXT.settings.skills.source.managed,
};

/**
 * The line under a card's description: where the skill came from, which
 * version it is, and how many files it ships.
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
    SOURCE_LABEL[skill.source],
    version,
    TEXT.workspace.filesCount(skill.resourceSummary.files + 1),
  ].join(" · ");
}

/**
 * What the project's enabled list becomes once a new skill is created, or
 * `undefined` when the project needs no write.
 *
 * `all` is the default mode and it resolves to everything installed, so a
 * package created under it is on already. `selected` carries an explicit list,
 * and a package missing from that list would be off the moment it was made —
 * the same write a toggle makes. Enabling it is what 新增技能 promises.
 */
export function enabledAfterCreate(
  mode: RuntimeSettingsOverrides["skillSelectionMode"],
  enabled: string[],
  skillId: string,
): string[] | undefined {
  if (mode !== "selected" || enabled.includes(skillId)) return undefined;
  return [...enabled, skillId];
}

/**
 * 设置 › 技能.
 *
 * The enabled set is read back from the project layer after every write rather
 * than tracked locally, because the server normalizes it on the way in: the
 * mode flips to `selected` on the first toggle, and the list is intersected
 * with what is actually installed. Showing the server's answer is the only way
 * the switches and the truth stay in step.
 */
export function SkillsSettings({ activeProjectId, adding, client, onAddingChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [detail, setDetail] = useState<OpenDetail>();
  const [openId, setOpenId] = useState<string>();

  const loaded = useLoaded<SkillPage>(async () => {
    if (!activeProjectId) throw new Error(TEXT.settings.skills.noProject);
    const [skills, project] = await Promise.all([
      listSkills(client),
      getProjectSettings(client, activeProjectId),
    ]);
    const effective = project.effective as { enabledSkillIds?: string[] } | undefined;
    return { enabled: effective?.enabledSkillIds ?? [], overrides: project.overrides, skills };
  });

  const toggle = async (skill: SkillDescriptor, next: boolean) => {
    if (!activeProjectId) return;
    const current = loaded.value;
    if (!current) return;
    const enabled = next
      ? [...current.enabled, skill.id]
      : current.enabled.filter((id) => id !== skill.id);
    setBusy(true);
    setFailure(undefined);
    try {
      await setEnabledSkills(client, activeProjectId, enabled);
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
      loaded.reload();
    }
  };

  /**
   * 一键启用 / 一键关闭, as one write: the list the project keeps is the whole
   * answer, so "all" is every installed id and "none" is the empty list. Under
   * `all` the project carries no list at all, which is why disabling has to
   * write one — `setEnabledSkills` flips the mode to `selected` with it.
   */
  const setAll = async (next: boolean) => {
    if (!activeProjectId) return;
    const page = loaded.value;
    if (!page) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await setEnabledSkills(client, activeProjectId, next ? page.skills.map((skill) => skill.id) : []);
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
      loaded.reload();
    }
  };

  /**
   * Opening a card reads the skill itself, because what closes it is the one
   * thing the list does not carry: the body of SKILL.md, which is what the
   * model is actually told. The summary above the divider is the description;
   * this is the instructions.
   */
  const reveal = (skill: SkillDescriptor) => {
    if (openId === skill.id) {
      setOpenId(undefined);
      setDetail(undefined);
      return;
    }
    setOpenId(skill.id);
    setDetail({ id: skill.id });
    getSkill(client, skill.id).then(
      (found) => setDetail((current) => (
        current?.id === skill.id ? { id: skill.id, instructions: found.instructions.trim() } : current
      )),
      () => setDetail((current) => (
        current?.id === skill.id ? { failed: true, id: skill.id } : current
      )),
    );
  };

  /** A skill created from the form is on — see `enabledAfterCreate`. */
  const afterCreate = async (skill: SkillDetail) => {
    onAddingChange(false);
    if (activeProjectId) {
      try {
        const project = await getProjectSettings(client, activeProjectId);
        const effective = project.effective as { enabledSkillIds?: string[] } | undefined;
        const enabled = enabledAfterCreate(
          project.overrides.skillSelectionMode,
          effective?.enabledSkillIds ?? [],
          skill.id,
        );
        if (enabled !== undefined) await setEnabledSkills(client, activeProjectId, enabled);
      } catch (reason) {
        setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
      }
    }
    loaded.reload();
  };

  return (
    <>
      <Group>
        <LoadGate loaded={loaded}>
          {(page) => {
            if (page.skills.length === 0) {
              return <p className="settings-empty">{TEXT.settings.skills.empty}</p>;
            }
            return (
              <div className="settings-list">
                <BulkToggles busy={busy} onAll={(next) => void setAll(next)} />
                {page.skills.map((skill) => {
                  const on = page.enabled.includes(skill.id);
                  const open = openId === skill.id;
                  return (
                    <div className={`settings-card is-expandable${open ? " is-open" : ""}`} key={skill.id}>
                      <span className="settings-card-mark">{skillMark(skill)}</span>
                      <button
                        className="settings-card-main"
                        onClick={() => reveal(skill)}
                        type="button"
                      >
                        <strong>
                          {skill.name}
                          <Tag tone={on ? "on" : "off"}>
                            {on ? TEXT.settings.skills.on : TEXT.settings.skills.off}
                          </Tag>
                        </strong>
                        <small>{skill.description}</small>
                        {open ? (
                          <span className="settings-detail">
                            <span className="settings-detail-heading">
                              {TEXT.settings.skills.instructionsHeading}
                            </span>
                            <span className={`settings-detail-body${detail?.instructions ? "" : " is-muted"}`}>
                              {detail?.instructions
                                ?? (detail?.failed
                                  ? TEXT.settings.skills.instructionsFailed
                                  : TEXT.settings.skills.instructionsLoading)}
                            </span>
                            <small className="settings-detail-meta">{skillMeta(skill)}</small>
                          </span>
                        ) : null}
                      </button>
                      <div className="settings-card-actions">
                        <Switch
                          disabled={busy}
                          label={TEXT.settings.skills.toggle(skill.name)}
                          onChange={(next) => void toggle(skill, next)}
                          value={on}
                        />
                      </div>
                    </div>
                  );
                })}
                {failure ? <small className="row-note is-error">{failure}</small> : null}
              </div>
            );
          }}
        </LoadGate>
      </Group>

      {adding ? (
        <SettingsModal label={TEXT.settings.skills.add} onClose={() => onAddingChange(false)} wide>
          <SkillForm
            client={client}
            onCancel={() => onAddingChange(false)}
            onSaved={(skill) => void afterCreate(skill)}
          />
        </SettingsModal>
      ) : null}
    </>
  );
}

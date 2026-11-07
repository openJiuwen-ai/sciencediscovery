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
import { getJiuwenSwarmSkills, getSkill, listSkills, setJiuwenSwarmSkillEnabled, setJiuwenSwarmSkillEnabledById } from "../../api/settings.js";
import type { JiuwenSwarmSkill, SkillDescriptor, SkillDetail } from "../../api/types.js";
import { skillMark } from "../../app/slash.js";
import { useLoaded } from "../../app/use-loaded.js";
import { TEXT } from "../../text.js";
import { SettingsModal } from "./SettingsModal.js";
import { SkillForm } from "./SkillForm.js";
import { BulkToggles, Group, LoadGate, Switch, Tag } from "./rows.js";

interface Props {
  adding: boolean;
  client: ApiClient;
  onAddingChange: (next: boolean) => void;
}

interface SkillPage {
  switchesAvailable: boolean;
  switchError?: string;
  native: boolean;
  enabled: string[];
  jiuwenSwarmSkills: JiuwenSwarmSkill[];
  skills: SkillDescriptor[];
}

function setSkillEnabled(client: ApiClient, skill: SkillDescriptor | JiuwenSwarmSkill, enabled: boolean): Promise<void> {
  return "id" in skill
    ? setJiuwenSwarmSkillEnabledById(client, skill.id, enabled)
    : setJiuwenSwarmSkillEnabled(client, skill.name, enabled);
}

/** The expanded card's SKILL.md body: absent while it is being read. */
interface OpenDetail {
  failed?: boolean;
  id: string;
  instructions?: string;
}

function sourceLabel(source: SkillDescriptor["source"]): string {
  return source === "built-in" ? TEXT.settings.skills.source.builtIn : TEXT.settings.skills.source.managed;
}

/**
 * The expanded card's version and file count; its source is already in the badge.
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

/**
 * 设置 › 技能.
 *
 * The enabled set is read from JiuwenSwarm's own skill store: it is the global
 * authority for whether a skill is available, and it applies to every project.
 * ScienceDiscovery only installs or removes the skill package; the switch lives
 * in JiuwenSwarm.
 */
export function SkillsSettings({ adding, client, onAddingChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [detail, setDetail] = useState<OpenDetail>();
  const [openId, setOpenId] = useState<string>();

  const loaded = useLoaded<SkillPage>(async () => {
    const [catalog, state] = await Promise.allSettled([
      listSkills(client),
      getJiuwenSwarmSkills(client),
    ]);
    if (catalog.status === "rejected") throw catalog.reason;
    const jiuwenSwarm = state.status === "fulfilled" ? state.value : undefined;
    return {
      enabled: jiuwenSwarm?.skills.flatMap((skill) => skill.enabled && skill.skillId ? [skill.skillId] : []) ?? [],
      jiuwenSwarmSkills: jiuwenSwarm?.skills.filter((skill) => skill.source !== "sciencediscovery") ?? [],
      native: jiuwenSwarm?.backend === "native",
      skills: catalog.value,
      switchesAvailable: jiuwenSwarm?.backend === "jiuwenswarm",
      ...(state.status === "rejected" ? {
        switchError: state.reason instanceof Error ? state.reason.message : TEXT.settings.saveFailed,
      } : {}),
    };
  }, {
    client,
    key: "skills:jiuwenswarm",
  });

  const toggle = async (skill: SkillDescriptor | JiuwenSwarmSkill, next: boolean) => {
    const page = loaded.value;
    if (!page?.switchesAvailable) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await setSkillEnabled(client, skill, next);
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
      loaded.reload();
    }
  };

  /**
   * Enable or disable every installed skill. Each toggle is its own request:
   * JiuwenSwarm is the authority, and a single failing skill must not stop the
   * rest from being applied.
   */
  const setAll = async (next: boolean) => {
    const page = loaded.value;
    if (!page?.switchesAvailable) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const failures: string[] = [];
      for (const skill of [...page.skills, ...page.jiuwenSwarmSkills]) {
        try {
          await setSkillEnabled(client, skill, next);
        } catch (reason) {
          failures.push(`${skill.name}: ${reason instanceof Error ? reason.message : TEXT.settings.saveFailed}`);
        }
      }
      if (failures.length) setFailure(failures.join("\n"));
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

  /** Enable a new skill when JiuwenSwarm is available; native creation needs no import. */
  const afterCreate = async (skill: SkillDetail) => {
    onAddingChange(false);
    setBusy(true);
    setFailure(undefined);
    try {
      if (loaded.value?.switchesAvailable) {
        await setJiuwenSwarmSkillEnabledById(client, skill.id, true);
      } else if (!loaded.value?.native) {
        setFailure(loaded.value?.switchError ?? TEXT.settings.saveFailed);
      }
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
      loaded.reload();
    }
  };

  return (
    <>
      <Group>
        <p className="row-note">{TEXT.settings.skills.scope}</p>
        {failure ? <small className="row-note is-error" role="alert">{failure}</small> : null}
        <LoadGate loaded={loaded}>
          {(page) => {
            return (
              <div className="settings-list">
                {page.native ? <p className="row-note">{TEXT.settings.skills.jiuwenSwarmOnly}</p> : null}
                {page.switchError ? <div className="row-note is-error" role="alert">
                  {page.switchError}
                  <button className="bulk-button" disabled={loaded.loading} onClick={() => { setFailure(undefined); loaded.reload(); }} type="button">
                    {TEXT.settings.retry}
                  </button>
                </div> : null}
                {page.skills.length === 0 && page.jiuwenSwarmSkills.length === 0
                  ? <p className="settings-empty">{TEXT.settings.skills.empty}</p>
                  : page.switchesAvailable ? <BulkToggles busy={busy} onAll={(next) => void setAll(next)} /> : null}
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
                          {page.switchesAvailable ? <Tag tone={on ? "on" : "off"}>
                            {on ? TEXT.settings.skills.on : TEXT.settings.skills.off}
                          </Tag> : null}
                        </strong>
                        <small>{skill.description}</small>
                        <span className={`skill-source-badge ${skill.source === "built-in" ? "is-sd" : "is-managed"}`}>
                          {sourceLabel(skill.source)}
                        </span>
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
                          disabled={busy || !page.switchesAvailable}
                          label={TEXT.settings.skills.toggle(skill.name)}
                          onChange={(next) => void toggle(skill, next)}
                          value={on}
                        />
                      </div>
                    </div>
                  );
                })}
                {page.jiuwenSwarmSkills.map((skill) => (
                  <div className="settings-card" key={`jiuwenswarm:${skill.name}`}>
                    <span className="settings-card-mark">{skillMark(skill)}</span>
                    <div className="settings-card-main">
                      <strong>
                        {skill.name}
                        <Tag tone={skill.enabled ? "on" : "off"}>
                          {skill.enabled ? TEXT.settings.skills.on : TEXT.settings.skills.off}
                        </Tag>
                      </strong>
                      <small>{skill.description}</small>
                      <span className={`skill-source-badge ${skill.source === "builtin" ? "is-jiuwenswarm" : "is-managed"}`}>
                        {skill.source === "builtin" ? TEXT.settings.skills.source.jiuwenBuiltIn : TEXT.settings.skills.source.jiuwenLocal}
                      </span>
                    </div>
                    <div className="settings-card-actions">
                      <Switch
                        disabled={busy || !page.switchesAvailable}
                        label={TEXT.settings.skills.toggle(skill.name)}
                        onChange={(next) => void toggle(skill, next)}
                        value={skill.enabled}
                      />
                    </div>
                  </div>
                ))}
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

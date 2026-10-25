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
import { getProjectSettings, listSkills, setEnabledSkills } from "../../api/settings.js";
import type { RuntimeSettingsOverrides, SkillDescriptor } from "../../api/types.js";
import { useLoaded } from "../../app/use-loaded.js";
import { TEXT } from "../../text.js";
import { Group, LoadGate, Switch, Tag } from "./rows.js";

interface Props {
  activeProjectId?: string;
  client: ApiClient;
}

interface SkillPage {
  enabled: string[];
  overrides: RuntimeSettingsOverrides;
  skills: SkillDescriptor[];
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
export function SkillsSettings({ activeProjectId, client }: Props) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
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

  return (
    <Group>
      <LoadGate loaded={loaded}>
        {(page) => {
          if (page.skills.length === 0) {
            return <p className="settings-empty">{TEXT.settings.skills.empty}</p>;
          }
          return (
            <div className="settings-list">
              {page.skills.map((skill) => {
                const on = page.enabled.includes(skill.id);
                const open = openId === skill.id;
                return (
                  <div className={`settings-card${open ? " is-open" : ""}`} key={skill.id}>
                    <span className="settings-card-mark">{skill.name.slice(0, 1).toUpperCase()}</span>
                    <button
                      className="settings-card-main"
                      onClick={() => setOpenId(open ? undefined : skill.id)}
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
                          {skill.description}
                          <small className="settings-detail-meta">
                            {skill.source} · v{skill.version} · {TEXT.workspace.filesCount(skill.resourceSummary.files)}
                          </small>
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
  );
}

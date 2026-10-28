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

import type { ConnectorManifest, SkillDescriptor } from "../../../api/types.js";
import { TEXT } from "../../../text.js";
import { SettingsModal } from "../SettingsModal.js";

/** Which of the two capability lists a tab is showing. */
export type AbilityTab = "skills" | "connectors";

interface Props {
  connectors: ConnectorManifest[];
  initialTab: AbilityTab;
  onApply: (selection: { connectorIds: string[]; skillIds: string[] }) => void;
  onClose: () => void;
  selectedConnectorIds: string[];
  selectedSkillIds: string[];
  skills: SkillDescriptor[];
}

function connectorName(connector: ConnectorManifest): string {
  return connector.displayName ?? connector.id;
}

function skillDetail(skill: SkillDescriptor): string {
  return skill.description.trim() === "" ? skill.id : skill.description;
}

/**
 * The modal behind 添加技能 / 添加连接器.
 *
 * It lists every capability the machine knows about, not only the ones the
 * specialist already has, so a list can be filled from one place. Selections
 * are drafted here and handed back as a whole; closing without 添加 leaves the
 * form below untouched.
 */
export function AbilityPicker({
  connectors,
  initialTab,
  onApply,
  onClose,
  selectedConnectorIds,
  selectedSkillIds,
  skills,
}: Props) {
  const [tab, setTab] = useState<AbilityTab>(initialTab);
  const [skillIds, setSkillIds] = useState(selectedSkillIds);
  const [connectorIds, setConnectorIds] = useState(selectedConnectorIds);

  const toggle = (ids: string[], setIds: (next: string[]) => void, id: string, picked: boolean) => {
    setIds(picked ? [...ids, id] : ids.filter((candidate) => candidate !== id));
  };

  return (
    <SettingsModal label={TEXT.settings.system.specialists.pickerTitle} onClose={onClose} wide>
      <div className="settings-picker">
        <div aria-label={TEXT.settings.system.specialists.capabilities} className="settings-ability-tabs" role="tablist">
          <button
            aria-selected={tab === "skills"}
            className={`settings-ability-tab${tab === "skills" ? " is-active" : ""}`}
            onClick={() => setTab("skills")}
            role="tab"
            type="button"
          >
            {TEXT.settings.system.specialists.skills}
            <span className="settings-ability-tab-count">{skillIds.length}</span>
          </button>
          <button
            aria-selected={tab === "connectors"}
            className={`settings-ability-tab${tab === "connectors" ? " is-active" : ""}`}
            onClick={() => setTab("connectors")}
            role="tab"
            type="button"
          >
            {TEXT.settings.system.specialists.connectors}
            <span className="settings-ability-tab-count">{connectorIds.length}</span>
          </button>
        </div>

        {tab === "skills" ? (
          skills.length === 0 ? (
            <p className="settings-picker-empty">{TEXT.settings.system.specialists.pickerEmptySkills}</p>
          ) : (
            <div className="settings-picker-list">
              {skills.map((skill) => (
                <label className="settings-picker-option" key={skill.id}>
                  <input
                    checked={skillIds.includes(skill.id)}
                    onChange={(event) => toggle(skillIds, setSkillIds, skill.id, event.target.checked)}
                    type="checkbox"
                  />
                  <span className="settings-picker-option-main">
                    <span className="settings-picker-option-name">{skill.name}</span>
                    <span className="settings-picker-option-detail">{skillDetail(skill)}</span>
                  </span>
                </label>
              ))}
            </div>
          )
        ) : connectors.length === 0 ? (
          <p className="settings-picker-empty">{TEXT.settings.system.specialists.pickerEmptyConnectors}</p>
        ) : (
          <div className="settings-picker-list">
            {connectors.map((connector) => (
              <label className="settings-picker-option" key={connector.id}>
                <input
                  checked={connectorIds.includes(connector.id)}
                  onChange={(event) => toggle(connectorIds, setConnectorIds, connector.id, event.target.checked)}
                  type="checkbox"
                />
                <span className="settings-picker-option-main">
                  <span className="settings-picker-option-name">{connectorName(connector)}</span>
                  <span className="settings-picker-option-detail">{connector.id}</span>
                </span>
              </label>
            ))}
          </div>
        )}

        <div className="settings-card-actions">
          <button className="secondary-button" onClick={onClose} type="button">
            {TEXT.settings.cancel}
          </button>
          <button
            className="primary-button"
            onClick={() => onApply({ connectorIds, skillIds })}
            type="button"
          >
            {TEXT.settings.system.specialists.addSelected}
          </button>
        </div>
      </div>
    </SettingsModal>
  );
}

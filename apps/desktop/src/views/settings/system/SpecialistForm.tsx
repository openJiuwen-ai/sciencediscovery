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

import type { ApiClient } from "../../../api/client.js";
import { createSpecialist, updateSpecialist } from "../../../api/settings.js";
import type {
  ConnectorManifest,
  CreateSpecialistRequest,
  SkillDescriptor,
  Specialist,
  SpecialistRuntime,
} from "../../../api/types.js";
import { TEXT } from "../../../text.js";
import { Row, Select } from "../rows.js";
import { SettingsModal } from "../SettingsModal.js";
import { AbilityPicker, type AbilityTab } from "./AbilityPicker.js";

interface Props {
  client: ApiClient;
  connectors: ConnectorManifest[];
  /** Called when 取消, × or the scrim closes the form. */
  onCancel: () => void;
  /** Called after the server has accepted the write; the list reloads behind
   *  the modal, so the caller closes it here. */
  onSaved: () => void;
  /** Present when editing; absent when creating. */
  specialist?: Specialist;
  skills: SkillDescriptor[];
}

type RuntimeKind = "native" | "codex" | "claude-code" | "acp";

/**
 * 完全访问 inherits the main agent's capabilities and may add the role's own
 * lists, so anything enabled later is included without editing it again.
 * 特定能力 stores a pair of lists that replaces the inherited set. Switching
 * to 完全访问 clears the lists; an untouched role keeps them.
 */
type CapabilityAccess = "all" | "specific";

/** What the fields say above their counters, and what the inputs stop at. */
const NAME_MAX_LENGTH = 80;
const DESCRIPTION_MAX_LENGTH = 500;
const INSTRUCTIONS_MAX_LENGTH = 20_000;
const INSTRUCTIONS_MAX_DISPLAY = INSTRUCTIONS_MAX_LENGTH.toLocaleString("en-US");

interface Draft {
  access: CapabilityAccess;
  connectorIds: string[];
  description: string;
  enabledSkillIds: string[];
  instructions: string;
  /** The runtime object as stored, so advanced options survive an edit. */
  loadedRuntime?: SpecialistRuntime;
  model: string;
  name: string;
  runtime: RuntimeKind;
  /** Whether the kind or model was edited; untouched fields omit `runtime`. */
  runtimeChanged: boolean;
}

function emptyDraft(): Draft {
  return {
    access: "all",
    connectorIds: [],
    description: "",
    enabledSkillIds: [],
    instructions: "",
    model: "",
    name: "",
    runtime: "native",
    runtimeChanged: false,
  };
}

function draftOf(specialist: Specialist): Draft {
  return {
    // A record written before capabilityAccess existed is read the same way
    // the store reads it: a list means 特定能力, two empty lists mean 完全访问.
    // An empty specific selection still opens as specific, not full access.
    access: specialist.capabilityAccess
      ?? (specialist.connectorIds.length === 0 && specialist.enabledSkillIds.length === 0 ? "all" : "specific"),
    connectorIds: [...specialist.connectorIds],
    description: specialist.description,
    enabledSkillIds: [...specialist.enabledSkillIds],
    instructions: specialist.instructions,
    ...(specialist.runtime === undefined ? {} : { loadedRuntime: specialist.runtime }),
    model: specialist.runtime !== undefined && specialist.runtime.kind !== "native"
      ? (specialist.runtime.model ?? "")
      : "",
    name: specialist.name,
    runtime: specialist.runtime?.kind ?? "native",
    runtimeChanged: false,
  };
}

/**
 * The runtime to write, or `undefined` when the editor did not touch kind or
 * model. An edit merges into the loaded object, so `fallback`, `timeoutSeconds`,
 * `reasoningEffort` and `execution` survive; clearing the model drops only
 * `model`.
 */
function runtimeOf(draft: Draft): SpecialistRuntime | undefined {
  if (!draft.runtimeChanged) return undefined;
  const model = draft.model.trim();
  if (draft.runtime === "native") return { kind: "native" };
  const loaded = draft.loadedRuntime;
  const { model: _loadedModel, ...advanced } = loaded && loaded.kind !== "native" ? loaded : {};
  return {
    ...advanced,
    kind: draft.runtime,
    ...(model === "" ? {} : { model }),
  } as SpecialistRuntime;
}

function bodyOf(draft: Draft): CreateSpecialistRequest {
  const runtime = runtimeOf(draft);
  return {
    capabilityAccess: draft.access,
    // Full access keeps the role's own additions; its radio clears them only
    // when the user explicitly switches to it.
    connectorIds: draft.connectorIds as CreateSpecialistRequest["connectorIds"],
    description: draft.description.trim(),
    enabledSkillIds: draft.enabledSkillIds,
    instructions: draft.instructions.trim(),
    name: draft.name.trim(),
    ...(runtime === undefined ? {} : { runtime }),
  };
}

/**
 * The one place a specialist is created or edited.
 *
 * It owns the draft and the write, like {@link ModelForm} owns the model
 * write, so the settings page only has to say which specialist was opened and
 * what to do once the server answers. The form is mounted only while its
 * modal is open, which is what gives every open a fresh draft.
 */
export function SpecialistForm({ client, connectors, onCancel, onSaved, skills, specialist }: Props) {
  const [draft, setDraft] = useState<Draft>(() => (
    specialist === undefined ? emptyDraft() : draftOf(specialist)
  ));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [abilityTab, setAbilityTab] = useState<AbilityTab>("skills");
  const [picking, setPicking] = useState<AbilityTab>();
  const creating = specialist === undefined;
  const selectedSkills = skills.filter((skill) => draft.enabledSkillIds.includes(skill.id));
  // Both modes can carry stored skill ids, so a skill removed from the
  // catalog must stay repairable after an all-mode role keeps its own lists.
  const unavailableSkillIds = draft.enabledSkillIds.filter((id) => !skills.some((skill) => skill.id === id));
  const canSave = unavailableSkillIds.length === 0
    && [draft.name, draft.description, draft.instructions].every((value) => value.trim() !== "");
  const selectedConnectors = connectors.filter((connector) => draft.connectorIds.includes(connector.id));
  const showingSkills = abilityTab === "skills";

  const removeSkill = (id: string) => {
    setDraft({ ...draft, enabledSkillIds: draft.enabledSkillIds.filter((candidate) => candidate !== id) });
  };

  const removeConnector = (id: string) => {
    setDraft({ ...draft, connectorIds: draft.connectorIds.filter((candidate) => candidate !== id) });
  };

  const save = async () => {
    if (busy || !canSave) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const body = bodyOf(draft);
      if (specialist === undefined) await createSpecialist(client, body);
      else await updateSpecialist(client, specialist.id, body);
      onSaved();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsModal
      closeDisabled={busy}
      label={creating ? TEXT.settings.system.specialists.add : TEXT.settings.system.specialists.editTitle}
      onClose={onCancel}
      wide
    >
      <div className="settings-card is-form">
        <div className="settings-card-form">
          <label className="settings-field">
            <span className="settings-field-head">
              <span className="settings-field-label is-required">{TEXT.settings.system.specialists.name}</span>
              <span className="settings-field-count">{draft.name.length} / {NAME_MAX_LENGTH}</span>
            </span>
            <input
              aria-label={TEXT.settings.system.specialists.name}
              autoFocus={creating}
              className="field-input"
              disabled={busy}
              maxLength={NAME_MAX_LENGTH}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder={TEXT.settings.system.specialists.namePlaceholder}
              required
              value={draft.name}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field-head">
              <span className="settings-field-label is-required">{TEXT.settings.system.specialists.description}</span>
              <span className="settings-field-count">{draft.description.length} / {DESCRIPTION_MAX_LENGTH}</span>
            </span>
            <input
              aria-label={TEXT.settings.system.specialists.description}
              className="field-input"
              disabled={busy}
              maxLength={DESCRIPTION_MAX_LENGTH}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              placeholder={TEXT.settings.system.specialists.descriptionPlaceholder}
              required
              value={draft.description}
            />
          </label>
          <div className="settings-field">
            <span className="settings-field-label is-required">{TEXT.settings.system.specialists.instructions}</span>
            <span className="settings-field-hint">{TEXT.settings.system.specialists.instructionsHint}</span>
            <span className="settings-textarea-wrap">
              <textarea
                aria-label={TEXT.settings.system.specialists.instructions}
                className="field-textarea"
                disabled={busy}
                maxLength={INSTRUCTIONS_MAX_LENGTH}
                onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                placeholder={TEXT.settings.system.specialists.instructionsPlaceholder}
                required
                rows={6}
                value={draft.instructions}
              />
              <span className="settings-textarea-count">
                {draft.instructions.length.toLocaleString("en-US")} / {INSTRUCTIONS_MAX_DISPLAY}
              </span>
            </span>
          </div>
          <Row hint={TEXT.settings.system.specialists.runtimeHint} title={TEXT.settings.system.specialists.runtime}>
            <Select
              disabled={busy}
              label={TEXT.settings.system.specialists.runtime}
              onChange={(value) => setDraft({ ...draft, runtime: value as RuntimeKind, runtimeChanged: true })}
              options={[
                { label: TEXT.settings.system.specialists.runtimeNative, value: "native" },
                { label: "Codex", value: "codex" },
                { label: "Claude Code", value: "claude-code" },
                { label: "ACP", value: "acp" },
              ]}
              value={draft.runtime}
            />
          </Row>
          {draft.runtime === "native" ? null : (
            <Row hint={TEXT.settings.system.specialists.modelHint} title={TEXT.settings.system.specialists.model}>
              <input
                className="field-input"
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, model: event.target.value, runtimeChanged: true })}
                value={draft.model}
              />
            </Row>
          )}
          {draft.runtime === "native" ? null : (
            <p className="settings-field-hint specialist-runtime-note" role="note">
              {TEXT.settings.system.specialists.runtimeExternalNote}
            </p>
          )}
          <div className="settings-ability">
            <span className="settings-field-label">{TEXT.settings.system.specialists.capabilities}</span>
            <span className="settings-field-hint">{TEXT.settings.system.specialists.capabilitiesHint}</span>

            <label className={`settings-ability-option${draft.access === "all" ? " is-selected" : ""}`}>
              <input
                checked={draft.access === "all"}
                disabled={busy}
                name="specialist-capability-access"
                onChange={() => setDraft({ ...draft, access: "all", connectorIds: [], enabledSkillIds: [] })}
                type="radio"
              />
              <span className="settings-ability-option-main">
                <span className="settings-ability-option-head">
                  <span className="settings-ability-option-title">
                    {TEXT.settings.system.specialists.fullAccess}
                  </span>
                  <span className="settings-ability-default">
                    {TEXT.settings.system.specialists.defaultTag}
                  </span>
                </span>
                <span className="settings-ability-option-hint">
                  {TEXT.settings.system.specialists.fullAccessHint}
                </span>
              </span>
            </label>

            <div className="settings-ability-divider">
              <span>{TEXT.settings.system.specialists.orSpecific}</span>
            </div>

            <div className="settings-ability-toolbar">
              <div
                aria-label={TEXT.settings.system.specialists.capabilities}
                className="settings-ability-tabs"
                role="tablist"
              >
                <button
                  aria-selected={showingSkills}
                  className={`settings-ability-tab${showingSkills ? " is-active" : ""}`}
                  onClick={() => setAbilityTab("skills")}
                  role="tab"
                  type="button"
                >
                  {TEXT.settings.system.specialists.skills}
                  <span className="settings-ability-tab-count">{selectedSkills.length}</span>
                </button>
                <button
                  aria-selected={!showingSkills}
                  className={`settings-ability-tab${showingSkills ? "" : " is-active"}`}
                  onClick={() => setAbilityTab("connectors")}
                  role="tab"
                  type="button"
                >
                  {TEXT.settings.system.specialists.connectors}
                  <span className="settings-ability-tab-count">{selectedConnectors.length}</span>
                </button>
              </div>
              <button
                className="settings-ability-add"
                disabled={busy}
                onClick={() => setPicking(abilityTab)}
                type="button"
              >
                <span aria-hidden="true">+</span>
                {showingSkills
                  ? TEXT.settings.system.specialists.addSkill
                  : TEXT.settings.system.specialists.addConnector}
              </button>
            </div>

            {showingSkills ? (
              selectedSkills.length === 0 && unavailableSkillIds.length === 0 ? (
                <p className="settings-ability-empty">{TEXT.settings.system.specialists.noSkills}</p>
              ) : (
                <ul className="settings-ability-list">
                  {selectedSkills.map((skill) => (
                    <li className="settings-ability-item" key={skill.id}>
                      <span className="settings-ability-item-name">{skill.name}</span>
                      <button
                        aria-label={`${TEXT.settings.system.specialists.remove} ${skill.name}`}
                        className="settings-ability-remove"
                        disabled={busy}
                        onClick={() => removeSkill(skill.id)}
                        type="button"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                  {unavailableSkillIds.map((id) => (
                    <li className="settings-ability-item" key={id}>
                      <span className="settings-ability-item-name">{TEXT.settings.system.specialists.unavailableSkill(id)}</span>
                      <button
                        aria-label={`${TEXT.settings.system.specialists.remove} ${id}`}
                        className="settings-ability-remove"
                        disabled={busy}
                        onClick={() => removeSkill(id)}
                        type="button"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : selectedConnectors.length === 0 ? (
              <p className="settings-ability-empty">{TEXT.settings.system.specialists.noConnectors}</p>
            ) : (
              <ul className="settings-ability-list">
                {selectedConnectors.map((connector) => (
                  <li className="settings-ability-item" key={connector.id}>
                    <span className="settings-ability-item-name">{connector.displayName ?? connector.id}</span>
                    <button
                      aria-label={`${TEXT.settings.system.specialists.remove} ${connector.displayName ?? connector.id}`}
                      className="settings-ability-remove"
                      disabled={busy}
                      onClick={() => removeConnector(connector.id)}
                      type="button"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {unavailableSkillIds.length > 0 ? (
              <p className="row-note is-error" role="status">{TEXT.settings.system.specialists.unavailableSkillsHint}</p>
            ) : null}
            <p className="settings-ability-note">
              <span aria-hidden="true" className="settings-ability-note-icon">i</span>
              <span>
                {showingSkills
                  ? TEXT.settings.system.specialists.skillsNote
                  : TEXT.settings.system.specialists.connectorsNote}
              </span>
            </p>
          </div>
          {failure ? <small className="row-note is-error" role="alert">{failure}</small> : null}
          <div className="settings-card-actions">
            <button className="secondary-button" disabled={busy} onClick={onCancel} type="button">
              {TEXT.settings.cancel}
            </button>
            <button
              className="primary-button"
              disabled={busy || !canSave}
              onClick={() => void save()}
              type="button"
            >
              {TEXT.settings.system.save}
            </button>
          </div>
        </div>
      </div>

      {picking === undefined ? null : (
        // The picker is the one layer that drops a capability the service can
        // no longer resolve, so it gets the raw list and filters its own
        // selection. The form's chips above still show a saved id the catalog
        // reports as failed, so that it can be removed here.
        <AbilityPicker
          connectors={connectors}
          initialTab={picking}
          onApply={({ connectorIds, skillIds }) => {
            setDraft({
              ...draft,
              access: "specific",
              connectorIds,
              enabledSkillIds: skillIds,
            });
            setPicking(undefined);
          }}
          onClose={() => setPicking(undefined)}
          selectedConnectorIds={draft.connectorIds}
          selectedSkillIds={draft.enabledSkillIds}
          skills={skills}
        />
      )}
    </SettingsModal>
  );
}

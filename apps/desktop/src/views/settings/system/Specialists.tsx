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
import {
  createSpecialist,
  deleteSpecialist,
  listConnectors,
  listSkills,
  listSpecialists,
  updateSpecialist,
} from "../../../api/settings.js";
import type {
  ConnectorManifest,
  CreateSpecialistRequest,
  SkillDescriptor,
  Specialist,
  SpecialistRuntime,
} from "../../../api/types.js";
import type { ConfirmRequest } from "../../../app/use-workspace.js";
import { useLoaded } from "../../../app/use-loaded.js";
import { TEXT } from "../../../text.js";
import { Group, LoadGate, Row, Select, Switch, Tag } from "../rows.js";

interface Props {
  client: ApiClient;
  onConfirm: (request: ConfirmRequest) => void;
}

type RuntimeKind = "native" | "codex" | "claude-code" | "acp";

interface Page {
  connectors: ConnectorManifest[];
  skills: SkillDescriptor[];
  specialists: Specialist[];
}

interface Draft {
  connectorIds: string[];
  description: string;
  enabledSkillIds: string[];
  id?: string;
  instructions: string;
  model: string;
  name: string;
  runtime: RuntimeKind;
}

function emptyDraft(): Draft {
  return {
    connectorIds: [],
    description: "",
    enabledSkillIds: [],
    instructions: "",
    model: "",
    name: "",
    runtime: "native",
  };
}

function draftOf(specialist: Specialist): Draft {
  return {
    connectorIds: specialist.connectorIds,
    description: specialist.description,
    enabledSkillIds: specialist.enabledSkillIds,
    id: specialist.id,
    instructions: specialist.instructions,
    model: specialist.runtime !== undefined && specialist.runtime.kind !== "native"
      ? (specialist.runtime.model ?? "")
      : "",
    name: specialist.name,
    runtime: specialist.runtime?.kind ?? "native",
  };
}

function runtimeOf(draft: Draft): SpecialistRuntime {
  const model = draft.model.trim();
  switch (draft.runtime) {
    case "codex":
      return { kind: "codex", ...(model === "" ? {} : { model }) };
    case "claude-code":
      return { kind: "claude-code", ...(model === "" ? {} : { model }) };
    case "acp":
      return { kind: "acp", ...(model === "" ? {} : { model }) };
    default:
      return { kind: "native" };
  }
}

function bodyOf(draft: Draft): CreateSpecialistRequest {
  return {
    connectorIds: draft.connectorIds as CreateSpecialistRequest["connectorIds"],
    description: draft.description.trim(),
    enabledSkillIds: draft.enabledSkillIds,
    instructions: draft.instructions,
    name: draft.name.trim(),
    runtime: runtimeOf(draft),
  };
}

/**
 * 设置 › 专家: the reusable instruction-and-tool bundles a run can dispatch to.
 *
 * Built-ins are seeded by the application and read-only; their one editable
 * field is whether they appear in the task tool's enum at all. A user-created
 * specialist is always enabled, so the switch is drawn only where it means
 * something.
 */
export function SpecialistsSettings({ client, onConfirm }: Props) {
  const loaded = useLoaded<Page>(async () => {
    const [specialists, connectors, skills] = await Promise.all([
      listSpecialists(client),
      listConnectors(client),
      listSkills(client),
    ]);
    return { connectors, skills, specialists };
  });
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const write = async (body: CreateSpecialistRequest, id?: string) => {
    setBusy(true);
    setFailure(undefined);
    try {
      if (id === undefined) await createSpecialist(client, body);
      else await updateSpecialist(client, id, body);
      setDraft(undefined);
      loaded.reload();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (specialist: Specialist, next: boolean) => {
    setBusy(true);
    setFailure(undefined);
    try {
      await updateSpecialist(client, specialist.id, { enabled: next });
      loaded.reload();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <LoadGate loaded={loaded}>
      {(page) => (
        <>
          <Group>
            <div className="settings-actions is-end">
              <button className="pill-button is-dark" onClick={() => setDraft(emptyDraft())} type="button">
                {TEXT.settings.system.specialists.add}
              </button>
            </div>
            <p className="settings-note">{TEXT.settings.system.specialists.help}</p>
            {page.specialists.length === 0 ? (
              <p className="settings-empty">{TEXT.settings.system.specialists.empty}</p>
            ) : (
              <div className="settings-list">
                {page.specialists.map((specialist) => {
                  const on = specialist.enabled !== false;
                  return (
                    <div className={`settings-card${on ? "" : " is-off"}`} key={specialist.id}>
                      <span className="settings-card-mark">{specialist.name.slice(0, 1).toUpperCase()}</span>
                      <div className="settings-card-main">
                        <strong>
                          {specialist.name}
                          {specialist.builtIn ? (
                            <Tag tone="off">{TEXT.settings.system.specialists.builtIn}</Tag>
                          ) : null}
                          <Tag tone={on ? "ok" : "off"}>
                            {on ? TEXT.settings.system.specialists.enabled : TEXT.settings.system.specialists.disabled}
                          </Tag>
                        </strong>
                        <small>{specialist.description}</small>
                      </div>
                      <div className="settings-card-actions">
                        {specialist.builtIn ? (
                          <Switch
                            disabled={busy}
                            label={`${specialist.name} · ${TEXT.settings.system.specialists.enabled}`}
                            onChange={(next) => void toggle(specialist, next)}
                            value={on}
                          />
                        ) : (
                          <>
                            <button
                              className="link-button"
                              disabled={busy}
                              onClick={() => setDraft(draftOf(specialist))}
                              type="button"
                            >
                              {TEXT.settings.edit}
                            </button>
                            <button
                              className="link-button is-danger"
                              disabled={busy}
                              onClick={() => onConfirm({
                                accept: TEXT.menu.delete,
                                body: TEXT.settings.system.specialists.deleteBody(specialist.name),
                                eyebrow: TEXT.settings.system.specialists.heading,
                                onAccept: () => {
                                  void deleteSpecialist(client, specialist.id)
                                    .then(() => loaded.reload())
                                    .catch((reason: unknown) => {
                                      setFailure(reason instanceof Error ? reason.message : TEXT.errors.generic);
                                    });
                                },
                                title: TEXT.settings.system.specialists.deleteTitle(specialist.name),
                              })}
                              type="button"
                            >
                              {TEXT.menu.delete}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Group>

          {draft ? (
            <section className="settings-card is-form">
              <div className="settings-card-form">
                <Row title={TEXT.settings.system.specialists.name}>
                  <input
                    className="field-input"
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    value={draft.name}
                  />
                </Row>
                <Row title={TEXT.settings.system.specialists.description}>
                  <input
                    className="field-input"
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                    value={draft.description}
                  />
                </Row>
                <Row title={TEXT.settings.system.specialists.instructions} tone="stack">
                  <textarea
                    className="field-textarea"
                    onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                    rows={6}
                    value={draft.instructions}
                  />
                </Row>
                <Row hint={TEXT.settings.system.specialists.runtimeHint} title={TEXT.settings.system.specialists.runtime}>
                  <Select
                    label={TEXT.settings.system.specialists.runtime}
                    onChange={(value) => setDraft({ ...draft, runtime: value as RuntimeKind })}
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
                      onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                      value={draft.model}
                    />
                  </Row>
                )}
                <div className="settings-choice">
                  <strong>{TEXT.settings.system.specialists.connectors}</strong>
                  {page.connectors.length === 0 ? (
                    <small className="row-note">{TEXT.settings.system.specialists.none}</small>
                  ) : (
                    page.connectors.map((connector) => (
                      <label className="settings-check" key={connector.id}>
                        <input
                          checked={draft.connectorIds.includes(connector.id)}
                          onChange={(event) => setDraft({
                            ...draft,
                            connectorIds: event.target.checked
                              ? [...draft.connectorIds, connector.id]
                              : draft.connectorIds.filter((id) => id !== connector.id),
                          })}
                          type="checkbox"
                        />
                        <span>{connector.displayName ?? connector.id}</span>
                      </label>
                    ))
                  )}
                </div>
                <div className="settings-choice">
                  <strong>{TEXT.settings.system.specialists.skills}</strong>
                  {page.skills.length === 0 ? (
                    <small className="row-note">{TEXT.settings.system.specialists.none}</small>
                  ) : (
                    page.skills.map((skill) => (
                      <label className="settings-check" key={skill.id}>
                        <input
                          checked={draft.enabledSkillIds.includes(skill.id)}
                          onChange={(event) => setDraft({
                            ...draft,
                            enabledSkillIds: event.target.checked
                              ? [...draft.enabledSkillIds, skill.id]
                              : draft.enabledSkillIds.filter((id) => id !== skill.id),
                          })}
                          type="checkbox"
                        />
                        <span>{skill.name}</span>
                      </label>
                    ))
                  )}
                </div>
                <div className="settings-card-actions">
                  <button className="secondary-button" onClick={() => setDraft(undefined)} type="button">
                    {TEXT.settings.cancel}
                  </button>
                  <button
                    className="primary-button"
                    disabled={busy || draft.name.trim() === ""}
                    onClick={() => void write(bodyOf(draft), draft.id)}
                    type="button"
                  >
                    {TEXT.settings.system.save}
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          {failure ? <small className="row-note is-error">{failure}</small> : null}
        </>
      )}
    </LoadGate>
  );
}

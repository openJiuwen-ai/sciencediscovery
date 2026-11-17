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
import { getReviewerSettings, updateReviewerSettings } from "../../../api/reviewer.js";
import {
  deleteSpecialist,
  listConnectors,
  listSkills,
  listSpecialists,
  updateSpecialist,
} from "../../../api/settings.js";
import type {
  ConnectorManifest,
  ReviewerSpecialistSettings,
  SkillDescriptor,
  Specialist,
} from "../../../api/types.js";
import type { ConfirmRequest } from "../../../app/use-workspace.js";
import { useLoaded } from "../../../app/use-loaded.js";
import { TEXT } from "../../../text.js";
import { SettingsModal } from "../SettingsModal.js";
import { BulkToggles, Group, LoadGate, Row, Switch, Tag } from "../rows.js";
import { SpecialistForm } from "./SpecialistForm.js";

interface Props {
  client: ApiClient;
  /** Present while the settings header's create action is open. */
  onCancelCreate?: () => void;
  onConfirm: (request: ConfirmRequest) => void;
}

interface Page {
  connectors: ConnectorManifest[];
  reviewer: ReviewerSpecialistSettings;
  skills: SkillDescriptor[];
  specialists: Specialist[];
}

/**
 * 设置 › 专家: the reusable instruction-and-tool bundles a run can dispatch to.
 *
 * Built-ins are seeded by the application and read-only; their one editable
 * field is whether they appear in the task tool's enum at all. A user-created
 * specialist is always enabled, so the switch is drawn only where it means
 * something.
 *
 * The new action and each custom row share a form over the list.
 */
export function SpecialistsSettings({ client, onCancelCreate, onConfirm }: Props) {
  const loaded = useLoaded<Page>(async () => {
    const [specialists, connectors, skills, reviewer] = await Promise.all([
      listSpecialists(client),
      listConnectors(client),
      listSkills(client),
      getReviewerSettings(client),
    ]);
    return { connectors, reviewer, skills, specialists };
  }, { client, key: "specialists" });
  const [editing, setEditing] = useState<Specialist>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const creating = onCancelCreate !== undefined;
  const close = () => {
    setEditing(undefined);
    onCancelCreate?.();
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

  /** 一键启用 / 一键关闭. Only a built-in has a switch of its own — a specialist
   *  the user wrote is always on — so those are the rows this writes. */
  const setAll = async (next: boolean) => {
    const page = loaded.value;
    if (!page) return;
    setBusy(true);
    setFailure(undefined);
    try {
      for (const specialist of page.specialists) {
        if (!specialist.builtIn || (specialist.enabled !== false) === next) continue;
        await updateSpecialist(client, specialist.id, { enabled: next });
      }
      loaded.reload();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  /** The system-wide Reviewer switch. It is not a specialist row the way a
   *  user-written one is — it has no instructions or tools of its own — but it
   *  is the gate every session's automatic review passes through, so it lives
   *  above the list rather than inside it. */
  const setReviewerEnabled = async (current: ReviewerSpecialistSettings, next: boolean) => {
    setBusy(true);
    setFailure(undefined);
    try {
      await updateReviewerSettings(client, { ...current, enabled: next });
      loaded.reload();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const open = editing !== undefined;

  return (
    <LoadGate loaded={loaded}>
      {(page) => (
        <>
          <Group heading={TEXT.settings.system.reviewer.heading}>
            <Row
              hint={TEXT.settings.system.reviewer.hint}
              title={TEXT.settings.system.reviewer.label}
            >
              <Switch
                disabled={busy}
                label={TEXT.settings.system.reviewer.label}
                onChange={(next) => void setReviewerEnabled(page.reviewer, next)}
                value={page.reviewer.enabled}
              />
            </Row>
          </Group>
          <Group>
            <p className="settings-note">{TEXT.settings.system.specialists.help}</p>
            {page.specialists.length === 0 ? (
              <p className="settings-empty">{TEXT.settings.system.specialists.empty}</p>
            ) : (
              <div className="settings-list">
                <BulkToggles busy={busy} onAll={(next) => void setAll(next)} />
                {page.specialists.map((specialist) => {
                  const on = specialist.enabled !== false;
                  return (
                    <div className={`settings-card is-expandable${on ? "" : " is-off"}`} key={specialist.id}>
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
                              onClick={() => setEditing(specialist)}
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

          {creating || editing !== undefined ? (
            <SpecialistForm
              client={client}
              connectors={page.connectors}
              key={creating ? "create" : editing?.id}
              onCancel={close}
              onSaved={() => {
                close();
                loaded.reload();
              }}
              specialist={creating ? undefined : editing}
              skills={page.skills}
            />
          ) : null}

          {failure ? <small className="row-note is-error">{failure}</small> : null}
        </>
      )}
    </LoadGate>
  );
}

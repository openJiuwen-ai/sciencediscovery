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
import { testModel } from "../../api/models.js";
import type { ModelProfile } from "../../api/types.js";
import type { WorkspaceActions, WorkspaceState } from "../../app/use-workspace.js";
import { TEXT } from "../../text.js";
import { ModelForm } from "../ModelForm.js";
import { providerName } from "../provider-name.js";
import { Tag } from "./rows.js";

interface Props {
  actions: WorkspaceActions;
  /** The modal's open state lives in the page header, where the handoff puts
   *  the 添加模型 button; this panel owns the modal it opens. */
  adding: boolean;
  client: ApiClient;
  onAddingChange: (next: boolean) => void;
  state: WorkspaceState;
}

const TONES = ["tone-1", "tone-2", "tone-3", "tone-4", "tone-5", "tone-6"];

/**
 * 设置 › 模型, in the handoff's shape: one row per profile, the add button in
 * the page's top corner, and the form in a modal.
 *
 * A row's actions are the lifecycle this service actually exposes: test the
 * connection, make the profile the default, and delete. Deletion is drawn but
 * disabled — there is no delete route, and a button that silently did nothing
 * would be worse than one that says so. There is no per-profile edit either:
 * changing a provider's key is the 添加模型 form with the same endpoint, which
 * is a different job from editing one row, so the row does not pretend to
 * offer it.
 */
export function ModelSettings({ actions, adding, client, onAddingChange, state }: Props) {
  const [probing, setProbing] = useState<string>();
  const [probe, setProbe] = useState<Record<string, string>>({});

  const isDefault = (profile: ModelProfile) => profile.id === state.defaultModelId;

  const probeModel = async (profile: ModelProfile) => {
    setProbing(profile.id);
    try {
      const result = await testModel(client, profile.id);
      setProbe((current) => ({
        ...current,
        [profile.id]: result.ok
          ? TEXT.settings.model.testOk(result.latencyMs)
          : TEXT.settings.model.testFailed(result.message || TEXT.errors.generic),
      }));
    } catch (reason) {
      setProbe((current) => ({
        ...current,
        [profile.id]: TEXT.settings.model.testFailed(
          reason instanceof Error ? reason.message : TEXT.errors.generic,
        ),
      }));
    } finally {
      setProbing(undefined);
    }
  };

  return (
    <div className="model-page">
      {state.models.length === 0 ? (
        <p className="settings-empty">{TEXT.settings.model.empty}</p>
      ) : (
        <div className="model-list">
          {state.models.map((profile, index) => {
            const name = providerName(profile.name);
            return (
              <article className="model-row" key={profile.id}>
                <span className={`model-row-mark ${TONES[index % TONES.length]}`} aria-hidden="true">
                  {name.trim().slice(0, 1).toUpperCase()}
                </span>
                <div className="model-row-main">
                  <div className="model-row-title">
                    <strong>{name}</strong>
                    {isDefault(profile) ? <Tag tone="primary">{TEXT.settings.model.default}</Tag> : null}
                  </div>
                  <small>
                    {profile.model}
                    {probe[profile.id] ? <span className="model-row-probe"> · {probe[profile.id]}</span> : null}
                  </small>
                </div>
                <div className="model-row-actions">
                  {isDefault(profile) ? null : (
                    <>
                      <button
                        className="link-button"
                        onClick={() => void actions.setDefaultModel(profile.id)}
                        type="button"
                      >
                        {TEXT.settings.model.setDefault}
                      </button>
                      <span aria-hidden="true" className="sep" />
                    </>
                  )}
                  <button
                    aria-label={TEXT.settings.model.test}
                    className="model-icon-button"
                    disabled={probing === profile.id}
                    onClick={() => void probeModel(profile)}
                    title={TEXT.settings.model.test}
                    type="button"
                  >
                    {probing === profile.id ? <span className="spinner" /> : (
                      <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="15">
                        <path d="M3 12h3l2.2-5 3.4 10 2.6-7 1.8 4H21" />
                      </svg>
                    )}
                  </button>
                  <button
                    aria-label={TEXT.settings.model.delete}
                    className="model-icon-button"
                    disabled
                    title={TEXT.settings.model.deleteUnsupported}
                    type="button"
                  >
                    <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="15">
                      <path d="M4.5 6.5h15M9.5 6.5V4.8c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3v1.7M6.5 6.5l.8 12.2c0 .9.8 1.6 1.7 1.6h6c.9 0 1.7-.7 1.7-1.6l.8-12.2" />
                    </svg>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {adding ? (
        <div className="modal-scrim" onPointerDown={() => onAddingChange(false)}>
          <div
            aria-label={TEXT.settings.model.add}
            aria-modal="true"
            className="model-modal"
            onPointerDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="model-modal-head">
              <h2>{TEXT.settings.model.add}</h2>
              <button
                aria-label={TEXT.settings.close}
                className="model-modal-close"
                onClick={() => onAddingChange(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <ModelForm
              client={client}
              onCancel={() => onAddingChange(false)}
              onConfigured={() => {
                onAddingChange(false);
                void actions.refreshCatalog();
              }}
              onProvidersChanged={actions.refreshCatalog}
              presets={state.presets}
              providers={state.providers}
              submitLabel={TEXT.settings.model.save}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

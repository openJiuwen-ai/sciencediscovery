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
import {
  deleteModel,
  listProviderModels,
  testModel,
  updateModel,
} from "../../api/models.js";
import type { ModelProfile, ModelProvider, ProviderModelList } from "../../api/types.js";
import { useLoaded } from "../../app/use-loaded.js";
import type { WorkspaceActions, WorkspaceState } from "../../app/use-workspace.js";
import { TEXT } from "../../text.js";
import { ModelForm } from "../ModelForm.js";
import { providerName } from "../provider-name.js";
import { ListSelect, type ListChoice } from "./ListSelect.js";
import { Tag } from "./rows.js";
import { SettingsModal } from "./SettingsModal.js";

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
 * connection, make the profile the default, and delete. Deletion goes through
 * the app's confirmation dialog because it is the one action here that cannot
 * be undone, and the service can still refuse it while a project or session
 * names the profile.
 *
 * A row opens in place onto the one field `PUT /api/models` changes without
 * touching the provider, the token, or any session: which model the profile
 * calls, and the name that follows it. For a provider model that field is a
 * dropdown of what the provider reports — the same list 添加模型 chooses from —
 * so switching models never means retyping an id. A standalone profile has no
 * provider to ask, and keeps a free-text name.
 */
export function ModelSettings({ actions, adding, client, onAddingChange, state }: Props) {
  const [probing, setProbing] = useState<string>();
  const [probe, setProbe] = useState<Record<string, string>>({});
  /** Which row is open, and the name being typed into it. */
  const [openId, setOpenId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [renameFailure, setRenameFailure] = useState<string>();
  /** A failed delete, kept on the row it belongs to: once the dialog closes the
   *  row is the only thing that still identifies the action. */
  const [rowFailure, setRowFailure] = useState<{ id: string; message: string }>();

  const isDefault = (profile: ModelProfile) => profile.id === state.defaultModelId;

  const removeProfile = (profile: ModelProfile, name: string) => {
    actions.confirmAction({
      accept: TEXT.settings.model.delete,
      body: TEXT.settings.model.deleteBody,
      eyebrow: name,
      onAccept: async () => {
        setRowFailure(undefined);
        try {
          await deleteModel(client, profile.id);
          await actions.refreshCatalog();
        } catch (reason) {
          setRowFailure({
            id: profile.id,
            message: reason instanceof Error ? reason.message : TEXT.settings.model.deleteFailed,
          });
        }
      },
      title: TEXT.settings.model.deleteConfirm(name),
    });
  };

  const toggleRow = (profile: ModelProfile) => {
    const next = openId === profile.id ? undefined : profile.id;
    setOpenId(next);
    // The stored name is prefilled as it is shown here, not as it is stored:
    // the app's own default gateway name is translated on the way out, and the
    // field should start from the words on screen.
    setDraft(next ? providerName(profile.name) : "");
    setRenameFailure(undefined);
  };

  const saveName = async (profile: ModelProfile) => {
    const name = draft.trim();
    if (name === "") return;
    setSaving(true);
    setRenameFailure(undefined);
    try {
      await updateModel(client, profile, { model: profile.model, name });
      setOpenId(undefined);
      // The name is also the composer's label, so the catalog is what has to be
      // re-read — updating this page's copy alone would leave the menu stale.
      await actions.refreshCatalog();
    } catch (reason) {
      setRenameFailure(reason instanceof Error ? reason.message : TEXT.settings.model.nameFailed);
    } finally {
      setSaving(false);
    }
  };

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
            const open = openId === profile.id;
            // A provider-backed profile gets the provider's listing to choose
            // from. Without one there is nothing to list, and the name stays a
            // free-text field.
            const provider = profile.providerId === undefined
              ? undefined
              : state.providers.find((candidate) => candidate.id === profile.providerId);
            return (
              <article className={`model-row${open ? " is-open" : ""}`} key={profile.id}>
                <span className={`model-row-mark ${TONES[index % TONES.length]}`} aria-hidden="true">
                  {name.trim().slice(0, 1).toUpperCase()}
                </span>
                <button
                  aria-expanded={open}
                  className="model-row-main"
                  onClick={() => toggleRow(profile)}
                  title={TEXT.settings.model.expand}
                  type="button"
                >
                  <span className="model-row-title">
                    <strong>{name}</strong>
                    {isDefault(profile) ? <Tag tone="primary">{TEXT.settings.model.default}</Tag> : null}
                  </span>
                  <small>
                    {profile.model}
                    {probe[profile.id] ? <span className="model-row-probe"> · {probe[profile.id]}</span> : null}
                  </small>
                </button>
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
                    onClick={() => removeProfile(profile, name)}
                    title={TEXT.settings.model.delete}
                    type="button"
                  >
                    <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="15">
                      <path d="M4.5 6.5h15M9.5 6.5V4.8c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3v1.7M6.5 6.5l.8 12.2c0 .9.8 1.6 1.7 1.6h6c.9 0 1.7-.7 1.7-1.6l.8-12.2" />
                    </svg>
                  </button>
                </div>
                {open ? (
                  <div className="model-row-detail">
                    {provider ? (
                      <ModelPicker
                        client={client}
                        onChanged={actions.refreshCatalog}
                        profile={profile}
                        provider={provider}
                      />
                    ) : (
                      <>
                        <label className="model-field">
                          <span>{TEXT.settings.model.name}</span>
                          <input
                            className="field-input"
                            disabled={saving}
                            onChange={(event) => setDraft(event.target.value)}
                            spellCheck={false}
                            value={draft}
                          />
                        </label>
                        <small className="field-help">{TEXT.settings.model.nameHint}</small>
                        {draft.trim() === "" ? (
                          <small className="row-note is-error">{TEXT.settings.model.nameRequired}</small>
                        ) : null}
                        {renameFailure ? <small className="row-note is-error">{renameFailure}</small> : null}
                        <div className="model-row-detail-actions">
                          <button
                            className="secondary-button"
                            disabled={saving}
                            onClick={() => setOpenId(undefined)}
                            type="button"
                          >
                            {TEXT.settings.model.cancel}
                          </button>
                          <button
                            className="primary-button"
                            disabled={saving || draft.trim() === "" || draft.trim() === name}
                            onClick={() => void saveName(profile)}
                            type="button"
                          >
                            {TEXT.settings.model.save}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
                {rowFailure?.id === profile.id ? (
                  <small className="row-note is-error model-row-failure">{rowFailure.message}</small>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {adding ? (
        <SettingsModal label={TEXT.settings.model.add} onClose={() => onAddingChange(false)}>
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
        </SettingsModal>
      ) : null}
    </div>
  );
}

/**
 * What the dropdown offers for a provider-backed profile: the provider's own
 * listing, with a model another profile already covers marked and
 * unselectable, and with the saved model always present.
 *
 * The saved model has to stay even when the listing no longer names it: the
 * field is what shows the profile's current model, and an empty field would
 * say the profile had none. It also has to stay while the listing is still
 * loading, for the same reason.
 */
export function providerChoices(
  list: ProviderModelList | undefined,
  profile: ModelProfile,
): ListChoice[] {
  const labelOf = (entry: { displayName?: string; id: string }) => entry.displayName || entry.id;
  const choices: ListChoice[] = (list ? [...list.models] : []).map((entry) => {
    const taken = entry.profileId !== undefined && entry.profileId !== profile.id;
    return {
      ...(taken ? { badge: TEXT.settings.model.addedOption, disabled: true } : {}),
      label: entry.displayName && entry.displayName !== entry.id
        ? `${labelOf(entry)} · ${entry.id}`
        : labelOf(entry),
      value: entry.id,
    };
  });
  if (!choices.some((entry) => entry.value === profile.model)) {
    choices.unshift({ label: profile.model, value: profile.model });
  }
  return choices;
}

/**
 * The model field of a profile that belongs to a provider.
 *
 * The options are what the provider reports, read through the service so the
 * key never reaches the browser. A model another profile already covers is
 * marked and cannot be chosen: the service keys a provider profile by provider
 * and model, so picking it here would leave two profiles claiming one pair.
 * `刷新列表` bypasses the service's cache, which exists so two reads in one
 * visit do not spend two requests on the vendor.
 *
 * Choosing is saving. There is no separate button to press, because the only
 * thing this row edits is which model the profile calls — a value picked from
 * a list of valid ones — so a confirmation step would only ask the user to say
 * the same thing twice.
 */
export function ModelPicker({
  client,
  onChanged,
  profile,
  provider,
}: {
  client: ApiClient;
  /** Re-read the model catalog so the composer's menu follows the new name. */
  onChanged: () => Promise<void>;
  profile: ModelProfile;
  provider: ModelProvider;
}) {
  const [force, setForce] = useState(false);
  const [choice, setChoice] = useState(profile.model);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const loaded = useLoaded<ProviderModelList>(() => listProviderModels(client, provider.id, force));

  const list = loaded.value;
  const labelOf = (entry: { displayName?: string; id: string }) => entry.displayName || entry.id;
  const choices = providerChoices(list, profile);

  // Picking is the write: there is no save button, so the dropdown's value is
  // what the service was told. A failed write puts the field back on the model
  // the profile is still on, so the field never claims a change that did not
  // happen.
  const choose = async (next: string) => {
    if (saving || next === profile.model) return;
    setChoice(next);
    setSaving(true);
    setFailure(undefined);
    try {
      // The service names a provider profile after the provider and the
      // model, so a switch carries the new label with it rather than leaving
      // the old model's name on the row.
      const entry = list?.models.find((candidate) => candidate.id === next);
      await updateModel(client, profile, {
        model: next,
        name: `${provider.name} · ${entry ? labelOf(entry) : next}`,
      });
      await onChanged();
    } catch (reason) {
      setChoice(profile.model);
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.model.switchFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="model-pick-row">
        <ListSelect
          choices={choices}
          disabled={saving || loaded.loading}
          label={TEXT.settings.model.name}
          onChange={(next) => void choose(next)}
          value={choice}
        />
        <button
          className="model-refresh"
          disabled={saving || loaded.loading}
          onClick={() => {
            setForce(true);
            loaded.reload();
          }}
          title={TEXT.settings.model.providerRefreshHint}
          type="button"
        >
          {loaded.loading ? (
            <span className="spinner" />
          ) : (
            <svg
              aria-hidden="true"
              fill="none"
              height="13"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
              width="13"
            >
              <path d="M20 11a8 8 0 1 0-2.3 6.4M20 5v6h-6" />
            </svg>
          )}
          {loaded.loading ? TEXT.settings.model.refreshing : TEXT.settings.model.providerRefresh}
        </button>
      </div>
      <div className="model-picker-meta">
        <small className="field-help">
          {saving ? TEXT.settings.model.saving : TEXT.settings.model.pickHint}
        </small>
        <small className="settings-detail-meta model-picker-source">
          {TEXT.settings.model.providerSource}
          {list ? ` · ${new Date(list.fetchedAt).toLocaleString()}` : ""}
        </small>
      </div>
      {loaded.error ? <small className="row-note is-error">{loaded.error}</small> : null}
      {failure ? <small className="row-note is-error">{failure}</small> : null}
    </>
  );
}

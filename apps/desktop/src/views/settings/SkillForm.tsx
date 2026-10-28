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
import { createSkill } from "../../api/settings.js";
import type { CreateSkillPackageRequest, SkillDetail } from "../../api/types.js";
import { TEXT } from "../../text.js";

interface Props {
  client: ApiClient;
  /** Called when 取消, × or the scrim closes the form. */
  onCancel: () => void;
  /** Called after the server has installed the package, with what it installed;
   *  the list reloads behind the modal, so the caller closes it here. */
  onSaved: (skill: SkillDetail) => void;
}

interface Draft {
  compatibility: string;
  description: string;
  instructions: string;
  license: string;
  name: string;
  version: string;
}

/** SKILL.md's name is also the package directory, so the server accepts only
 *  this shape — the same rule the catalog enforces on import. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX_LENGTH = 64;
const DESCRIPTION_MAX_LENGTH = 1024;

function emptyDraft(): Draft {
  return {
    compatibility: "",
    description: "",
    instructions: "",
    license: "",
    name: "",
    version: "",
  };
}

function bodyOf(draft: Draft): CreateSkillPackageRequest {
  const version = draft.version.trim();
  const license = draft.license.trim();
  const compatibility = draft.compatibility.trim();
  return {
    description: draft.description.trim(),
    instructions: draft.instructions,
    name: draft.name.trim(),
    ...(compatibility === "" ? {} : { compatibility }),
    ...(license === "" ? {} : { license }),
    ...(version === "" ? {} : { metadata: { version } }),
  };
}

/**
 * The form behind 技能's 新增技能.
 *
 * The API takes authored fields rather than Markdown: `createPackage` writes
 * SKILL.md from them and installs revision 1. Optional frontmatter is kept in
 * the same form so a skill can declare a license or version without a second
 * round of editing.
 */
export function SkillForm({ client, onCancel, onSaved }: Props) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const trimmedName = draft.name.trim();
  const nameValid = SKILL_NAME.test(trimmedName);
  const ready = nameValid
    && draft.description.trim() !== ""
    && draft.instructions.trim() !== "";

  const save = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      onSaved(await createSkill(client, bodyOf(draft)));
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-card is-form">
      <div className="settings-card-form">
        <label className="settings-field">
          <span className="settings-field-head">
            <span className="settings-field-label">{TEXT.settings.skills.name}</span>
            <span className="settings-field-count">{draft.name.length} / {NAME_MAX_LENGTH}</span>
          </span>
          <input
            aria-label={TEXT.settings.skills.name}
            autoFocus
            className="field-input"
            disabled={busy}
            maxLength={NAME_MAX_LENGTH}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder={TEXT.settings.skills.namePlaceholder}
            spellCheck={false}
            value={draft.name}
          />
          <span className={`settings-field-hint${trimmedName !== "" && !nameValid ? " is-error" : ""}`}>
            {trimmedName !== "" && !nameValid
              ? TEXT.settings.skills.nameInvalid
              : TEXT.settings.skills.nameHint}
          </span>
        </label>
        <label className="settings-field">
          <span className="settings-field-head">
            <span className="settings-field-label">{TEXT.settings.skills.description}</span>
            <span className="settings-field-count">{draft.description.length} / {DESCRIPTION_MAX_LENGTH}</span>
          </span>
          <textarea
            aria-label={TEXT.settings.skills.description}
            className="field-textarea"
            disabled={busy}
            maxLength={DESCRIPTION_MAX_LENGTH}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            placeholder={TEXT.settings.skills.descriptionPlaceholder}
            rows={3}
            value={draft.description}
          />
        </label>
        <div className="settings-field-pair">
          <label className="settings-field">
            <span className="settings-field-label">{TEXT.settings.skills.license}</span>
            <input
              aria-label={TEXT.settings.skills.license}
              className="field-input"
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, license: event.target.value })}
              placeholder={TEXT.settings.skills.licensePlaceholder}
              value={draft.license}
            />
          </label>
          <label className="settings-field">
            <span className="settings-field-label">{TEXT.settings.skills.version}</span>
            <input
              aria-label={TEXT.settings.skills.version}
              className="field-input"
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, version: event.target.value })}
              placeholder={TEXT.settings.skills.versionPlaceholder}
              value={draft.version}
            />
          </label>
        </div>
        <label className="settings-field">
          <span className="settings-field-label">{TEXT.settings.skills.compatibility}</span>
          <input
            aria-label={TEXT.settings.skills.compatibility}
            className="field-input"
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, compatibility: event.target.value })}
            placeholder={TEXT.settings.skills.compatibilityPlaceholder}
            value={draft.compatibility}
          />
        </label>
        <label className="settings-field">
          <span className="settings-field-label">{TEXT.settings.skills.instructions}</span>
          <textarea
            aria-label={TEXT.settings.skills.instructions}
            className="field-textarea"
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
            placeholder={TEXT.settings.skills.instructionsPlaceholder}
            rows={10}
            value={draft.instructions}
          />
        </label>
        {failure ? <small className="row-note is-error">{failure}</small> : null}
        <div className="settings-card-actions">
          <button className="secondary-button" disabled={busy} onClick={onCancel} type="button">
            {TEXT.settings.cancel}
          </button>
          <button
            className="primary-button"
            disabled={busy || !ready}
            onClick={() => void save()}
            type="button"
          >
            {TEXT.settings.skills.create}
          </button>
        </div>
      </div>
    </div>
  );
}

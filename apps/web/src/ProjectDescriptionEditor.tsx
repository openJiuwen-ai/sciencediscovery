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

import { useState, type FormEvent } from "react";

import type { Project } from "@sciencediscovery/schema";

import { useLocale } from "./i18n/index.js";
import { InlineErrorAlert } from "./InlineErrorAlert.js";

export function ProjectDescriptionEditor({ project, onSave }: {
  project: Project;
  onSave: (description: string) => Promise<void>;
}) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await onSave(draft.trim());
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("project.descriptionSaveError"));
    } finally {
      setSaving(false);
    }
  }

  return <section aria-label={t("project.description")} className="project-description">
    {editing ? <form onSubmit={(event) => void submit(event)}>
      <label>
        <span>{t("project.description")}</span>
        <textarea autoFocus disabled={saving} maxLength={2000} onChange={(event) => setDraft(event.target.value)}
          placeholder={t("project.descriptionPlaceholder")} rows={4} value={draft} />
      </label>
      {error ? <InlineErrorAlert detail={error} /> : null}
      <div className="dialog-actions">
        <button className="secondary-button" disabled={saving} onClick={() => setEditing(false)} type="button">{t("common.cancel")}</button>
        <button className="primary-button" disabled={saving} type="submit">{saving ? t("common.saving") : t("project.saveDescription")}</button>
      </div>
    </form> : <>
      <div className="project-description-heading">
        <strong>{t("project.description")}</strong>
        <button className="secondary-button compact-button" onClick={() => {
          setDraft(project.description ?? "");
          setError(undefined);
          setEditing(true);
        }} type="button">{t(project.description ? "project.editDescription" : "project.addDescription")}</button>
      </div>
      {project.description ? <p className="project-description-text">{project.description}</p> : null}
    </>}
  </section>;
}

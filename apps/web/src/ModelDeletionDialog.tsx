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

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelProfile } from "@sciencediscovery/schema";
import { useLocale } from "./i18n/index.js";

/** Keep replacement choice and destructive confirmation in one user action. */
export function ModelDeletionDialog({ name, models, replacingDefault, onDecision, provider }: {
  name: string;
  provider: boolean;
  models: ModelProfile[];
  replacingDefault: boolean;
  onDecision: (replacement: string | null | false) => void;
}) {
  const { t } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [replacement, setReplacement] = useState(models.length === 1 ? models[0]?.id ?? "" : "");
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return createPortal(<dialog
    aria-label={t(provider ? "providers.delete.confirm" : "providers.models.deleteConfirm", { name })}
    className="deletion-dialog model-deletion-dialog"
    ref={dialog}
    onCancel={event => { event.preventDefault(); onDecision(false); }}
    onKeyDown={event => event.stopPropagation()}
  >
    <h2>{t(provider ? "providers.delete.confirm" : "providers.models.deleteConfirm", { name })}</h2>
    <p>{t("providers.delete.modelWarning")}</p>
    {replacingDefault ? <label className="settings-field">
      <span>{t("providers.delete.replacement")}</span>
      <select autoFocus value={replacement} onChange={event => setReplacement(event.target.value)}>
        <option value="">{t("providers.delete.leaveUnset")}</option>
        {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select>
    </label> : null}
    <div className="dialog-actions">
      <button autoFocus={!replacingDefault} className="secondary-button" onClick={() => onDecision(false)} type="button">{t("common.cancel")}</button>
      <button className="danger-button" onClick={() => onDecision(replacingDefault ? replacement || null : null)} type="button">{t("proxy.server.delete")}</button>
    </div>
  </dialog>, document.body);
}

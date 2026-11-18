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

/**
 * Launch dialog for one Idea Tree research.
 *
 * The settings live here, behind a switch, instead of in 设置, because they describe the
 * research about to start rather than the app: off means the stored defaults, on means
 * this research alone is configured. The command typed in the composer rides into the
 * task field, so the same sentence is not typed twice.
 */

import { useEffect, useRef, useState } from "react";
import type { IdeaResearchView, IdeaTreeSettingsDetails, UpdateIdeaTreeSettingsRequest } from "@sciencediscovery/schema";
import type { ApiClient } from "../../api/client.js";
import { ApiRequestError } from "../../api/client.js";
import { createIdeaResearch } from "../../api/idea-tree.js";
import { getIdeaTreeSettings } from "../../api/settings.js";
import { TEXT } from "../../text.js";
import { IdeaTreeSettingsFields } from "../settings/IdeaTreeSettings.js";
import { Switch } from "../settings/rows.js";

const t = TEXT.ideaTree.create;

export function IdeaTreeCreateDialog({ client, onClose, onStarted, sessionId, task }: {
  client: ApiClient;
  onClose: () => void;
  onStarted: (view: IdeaResearchView) => void;
  sessionId: string;
  task?: string;
}) {
  const [objective, setObjective] = useState(task ?? "");
  const [settings, setSettings] = useState<IdeaTreeSettingsDetails>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let active = true;
    void getIdeaTreeSettings(client)
      .then((value) => { if (active) setSettings(value); })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof ApiRequestError && reason.status === 503 ? t.unavailable : reason instanceof Error ? reason.message : String(reason));
      });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); closeRef.current(); } };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, []);

  const start = async () => {
    setBusy(true);
    setError(undefined);
    const overrides: UpdateIdeaTreeSettingsRequest | undefined = settingsOpen && settings
      ? {
          templateId: settings.templateId,
          explorationIntensity: settings.explorationIntensity,
          maxDepth: settings.maxDepth,
          maxNodes: settings.maxNodes,
          scoreDirection: settings.scoreDirection,
          maxTokens: settings.maxTokens ?? null,
          ...(settings.maxTokensPerCall === undefined ? {} : { maxTokensPerCall: settings.maxTokensPerCall }),
          ...(settings.designSystemPrompt === undefined ? {} : { designSystemPrompt: settings.designSystemPrompt }),
          ...(settings.aggregatorSystemPrompt === undefined ? {} : { aggregatorSystemPrompt: settings.aggregatorSystemPrompt }),
          ...(settings.propagateInsightSystemPrompt === undefined ? {} : { propagateInsightSystemPrompt: settings.propagateInsightSystemPrompt }),
          ...(settings.roleThinkingEfforts === undefined ? {} : { roleThinkingEfforts: settings.roleThinkingEfforts }),
        }
      : undefined;
    try {
      const view = await createIdeaResearch(client, sessionId, objective.trim(), overrides);
      onStarted(view);
      onClose();
    } catch (reason: unknown) {
      if (reason instanceof ApiRequestError && reason.status === 503) setError(t.unavailable);
      else setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="config-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-label={t.title} aria-modal="true" className="config-panel evolve-create-dialog" role="dialog">
        <header className="evolve-create-head">
          <div>
            <h2>{t.title}</h2>
            <p>{t.hint}</p>
          </div>
          <button aria-label={TEXT.settings.close} className="icon-button" onClick={onClose} type="button">×</button>
        </header>
        <div className="evolve-create-body">
          <label className="evolve-create-task">
            <span>{t.taskLabel}</span>
            <textarea
              aria-label={t.taskLabel}
              className="field-input settings-textarea"
              onChange={(event) => setObjective(event.target.value)}
              placeholder={t.taskPlaceholder}
              rows={3}
              value={objective}
            />
          </label>
          <div className="evolve-create-settings">
            <Switch label={t.settingsToggle} onChange={setSettingsOpen} value={settingsOpen} />
            <small>{t.settingsHint}</small>
          </div>
          {settingsOpen && settings ? <IdeaTreeSettingsFields onChange={setSettings} value={settings} /> : null}
          {error ? <p className="evolve-create-error" role="alert">{error}</p> : null}
        </div>
        <footer className="dialog-actions">
          <button className="secondary-button" disabled={busy} onClick={onClose} type="button">{t.cancel}</button>
          <button className="primary-button" disabled={busy || !objective.trim() || (settingsOpen && !settings)} onClick={() => void start()} type="button">
            {busy ? t.starting : t.start}
          </button>
        </footer>
      </section>
    </div>
  );
}

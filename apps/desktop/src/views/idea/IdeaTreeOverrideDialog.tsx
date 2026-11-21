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
 * Idea Tree parameters, for one conversation or for the deployment.
 *
 * The card opens from 会话设置's `idea-tree` row. It reads the global settings and
 * offers the two writes the setting now has: the Session override, which the
 * next research started in this conversation freezes and every later one
 * re-reads, and the global settings themselves. Cancel writes nothing, and the
 * dialog never sends a message — the composer keeps the last word.
 *
 * The six fields are the ones the settings catalog exposes; the per-call token
 * cap that used to sit among them was removed (#1281) and is not offered here.
 */

import { useEffect, useState } from "react";

import type { IdeaTreeSettingsDetails, IdeaTreeSettingsOverride, UpdateIdeaTreeSettingsRequest } from "@sciencediscovery/schema";

import type { ApiClient } from "../../api/client.js";
import { updateSession } from "../../api/sessions.js";
import { getIdeaTreeSettings, updateIdeaTreeSettings } from "../../api/settings.js";
import { TEXT } from "../../text.js";
import { claimsEscape } from "../dialog-escape.js";

const t = TEXT.ideaTreeOverride;

/** The five fields a layer may override, taken from a full settings object. */
function overrideOf(settings: IdeaTreeSettingsDetails): IdeaTreeSettingsOverride {
  return {
    explorationIntensity: settings.explorationIntensity,
    maxDepth: settings.maxDepth,
    maxNodes: settings.maxNodes,
    scoreDirection: settings.scoreDirection,
    templateId: settings.templateId,
  };
}

function numberFrom(raw: string, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function IdeaTreeOverrideDialog({
  client,
  onClose,
  sessionId,
}: {
  client: ApiClient;
  onClose: () => void;
  /** The conversation whose research settings would change; absent on the
   *  landing page, where there is nothing to override yet. */
  sessionId?: string;
}) {
  const [draft, setDraft] = useState<IdeaTreeSettingsDetails>();
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "session" | "global" | "failed">("loading");
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    getIdeaTreeSettings(client)
      .then((value) => {
        if (cancelled) return;
        setDraft(value);
        setStatus("idle");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setFailure(reason instanceof Error ? reason.message : String(reason));
        setStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onKey = (event: KeyboardEvent) => {
      if (!claimsEscape(event)) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const patch = (next: Partial<IdeaTreeSettingsDetails>) => {
    setDraft((current) => (current ? { ...current, ...next } : current));
    setStatus("idle");
    setFailure(undefined);
  };

  const saveSession = async () => {
    if (!draft || !sessionId) return;
    setStatus("saving");
    setFailure(undefined);
    try {
      await updateSession(client, sessionId, { ideaTreeOverride: overrideOf(draft) });
      setStatus("session");
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : String(reason));
      setStatus("failed");
    }
  };

  const saveGlobal = async () => {
    if (!draft) return;
    setStatus("saving");
    setFailure(undefined);
    const body: UpdateIdeaTreeSettingsRequest = {
      ...overrideOf(draft),
      maxTokens: draft.maxTokens ?? null,
    };
    try {
      setDraft(await updateIdeaTreeSettings(client, body));
      setStatus("global");
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : String(reason));
      setStatus("failed");
    }
  };

  const busy = status === "saving";

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        aria-labelledby="idea-tree-override-title"
        aria-modal="true"
        className="modal-panel"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="modal-header">
          <h2 id="idea-tree-override-title">{t.title}</h2>
          <button aria-label={t.cancel} className="modal-close" onClick={onClose} type="button">
            ×
          </button>
        </header>

        <div className="idea-tree-override-body">
          <p className="idea-tree-override-hint">{t.hint}</p>

          {status === "loading" ? <p className="status-strip">{t.loading}</p> : null}

          {draft === undefined ? null : (
            <div className="idea-tree-override-fields">
              <label className="idea-tree-override-field">
                <span>{t.template}</span>
                <select
                  aria-label={t.template}
                  onChange={(event) => patch({ templateId: event.target.value as IdeaTreeSettingsDetails["templateId"] })}
                  value={draft.templateId}
                >
                  <option value="scientific-hypothesis-general/v1">{t.templateGeneral}</option>
                  <option value="water-treatment-materials/v1">{t.templateWater}</option>
                </select>
              </label>

              <label className="idea-tree-override-field">
                <span>{t.intensity}</span>
                <select
                  aria-label={t.intensity}
                  onChange={(event) => patch({ explorationIntensity: event.target.value as IdeaTreeSettingsDetails["explorationIntensity"] })}
                  value={draft.explorationIntensity}
                >
                  <option value="quick">{t.quick}</option>
                  <option value="standard">{t.standard}</option>
                  <option value="deep">{t.deep}</option>
                </select>
              </label>

              <label className="idea-tree-override-field">
                <span>{t.direction}</span>
                <select
                  aria-label={t.direction}
                  onChange={(event) => patch({ scoreDirection: event.target.value as IdeaTreeSettingsDetails["scoreDirection"] })}
                  value={draft.scoreDirection}
                >
                  <option value="maximize">{t.maximize}</option>
                  <option value="minimize">{t.minimize}</option>
                </select>
              </label>

              <label className="idea-tree-override-field">
                <span>{t.maxDepth}</span>
                <input
                  aria-label={t.maxDepth}
                  min={1}
                  onChange={(event) => patch({ maxDepth: numberFrom(event.target.value, draft.maxDepth) })}
                  type="number"
                  value={draft.maxDepth}
                />
              </label>

              <label className="idea-tree-override-field">
                <span>{t.maxNodes}</span>
                <input
                  aria-label={t.maxNodes}
                  min={2}
                  onChange={(event) => patch({ maxNodes: numberFrom(event.target.value, draft.maxNodes) })}
                  type="number"
                  value={draft.maxNodes}
                />
              </label>
            </div>
          )}

          {sessionId === undefined ? <p className="idea-tree-override-note">{t.noSession}</p> : null}
          {failure === undefined ? null : <p className="idea-tree-override-failure" role="alert">{failure}</p>}
          {status === "session" ? <p className="idea-tree-override-note" role="status">{t.savedSession}</p> : null}
          {status === "global" ? <p className="idea-tree-override-note" role="status">{t.savedGlobal}</p> : null}
        </div>

        <footer className="modal-actions">
          <button className="button-secondary" disabled={busy} onClick={onClose} type="button">{t.cancel}</button>
          <button className="button-secondary" disabled={busy || draft === undefined || sessionId === undefined} onClick={() => void saveSession()} type="button">
            {t.saveSession}
          </button>
          <button className="button-primary" disabled={busy || draft === undefined} onClick={() => void saveGlobal()} type="button">
            {t.saveGlobal}
          </button>
        </footer>
      </div>
    </div>
  );
}

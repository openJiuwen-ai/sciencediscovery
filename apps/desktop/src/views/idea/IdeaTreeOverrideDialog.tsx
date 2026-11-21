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
 * The fields are drawn with the same Group/Row/Select the Idea Tree settings
 * page uses, so the card reads as that form rather than a lookalike, and the
 * actions carry the evolve dialog's own button classes.
 *
 * The five fields are the ones the settings catalog exposes; the per-call token
 * cap that used to sit among them was removed (#1281) and is not offered here.
 */

import { useEffect, useState } from "react";

import type { IdeaTreeSettingsDetails, IdeaTreeSettingsOverride, RuntimeSettingsDetails, UpdateIdeaTreeSettingsRequest } from "@sciencediscovery/schema";

import type { ApiClient } from "../../api/client.js";
import { getSessionSettings, updateSession } from "../../api/sessions.js";
import { getIdeaTreeSettings, updateIdeaTreeSettings } from "../../api/settings.js";
import { TEXT } from "../../text.js";
import { claimsEscape } from "../dialog-escape.js";
import { Group, Row, Select } from "../settings/rows.js";

const t = TEXT.ideaTreeOverride;
const fields = TEXT.settings.system.ideaTree;

/** Only the fields this Session means to change. Sending all five would pin the
 *  whole set at the global values of the moment, so a later global edit would
 *  stop reaching this Session — the opposite of what the override is for. */
function overrideOf(
  settings: IdeaTreeSettingsDetails,
  inherited: IdeaTreeSettingsDetails,
): IdeaTreeSettingsOverride {
  const override: IdeaTreeSettingsOverride = {};
  if (settings.templateId !== inherited.templateId) override.templateId = settings.templateId;
  if (settings.explorationIntensity !== inherited.explorationIntensity) {
    override.explorationIntensity = settings.explorationIntensity;
  }
  if (settings.scoreDirection !== inherited.scoreDirection) override.scoreDirection = settings.scoreDirection;
  if (settings.maxDepth !== inherited.maxDepth) override.maxDepth = settings.maxDepth;
  if (settings.maxNodes !== inherited.maxNodes) override.maxNodes = settings.maxNodes;
  return override;
}

/** A number the card may hold. Both write paths reject anything else — the
 *  Session normalizer wants an integer in range, the global editor the same — so
 *  an emptied box or `3.5` keeps the previous value instead of producing a form
 *  that cannot be saved. */
function integerFrom(raw: string, min: number, max: number, fallback: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

const TEMPLATES = [
  { label: fields.templateGeneral, value: "scientific-hypothesis-general/v1" },
  { label: fields.templateWater, value: "water-treatment-materials/v1" },
];
const INTENSITIES = [
  { label: fields.quick, value: "quick" },
  { label: fields.standard, value: "standard" },
  { label: fields.deep, value: "deep" },
];
const DIRECTIONS = [
  { label: fields.maximize, value: "maximize" },
  { label: fields.minimize, value: "minimize" },
];

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
  /** The deployment values: what each field falls back to. */
  const [inherited, setInherited] = useState<IdeaTreeSettingsDetails>();
  /** Whether this Session pins anything today, which is what 跟随全局 can undo. */
  const [hasOverride, setHasOverride] = useState(false);
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "session" | "global" | "failed">("loading");
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    // The global values are what every unpinned field follows; the Session's own
    // record says which fields it pinned. Opening on the global values alone
    // would show 5 for a Session that runs with 3, and re-saving would re-pin.
    Promise.all([
      getIdeaTreeSettings(client),
      sessionId === undefined ? Promise.resolve(undefined) : getSessionSettings(client, sessionId),
    ])
      .then(([value, session]: [IdeaTreeSettingsDetails, RuntimeSettingsDetails | undefined]) => {
        if (cancelled) return;
        const pinned = session?.overrides?.ideaTreeOverride ?? {};
        setDraft({ ...value, ...pinned });
        setInherited(value);
        setHasOverride(Object.keys(pinned).length > 0);
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
  }, [client, sessionId]);

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
    const override = overrideOf(draft, inherited ?? draft);
    // Nothing differs from what the card opened with: the Session already runs
    // with these values, so there is nothing to override and no write to make.
    if (Object.keys(override).length === 0) {
      setStatus("session");
      return;
    }
    setStatus("saving");
    setFailure(undefined);
    try {
      await updateSession(client, sessionId, { ideaTreeOverride: override });
      setHasOverride(true);
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
      ...overrideOf(draft, inherited ?? draft),
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

  /** Hand the Session back to the global settings. */
  const inheritGlobal = async () => {
    if (!sessionId) return;
    setStatus("saving");
    setFailure(undefined);
    try {
      await updateSession(client, sessionId, { ideaTreeOverride: null });
      setDraft(inherited);
      setHasOverride(false);
      setStatus("session");
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

        <div className="evolve-create-body">
          <p className="evolve-create-confirm-hint">{t.hint}</p>
          {hasOverride ? <p className="evolve-create-confirm-hint" role="note">{t.pinned}</p> : null}

          {status === "loading" ? <p className="status-strip">{t.loading}</p> : null}

          {draft === undefined ? null : (
            <Group heading={fields.scopeHeading}>
              <Row hint={fields.templateHint} title={fields.template}>
                <Select
                  label={fields.template}
                  onChange={(value) => patch({ templateId: value as IdeaTreeSettingsDetails["templateId"] })}
                  options={TEMPLATES}
                  value={draft.templateId}
                />
              </Row>
              <Row hint={fields.intensityHint} title={fields.intensity}>
                <Select
                  label={fields.intensity}
                  onChange={(value) => patch({ explorationIntensity: value as IdeaTreeSettingsDetails["explorationIntensity"] })}
                  options={INTENSITIES}
                  value={draft.explorationIntensity}
                />
              </Row>
              <Row hint={fields.directionHint} title={fields.direction}>
                <Select
                  label={fields.direction}
                  onChange={(value) => patch({ scoreDirection: value as IdeaTreeSettingsDetails["scoreDirection"] })}
                  options={DIRECTIONS}
                  value={draft.scoreDirection}
                />
              </Row>
              <Row hint={fields.maxDepthHint} title={fields.maxDepth}>
                <input
                  aria-label={fields.maxDepth}
                  className="field-input"
                  min={1}
                  max={20}
                  onChange={(event) => patch({ maxDepth: integerFrom(event.target.value, 1, 20, draft.maxDepth) })}
                  type="number"
                  value={draft.maxDepth}
                />
              </Row>
              <Row hint={fields.maxNodesHint} title={fields.maxNodes}>
                <input
                  aria-label={fields.maxNodes}
                  className="field-input"
                  min={2}
                  max={10000}
                  onChange={(event) => patch({ maxNodes: integerFrom(event.target.value, 2, 10_000, draft.maxNodes) })}
                  type="number"
                  value={draft.maxNodes}
                />
              </Row>
            </Group>
          )}

          {sessionId === undefined ? <p className="evolve-create-confirm-hint">{t.noSession}</p> : null}
          {failure === undefined ? null : <p className="evolve-create-blocked" role="alert">{failure}</p>}
          {status === "session" ? <p className="evolve-create-confirm-hint" role="status">{t.savedSession}</p> : null}
          {status === "global" ? <p className="evolve-create-confirm-hint" role="status">{t.savedGlobal}</p> : null}

          <div className="evolve-create-footer">
            <button className="evolve-create-cancel" onClick={onClose} type="button">{t.cancel}</button>
            <button
              className="evolve-create-cancel"
              disabled={busy || draft === undefined || sessionId === undefined}
              onClick={() => void saveSession()}
              type="button"
            >
              {t.saveSession}
            </button>
            <button
              className="evolve-create-cancel"
              disabled={busy || sessionId === undefined || !hasOverride}
              onClick={() => void inheritGlobal()}
              type="button"
            >
              {t.inheritGlobal}
            </button>
            <button className="evolve-create-submit" disabled={busy || draft === undefined} onClick={() => void saveGlobal()} type="button">
              {t.saveGlobal}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

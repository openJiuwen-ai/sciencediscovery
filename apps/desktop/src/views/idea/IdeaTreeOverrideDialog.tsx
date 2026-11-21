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

import { useEffect, useRef, useState } from "react";

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
  onConfirm,
  sessionId,
}: {
  client: ApiClient;
  onClose: () => void;
  /** Present when an Idea Tree command is waiting for this card: confirming
   *  writes the Session override and then lets the shell send the command. */
  onConfirm?: () => void;
  /** The conversation whose research settings would change; absent on the
   *  landing page, where there is nothing to override yet. */
  sessionId?: string;
}) {
  const [draft, setDraft] = useState<IdeaTreeSettingsDetails>();
  /** The deployment values: what each field falls back to, and what a Session
   *  override is measured against. */
  const [inherited, setInherited] = useState<IdeaTreeSettingsDetails>();
  /** The values the card opened with — global plus this Session's pins. The
   *  global write is measured against these, so opening a pinned Session and
   *  pressing 覆盖全局设置 without editing cannot write the pin into the
   *  deployment. */
  const [opened, setOpened] = useState<IdeaTreeSettingsDetails>();
  /** What this Session pins, as the server has it. The form is rebuilt from the
   *  deployment *plus* these after any global write: showing the deployment
   *  alone would hide a pin that is still in force, and the card would claim the
   *  conversation moved to a value it does not run with. */
  const [pins, setPins] = useState<IdeaTreeSettingsOverride>({});
  /** Whether this Session pins anything today, which is what 跟随全局 can undo. */
  const [hasOverride, setHasOverride] = useState(false);
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "session" | "global" | "unchanged" | "failed">("loading");
  const [failure, setFailure] = useState<string>();
  /** Set the moment the card is dismissed. A write that resolves afterwards must
   *  not confirm a command the reader cancelled — that would start a long, costly
   *  research against an explicit cancel. */
  const closed = useRef(false);

  const close = () => {
    closed.current = true;
    onClose();
  };

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
        const start = { ...value, ...pinned };
        setDraft(start);
        setOpened(start);
        setInherited(value);
        setPins(pinned);
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
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Unmounting is a dismissal too: a write that lands after it must stay silent.
  useEffect(() => () => { closed.current = true; }, []);

  const patch = (next: Partial<IdeaTreeSettingsDetails>) => {
    setDraft((current) => (current ? { ...current, ...next } : current));
    setStatus("idle");
    setFailure(undefined);
  };

  const saveSession = async () => {
    if (!draft || !sessionId) {
      // Nothing to store (no Session, or the settings never loaded) — but the
      // command the card is holding still has to leave.
      if (!closed.current) onConfirm?.();
      return;
    }
    const override = overrideOf(draft, inherited ?? draft);
    const empty = Object.keys(override).length === 0;
    // An empty diff means two different things. With nothing pinned it means the
    // Session already runs with these values, so there is nothing to write. With
    // pins in place it is the natural undo — the reader put every field back to
    // the deployment value — and the write has to happen, or the Session keeps
    // the pins it no longer shows.
    if (empty && !hasOverride) {
      setStatus("session");
      // Nothing to store — but a waiting command still has to leave: the card
      // being confirmed is what lets it out, not the write.
      onConfirm?.();
      return;
    }
    setStatus("saving");
    setFailure(undefined);
    try {
      // The stored pin set becomes exactly this payload — `updateSession`
      // normalizes it on its own. That is safe only because `draft` starts from
      // the pins in force, so every pin the reader kept is in `override`; an
      // empty object is how the normalizer is told "no override".
      await updateSession(client, sessionId, { ideaTreeOverride: override });
      setPins(override);
      setHasOverride(!empty);
      if (closed.current) return;
      setStatus("session");
      onConfirm?.();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : String(reason));
      setStatus("failed");
    }
  };

  const saveGlobal = async () => {
    if (!draft) return;
    setStatus("saving");
    setFailure(undefined);
    // Only what this card was used to change. The diff against `inherited`
    // would carry a Session's pins into the deployment as soon as one exists.
    const changed = overrideOf(draft, opened ?? draft);
    const tokensChanged = (draft.maxTokens ?? null) !== (opened?.maxTokens ?? null);
    if (Object.keys(changed).length === 0 && !tokensChanged) {
      setStatus("unchanged");
      return;
    }
    const body: UpdateIdeaTreeSettingsRequest = {
      ...changed,
      ...(tokensChanged ? { maxTokens: draft.maxTokens ?? null } : {}),
    };
    try {
      // Both sides of the diff move: a later Session save would otherwise pin a
      // field at the value it already inherits, and 跟随全局设置 would restore
      // the pre-write numbers. The form is rebuilt from the new deployment plus
      // the pins still in force — `next` alone would drop them from the display
      // while the Session keeps running them.
      const next = await updateIdeaTreeSettings(client, body);
      let inForce = pins;
      if (sessionId !== undefined) {
        try {
          inForce = (await getSessionSettings(client, sessionId)).overrides?.ideaTreeOverride ?? {};
        } catch {
          // A read that fails must not lose the pins the card already knows.
          inForce = pins;
        }
      }
      setInherited(next);
      setPins(inForce);
      setDraft({ ...next, ...inForce });
      setOpened({ ...next, ...inForce });
      setHasOverride(Object.keys(inForce).length > 0);
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
      setOpened(inherited);
      setPins({});
      setHasOverride(false);
      setStatus("session");
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : String(reason));
      setStatus("failed");
    }
  };

  const busy = status === "saving";

  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <div
        aria-labelledby="idea-tree-override-title"
        aria-modal="true"
        className="modal-panel idea-tree-card"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="modal-header">
          <h2 id="idea-tree-override-title">{t.title}</h2>
          <button aria-label={t.cancel} className="modal-close" onClick={close} type="button">
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
          {status === "unchanged" ? <p className="evolve-create-confirm-hint" role="status">{t.unchanged}</p> : null}

          <div className="modal-footer">
            <button className="evolve-create-cancel" onClick={close} type="button">{t.cancel}</button>
            <button
              className="evolve-create-cancel"
              // Only a failed *read* leaves nothing to save, and the discriminator
              // is `draft === undefined`: a failed write keeps the draft, so the
              // reader has to be able to press again and retry. The command entry
              // (onConfirm) stays live either way — it sends without writing.
              disabled={busy
                || (draft === undefined && (onConfirm === undefined || status !== "failed"))
                || (sessionId === undefined && onConfirm === undefined)}
              onClick={() => void saveSession()}
              type="button"
            >
              {onConfirm === undefined ? t.saveSession : t.confirmSend}
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

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
 * 设置 — Idea Tree.
 *
 * Renders `GET /api/settings/idea-tree` and writes it back with the same shape.
 * Every field below exists in `IdeaTreeSettingsDetails`; the rounds / candidates /
 * assessor-weight fields the engine retired are neither shown nor sent, because the
 * store rejects them and a pane typed from the old wording could not compile against
 * the live contract.
 *
 * Two behaviours this page owes the user rather than itself:
 * a 503 means the Evolve sidecar is not ready, which is an actionable prerequisite
 * (start it, then retry) and not an empty form; and a field the server did not return
 * is shown as absent instead of being invented as 0.
 */

import { useEffect, useId, useState } from "react";
import type { IdeaTreeSettingsDetails, UpdateIdeaTreeSettingsRequest } from "@sciencediscovery/schema";
import type { ApiClient } from "../../api/client.js";
import { ApiRequestError } from "../../api/client.js";
import { getIdeaTreeSettings, updateIdeaTreeSettings } from "../../api/settings.js";
import { commitsOnEnter } from "../../app/ime-enter.js";
import { useLoaded } from "../../app/use-loaded.js";
import { TEXT } from "../../text.js";
import { Group, LoadGate, Row, Select } from "./rows.js";

const t = TEXT.settings.system.ideaTree;

const TEMPLATES = [
  { label: t.templateGeneral, value: "scientific-hypothesis-general/v1" },
  { label: t.templateWater, value: "water-treatment-materials/v1" },
];
const INTENSITIES = [
  { label: t.quick, value: "quick" },
  { label: t.standard, value: "standard" },
  { label: t.deep, value: "deep" },
];
const DIRECTIONS = [
  { label: t.maximize, value: "maximize" },
  { label: t.minimize, value: "minimize" },
];

type NumberKey = "maxDepth" | "maxNodes" | "maxTokens";

/** What each numeric box accepts. An empty box has a documented value only for
 *  `maxTokens`, where the API reads `null` as "no per-research cap"; `maxDepth` and
 *  `maxNodes` are required numbers (`packages/schema/src/runtime-settings.ts:352-353`),
 *  so empty text there is a draft the user has not finished and cannot be saved.
 *  The upper bound is the API's own: the store bounds these with
 *  `Number.MAX_SAFE_INTEGER` for tokens (`services/api/src/store/settings.ts:629`),
 *  and every box is checked with `Number.isSafeInteger`. */
type NumberRule = { emptyIsNull: boolean; max: number; min: number };
const NUMBER_RULES: Record<NumberKey, NumberRule> = {
  maxDepth: { emptyIsNull: false, min: 1, max: 20 },
  maxNodes: { emptyIsNull: false, min: 2, max: 10_000 },
  maxTokens: { emptyIsNull: true, min: 1, max: Number.MAX_SAFE_INTEGER },
};
const NUMBER_ROWS: { hint: string; key: NumberKey; placeholder?: string; title: string }[] = [
  { hint: t.maxDepthHint, key: "maxDepth", title: t.maxDepth },
  { hint: t.maxNodesHint, key: "maxNodes", title: t.maxNodes },
  { hint: t.tokensHint, key: "maxTokens", placeholder: t.noCap, title: t.tokens },
];

/** The range a box accepts, said only when the user needs it. */
function refusal(key: NumberKey): string {
  const rule = NUMBER_RULES[key];
  return rule.emptyIsNull ? t.numberOrEmpty(rule.min, rule.max) : t.numberRange(rule.min, rule.max);
}

/**
 * One numeric box edited as text, the shape `SettingsNumber` gives the quota and
 * count rows: the text is a draft, committed on blur or Enter, and text that does
 * not parse is refused with `aria-invalid` and a visible note instead of being
 * dropped at the keystroke that produced it (#1403).
 *
 * The page owns the parse rather than `SettingsNumber` doing it, because one of the
 * three boxes holds `null` ("no cap") and the shared component's value is a number.
 */
function NumberBox({ invalid, label, max, message, min, onCommit, onTextChange, placeholder, value }: {
  invalid: boolean; label: string; max: number; message: string; min: number;
  onCommit: () => void; onTextChange: (text: string, badInput: boolean) => void; placeholder?: string; value: string;
}) {
  // `onInput` as well as `onChange`: React compares the input's `value` between
  // events, and a number input whose text it cannot represent (e.g. `1e999`) keeps
  // reporting `""`, so the change event for the keystroke after it is never
  // dispatched. The native input event still arrives, which is what lets a box the
  // browser calls `badInput` be cleared again instead of staying stuck.
  const read = (input: HTMLInputElement) => onTextChange(input.value, input.validity.badInput);
  // The note is the reason the box is marked, so it is described by the input and
  // not only announced when it appears.
  const note = useId();
  return (
    <div className="settings-number">
      <input
        aria-describedby={invalid ? note : undefined}
        aria-invalid={invalid}
        aria-label={label}
        className="field-input is-number"
        max={max}
        min={min}
        onBlur={onCommit}
        onChange={(event) => read(event.currentTarget)}
        onInput={(event) => read(event.currentTarget)}
        onKeyDown={(event) => { if (commitsOnEnter(event)) { event.preventDefault(); event.currentTarget.blur(); } }}
        placeholder={placeholder}
        type="number"
        value={value}
      />
      {invalid ? <small className="row-note is-error" id={note} role="alert">{message}</small> : null}
    </div>
  );
}

export function IdeaTreeSettings({ client }: { client: ApiClient }) {
  const loaded = useLoaded<IdeaTreeSettingsDetails>(async () => {
    try {
      return await getIdeaTreeSettings(client);
    } catch (reason: unknown) {
      // A 503 is the sidecar, not this form: say what to do instead of rendering an
      // empty page the user would read as "no settings to configure".
      if (reason instanceof ApiRequestError && reason.status === 503) throw new Error(t.unavailable);
      throw reason;
    }
  });
  const [draft, setDraft] = useState<IdeaTreeSettingsDetails>();
  /** Text typed into a numeric box and not committed yet. A committed box drops its
   *  text again, so what it shows is what the form holds. `badInput` marks text the
   *  browser holds but cannot parse, which reads as `""` and must not be mistaken
   *  for an empty box. */
  const [typed, setTyped] = useState<Partial<Record<NumberKey, { badInput?: boolean; invalid: boolean; text?: string }>>>({});
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (loaded.value) setDraft(loaded.value);
  }, [loaded.value]);

  const patch = (next: Partial<IdeaTreeSettingsDetails>) => {
    setDraft((current) => (current ? { ...current, ...next } : current));
    setStatus("idle");
  };

  const typeNumber = (key: NumberKey, text: string, badInput: boolean) => {
    setTyped((current) => ({ ...current, [key]: { badInput, invalid: false, text } }));
    // Editing starts a new attempt, so the previous "saved" note stops describing
    // a form that no longer holds what was saved.
    setStatus("idle");
    setFailure(undefined);
  };

  /** Blur or Enter: the box's text becomes the form's value, or the box says why not.
   *  A refused commit leaves the text in place, so nothing the user typed is replaced
   *  by the value that was there before. */
  const commitNumber = (key: NumberKey) => {
    const entry = typed[key];
    if (entry?.text === undefined) return;
    const rule = NUMBER_RULES[key];
    const raw = entry.text.trim();
    const value = raw === "" ? null : Number(raw);
    // `badInput` is not an empty box: it is text the browser could not turn into a
    // number, so it is refused rather than read as "no cap" for the token row.
    const accepted = !entry.badInput && (value === null
      ? rule.emptyIsNull
      : Number.isSafeInteger(value) && value >= rule.min && value <= rule.max);
    if (!accepted) {
      setTyped((current) => ({ ...current, [key]: { badInput: entry.badInput, invalid: true, text: entry.text } }));
      // A refusal is a new state of the form as well: the earlier "saved" note would
      // otherwise sit next to the error.
      setStatus("idle");
      setFailure(undefined);
      return;
    }
    setTyped((current) => ({ ...current, [key]: { invalid: false } }));
    patch({ [key]: value } as Partial<IdeaTreeSettingsDetails>);
  };

  const refused = NUMBER_ROWS.some(({ key }) => typed[key]?.invalid === true);

  const save = async () => {
    if (!draft || refused) return;
    setStatus("saving");
    setFailure(undefined);
    const body: UpdateIdeaTreeSettingsRequest = {
      templateId: draft.templateId,
      explorationIntensity: draft.explorationIntensity,
      scoreDirection: draft.scoreDirection,
      maxDepth: draft.maxDepth,
      maxNodes: draft.maxNodes,
      // `null` is the API's "no per-research cap"; an empty box means exactly that.
      maxTokens: draft.maxTokens ?? null,
      ...(draft.designSystemPrompt === undefined ? {} : { designSystemPrompt: draft.designSystemPrompt }),
      ...(draft.aggregatorSystemPrompt === undefined ? {} : { aggregatorSystemPrompt: draft.aggregatorSystemPrompt }),
      ...(draft.propagateInsightSystemPrompt === undefined ? {} : { propagateInsightSystemPrompt: draft.propagateInsightSystemPrompt }),
    };
    try {
      const saved = await updateIdeaTreeSettings(client, body);
      setDraft(saved);
      setStatus("saved");
      loaded.reload();
    } catch (reason: unknown) {
      setStatus("failed");
      setFailure(reason instanceof ApiRequestError && reason.status === 503 ? t.unavailable : reason instanceof Error ? reason.message : String(reason));
    }
  };

  const number = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));

  return (
    <LoadGate loaded={loaded}>
      {() => (draft ? (
        <>
          <Group heading={t.scopeHeading}>
            <Row hint={t.templateHint} title={t.template}>
              <Select
                label={t.template}
                onChange={(value) => patch({ templateId: value as IdeaTreeSettingsDetails["templateId"] })}
                options={TEMPLATES}
                value={draft.templateId}
              />
            </Row>
            <Row hint={t.intensityHint} title={t.intensity}>
              <Select
                label={t.intensity}
                onChange={(value) => patch({ explorationIntensity: value as IdeaTreeSettingsDetails["explorationIntensity"] })}
                options={INTENSITIES}
                value={draft.explorationIntensity}
              />
            </Row>
            <Row hint={t.directionHint} title={t.direction}>
              <Select
                label={t.direction}
                onChange={(value) => patch({ scoreDirection: value as IdeaTreeSettingsDetails["scoreDirection"] })}
                options={DIRECTIONS}
                value={draft.scoreDirection}
              />
            </Row>
            {NUMBER_ROWS.map(({ hint, key, placeholder, title }) => {
              const rule = NUMBER_RULES[key];
              return (
                <Row hint={hint} key={key} title={title}>
                  <NumberBox
                    invalid={typed[key]?.invalid === true}
                    label={title}
                    max={rule.max}
                    message={refusal(key)}
                    min={rule.min}
                    onCommit={() => commitNumber(key)}
                    onTextChange={(text, badInput) => typeNumber(key, text, badInput)}
                    placeholder={placeholder}
                    value={typed[key]?.text ?? number(draft[key])}
                  />
                </Row>
              );
            })}
          </Group>
          <Group heading={t.promptsHeading}>
            {([
              ["designSystemPrompt", t.designPrompt, draft.designSystemPrompt],
              ["aggregatorSystemPrompt", t.aggregatorPrompt, draft.aggregatorSystemPrompt],
              ["propagateInsightSystemPrompt", t.propagatePrompt, draft.propagateInsightSystemPrompt],
            ] as const).map(([key, label, value]) => (
              <Row hint={t.promptHint} key={key} title={label} tone="stack">
                <textarea
                  aria-label={label}
                  className="field-input settings-textarea"
                  onChange={(event) => patch({ [key]: event.target.value } as Partial<IdeaTreeSettingsDetails>)}
                  placeholder={t.promptPlaceholder}
                  rows={3}
                  value={value ?? ""}
                />
              </Row>
            ))}
          </Group>
          <div className="settings-actions is-end">
            <button className="primary-button" disabled={status === "saving" || refused} onClick={() => void save()} type="button">
              {status === "saving" ? t.saving : t.save}
            </button>
            {refused ? <small className="row-note is-error" role="alert">{t.invalidNumbers}</small> : null}
            {status === "saved" ? <small role="status">{t.saved}</small> : null}
            {status === "failed" ? <small role="alert">{failure ?? t.failed}</small> : null}
          </div>
        </>
      ) : null)}
    </LoadGate>
  );
}

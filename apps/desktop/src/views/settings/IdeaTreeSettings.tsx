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

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { IdeaTreeSettingsDetails, UpdateIdeaTreeSettingsRequest } from "@sciencediscovery/schema";
import type { ApiClient } from "../../api/client.js";
import { ApiRequestError } from "../../api/client.js";
import { getIdeaTreeSettings, updateIdeaTreeSettings } from "../../api/settings.js";
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

/** The note ids live beside the range table so the inputs' `aria-describedby`
 *  and the notes cannot drift apart. */
const DEPTH_ERROR_ID = "idea-tree-max-depth-error";
const NODES_ERROR_ID = "idea-tree-max-nodes-error";
const TOKENS_ERROR_ID = "idea-tree-max-tokens-error";

/** A number field keeps the text the user typed, so a refused value stays visible
 *  next to its reason instead of silently reverting to the previous number. */
type NumberKey = "maxDepth" | "maxNodes" | "maxTokens";
interface NumberField { text: string; invalid: boolean }
type NumberFields = Record<NumberKey, NumberField>;

function numberText(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function numberFieldsOf(settings: IdeaTreeSettingsDetails): NumberFields {
  return {
    maxDepth: { text: numberText(settings.maxDepth), invalid: false },
    maxNodes: { text: numberText(settings.maxNodes), invalid: false },
    maxTokens: { text: numberText(settings.maxTokens), invalid: false },
  };
}

/** The store's own bounds (`boundedInteger` in services/api/src/store/settings.ts).
 *  Enforcing them in the field means the pane refuses a value the server would
 *  reject with a message after Save, and the note can name the permitted range. */
const RANGES: Record<NumberKey, { min: number; max: number }> = {
  maxDepth: { min: 1, max: 20 },
  maxNodes: { min: 2, max: 10_000 },
  maxTokens: { min: 1, max: Number.MAX_SAFE_INTEGER },
};

/** Read one stored count. Empty text is not a number: `maxTokens` maps it to the
 *  API's `null` ("no per-research cap"), while depth and nodes have no unset value
 *  and refuse it. Everything else must be an integer inside the field's range;
 *  `0`, negatives, fractions, out-of-range values and `1e999` are refused instead
 *  of being folded into a default or reaching the server. */
function parseCount(raw: string, range: { min: number; max: number }): number | undefined {
  if (raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= range.min && value <= range.max ? value : undefined;
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
  const [fields, setFields] = useState<NumberFields>();
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [failure, setFailure] = useState<string>();
  /** Counts user edits — numbers, selects and prompts — so an answer that lands
   *  after one (a reload, or the PUT's own response) cannot replace what the user
   *  typed or "heal" a refused field. `save()` compares the count across its
   *  request for the same reason. */
  const edits = useRef(0);

  useEffect(() => {
    if (!loaded.value || edits.current !== 0) return;
    setDraft(loaded.value);
    setFields(numberFieldsOf(loaded.value));
  }, [loaded.value]);

  const patch = (next: Partial<IdeaTreeSettingsDetails>) => {
    setDraft((current) => (current ? { ...current, ...next } : current));
    setStatus("idle");
  };

  /** A select or prompt edit: the same patch, but it also makes the pane dirty. */
  const editField = (next: Partial<IdeaTreeSettingsDetails>) => {
    edits.current += 1;
    patch(next);
  };

  /** Keep the typed text and refuse invalid numbers on the spot. The draft is only
   *  patched with an accepted value, so a refused `-5` cannot reach the PUT body as
   *  `maxTokens: null`, and Save stays blocked until the text is corrected.
   *
   *  A number input reports text it cannot represent — `1e999` is the example that
   *  started this — as `value === ""` with `validity.badInput === true`. That is not
   *  an empty box: only `badInput === false` plus no text may mean "no cap"/absent. */
  const editNumber = (key: NumberKey, raw: string, badInput: boolean) => {
    edits.current += 1;
    const empty = raw.trim() === "" && !badInput;
    const value = empty ? undefined : parseCount(raw, RANGES[key]);
    const invalid = key === "maxTokens" ? !empty && value === undefined : value === undefined;
    setFields((current) => (current ? { ...current, [key]: { text: raw, invalid } } : current));
    if (invalid) {
      setStatus("idle");
      return;
    }
    if (key === "maxTokens") patch({ maxTokens: value ?? null });
    else if (value !== undefined) patch({ [key]: value } as Partial<IdeaTreeSettingsDetails>);
  };

  const editNumberInput = (key: NumberKey) => (event: FormEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    editNumber(key, input.value, input.validity.badInput);
  };

  const numbers = fields ?? (draft ? numberFieldsOf(draft) : undefined);
  const blocked = numbers === undefined || Object.values(numbers).some((field) => field.invalid);

  const save = async () => {
    if (!draft || blocked) return;
    setStatus("saving");
    setFailure(undefined);
    const generation = edits.current;
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
      // An edit typed while the request was in flight describes values this
      // response does not contain. Keep the typed draft, do not mark it saved,
      // and let the next Save send it; the late reload will skip the pane too.
      if (edits.current !== generation) {
        setStatus("idle");
        return;
      }
      edits.current = 0;
      setDraft(saved);
      setFields(numberFieldsOf(saved));
      setStatus("saved");
      loaded.reload();
    } catch (reason: unknown) {
      setStatus("failed");
      setFailure(reason instanceof ApiRequestError && reason.status === 503 ? t.unavailable : reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <LoadGate loaded={loaded}>
      {() => (draft ? (
        <>
          <Group heading={t.scopeHeading}>
            <Row hint={t.templateHint} title={t.template}>
              <Select
                label={t.template}
                onChange={(value) => editField({ templateId: value as IdeaTreeSettingsDetails["templateId"] })}
                options={TEMPLATES}
                value={draft.templateId}
              />
            </Row>
            <Row hint={t.intensityHint} title={t.intensity}>
              <Select
                label={t.intensity}
                onChange={(value) => editField({ explorationIntensity: value as IdeaTreeSettingsDetails["explorationIntensity"] })}
                options={INTENSITIES}
                value={draft.explorationIntensity}
              />
            </Row>
            <Row hint={t.directionHint} title={t.direction}>
              <Select
                label={t.direction}
                onChange={(value) => editField({ scoreDirection: value as IdeaTreeSettingsDetails["scoreDirection"] })}
                options={DIRECTIONS}
                value={draft.scoreDirection}
              />
            </Row>
            <Row hint={t.maxDepthHint} title={t.maxDepth}>
              <input
                aria-describedby={numbers?.maxDepth.invalid ? `${DEPTH_ERROR_ID}` : undefined}
                aria-invalid={numbers?.maxDepth.invalid ?? false}
                aria-label={t.maxDepth}
                className="field-input"
                max={RANGES.maxDepth.max}
                min={RANGES.maxDepth.min}
                onInput={editNumberInput("maxDepth")}
                type="number"
                value={numbers?.maxDepth.text ?? ""}
              />
              {numbers?.maxDepth.invalid ? <small className="row-note is-error" id={DEPTH_ERROR_ID} role="alert">{t.invalidDepth}</small> : null}
            </Row>
            <Row hint={t.maxNodesHint} title={t.maxNodes}>
              <input
                aria-describedby={numbers?.maxNodes.invalid ? `${NODES_ERROR_ID}` : undefined}
                aria-invalid={numbers?.maxNodes.invalid ?? false}
                aria-label={t.maxNodes}
                className="field-input"
                max={RANGES.maxNodes.max}
                min={RANGES.maxNodes.min}
                onInput={editNumberInput("maxNodes")}
                type="number"
                value={numbers?.maxNodes.text ?? ""}
              />
              {numbers?.maxNodes.invalid ? <small className="row-note is-error" id={NODES_ERROR_ID} role="alert">{t.invalidNodes}</small> : null}
            </Row>
            <Row hint={t.tokensHint} title={t.tokens}>
              <input
                aria-describedby={numbers?.maxTokens.invalid ? `${TOKENS_ERROR_ID}` : undefined}
                aria-invalid={numbers?.maxTokens.invalid ?? false}
                aria-label={t.tokens}
                className="field-input"
                min={RANGES.maxTokens.min}
                onInput={editNumberInput("maxTokens")}
                placeholder={t.noCap}
                type="number"
                value={numbers?.maxTokens.text ?? ""}
              />
              {numbers?.maxTokens.invalid ? <small className="row-note is-error" id={TOKENS_ERROR_ID} role="alert">{t.invalidTokens}</small> : null}
            </Row>
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
                  onChange={(event) => editField({ [key]: event.target.value } as Partial<IdeaTreeSettingsDetails>)}
                  placeholder={t.promptPlaceholder}
                  rows={3}
                  value={value ?? ""}
                />
              </Row>
            ))}
          </Group>
          <div className="settings-actions is-end">
            <button className="primary-button" disabled={status === "saving" || blocked} onClick={() => void save()} type="button">
              {status === "saving" ? t.saving : t.save}
            </button>
            {status === "saved" ? <small role="status">{t.saved}</small> : null}
            {status === "failed" ? <small role="alert">{failure ?? t.failed}</small> : null}
          </div>
        </>
      ) : null)}
    </LoadGate>
  );
}

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

import { useEffect, useState } from "react";
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

/** A number typed into the form; empty means "the server's default", which is `null`
 *  for `maxTokens` and "omit the field" for the others. */
function readNumber(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
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
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (loaded.value) setDraft(loaded.value);
  }, [loaded.value]);

  const patch = (next: Partial<IdeaTreeSettingsDetails>) => {
    setDraft((current) => (current ? { ...current, ...next } : current));
    setStatus("idle");
  };

  const save = async () => {
    if (!draft) return;
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
            <Row hint={t.maxDepthHint} title={t.maxDepth}>
              <input
                aria-label={t.maxDepth}
                className="field-input"
                min={1}
                onChange={(event) => { const value = readNumber(event.target.value); if (value !== undefined) patch({ maxDepth: value }); }}
                type="number"
                value={number(draft.maxDepth)}
              />
            </Row>
            <Row hint={t.maxNodesHint} title={t.maxNodes}>
              <input
                aria-label={t.maxNodes}
                className="field-input"
                min={1}
                onChange={(event) => { const value = readNumber(event.target.value); if (value !== undefined) patch({ maxNodes: value }); }}
                type="number"
                value={number(draft.maxNodes)}
              />
            </Row>
            <Row hint={t.tokensHint} title={t.tokens}>
              <input
                aria-label={t.tokens}
                className="field-input"
                min={0}
                onChange={(event) => patch({ maxTokens: readNumber(event.target.value) ?? null })}
                placeholder={t.noCap}
                type="number"
                value={number(draft.maxTokens)}
              />
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
                  onChange={(event) => patch({ [key]: event.target.value } as Partial<IdeaTreeSettingsDetails>)}
                  placeholder={t.promptPlaceholder}
                  rows={3}
                  value={value ?? ""}
                />
              </Row>
            ))}
          </Group>
          <div className="settings-actions is-end">
            <button className="primary-button" disabled={status === "saving"} onClick={() => void save()} type="button">
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

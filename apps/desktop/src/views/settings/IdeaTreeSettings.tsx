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
 * The Idea Tree settings fields, controlled.
 *
 * They are not a page in 设置: like a search's options, they are chosen when the research
 * is launched, so the same fields render inside the launch dialog behind its 设置 switch.
 * Every field below exists in `IdeaTreeSettingsDetails`; the rounds / candidates /
 * assessor-weight fields the engine retired are neither shown nor sent.
 */

import type { IdeaTreeSettingsDetails, IdeaTreeThinkingRole } from "@sciencediscovery/schema";
import { IDEA_TREE_THINKING_ROLES } from "@sciencediscovery/schema";
import { TEXT } from "../../text.js";
import { Group, Row, Select } from "../settings/rows.js";

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
const FOLLOW_MODEL = "follow-model";
const EFFORTS = [FOLLOW_MODEL, "low", "medium", "high", "xhigh", "max"].map((value) => ({
  label: value === FOLLOW_MODEL ? t.followModel : value,
  value,
}));

/** A typed number; empty means "the server's default" (`null` for `maxTokens`). */
function readNumber(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

const numberValue = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));

export function IdeaTreeSettingsFields({ value, onChange }: { value: IdeaTreeSettingsDetails; onChange: (next: IdeaTreeSettingsDetails) => void }) {
  const patch = (next: Partial<IdeaTreeSettingsDetails>) => onChange({ ...value, ...next });
  const effortFor = (role: IdeaTreeThinkingRole): string => value.roleThinkingEfforts?.[role] ?? FOLLOW_MODEL;
  return (
    <>
      <Group heading={t.scopeHeading}>
        <Row hint={t.templateHint} title={t.template}>
          <Select label={t.template} onChange={(next) => patch({ templateId: next as IdeaTreeSettingsDetails["templateId"] })} options={TEMPLATES} value={value.templateId} />
        </Row>
        <Row hint={t.intensityHint} title={t.intensity}>
          <Select label={t.intensity} onChange={(next) => patch({ explorationIntensity: next as IdeaTreeSettingsDetails["explorationIntensity"] })} options={INTENSITIES} value={value.explorationIntensity} />
        </Row>
        <Row hint={t.directionHint} title={t.direction}>
          <Select label={t.direction} onChange={(next) => patch({ scoreDirection: next as IdeaTreeSettingsDetails["scoreDirection"] })} options={DIRECTIONS} value={value.scoreDirection} />
        </Row>
        <Row hint={t.maxDepthHint} title={t.maxDepth}>
          <input aria-label={t.maxDepth} className="field-input" min={1} onChange={(event) => { const next = readNumber(event.target.value); if (next !== undefined) patch({ maxDepth: next }); }} type="number" value={numberValue(value.maxDepth)} />
        </Row>
        <Row hint={t.maxNodesHint} title={t.maxNodes}>
          <input aria-label={t.maxNodes} className="field-input" min={1} onChange={(event) => { const next = readNumber(event.target.value); if (next !== undefined) patch({ maxNodes: next }); }} type="number" value={numberValue(value.maxNodes)} />
        </Row>
        <Row hint={t.tokensHint} title={t.tokens}>
          <input aria-label={t.tokens} className="field-input" min={0} onChange={(event) => patch({ maxTokens: readNumber(event.target.value) ?? null })} placeholder={t.noCap} type="number" value={numberValue(value.maxTokens)} />
        </Row>
        <Row hint={t.tokensPerCallHint} title={t.tokensPerCall}>
          <input aria-label={t.tokensPerCall} className="field-input" min={1} onChange={(event) => { const next = readNumber(event.target.value); if (next !== undefined) patch({ maxTokensPerCall: next }); }} type="number" value={numberValue(value.maxTokensPerCall)} />
        </Row>
      </Group>
      <Group heading={t.promptsHeading}>
        {([
          ["designSystemPrompt", t.designPrompt, value.designSystemPrompt],
          ["aggregatorSystemPrompt", t.aggregatorPrompt, value.aggregatorSystemPrompt],
          ["propagateInsightSystemPrompt", t.propagatePrompt, value.propagateInsightSystemPrompt],
        ] as const).map(([key, label, current]) => (
          <Row hint={t.promptHint} key={key} title={label} tone="stack">
            <textarea aria-label={label} className="field-input settings-textarea" onChange={(event) => patch({ [key]: event.target.value } as Partial<IdeaTreeSettingsDetails>)} placeholder={t.promptPlaceholder} rows={3} value={current ?? ""} />
          </Row>
        ))}
      </Group>
      <Group heading={t.thinkingHeading}>
        {IDEA_TREE_THINKING_ROLES.map((role) => (
          <Row hint={t.thinkingHint} key={role} title={t.roles[role]}>
            <Select
              label={t.roles[role]}
              onChange={(next) => {
                const efforts = { ...(value.roleThinkingEfforts ?? {}) };
                if (next === FOLLOW_MODEL) delete efforts[role];
                else efforts[role] = next as NonNullable<IdeaTreeSettingsDetails["roleThinkingEfforts"]>[IdeaTreeThinkingRole];
                patch({ roleThinkingEfforts: efforts });
              }}
              options={EFFORTS}
              value={effortFor(role)}
            />
          </Row>
        ))}
      </Group>
    </>
  );
}

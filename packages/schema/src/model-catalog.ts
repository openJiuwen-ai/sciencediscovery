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
 * The model catalog: metadata for well-known models, held in memory and
 * replaced at runtime.
 *
 * The data itself is deliberately not compiled into the product. A snapshot of
 * the community catalog (see `models-dev.ts`) is downloaded when the release is
 * packaged, refreshed on demand from Settings, and installed here by whichever
 * process owns it — the control API after reading its snapshot file, the Web
 * app after fetching `/api/model-catalog`. Before a snapshot is installed every
 * lookup returns `undefined`, which all callers already read as "the vendor
 * does not publish this fact", never as a default or a guess.
 *
 * Precedence when the UI assembles a model's fact sheet:
 *   live listing endpoint facts (`RemoteModelFacts`) > this catalog > unknown.
 * Pricing is provider-scoped — a rehosted model (e.g. DeepSeek on
 * SiliconFlow) never inherits the original vendor's prices.
 */

import type {
  ModelCatalogEntry,
  ModelCatalogPricing,
  ModelCatalogThinking,
  ModelProviderPresetId,
} from "./model-provider.js";
import type { ModelThinkingEffort, ModelThinkingMode } from "./model-usage.js";

export interface ModelCatalogRecord {
  /** Additional normalized ids that resolve to this record. */
  aliases?: readonly string[];
  /** Model-specific wire dialect required by the official endpoint. */
  apiVariant?: ModelCatalogEntry["apiVariant"];
  contextWindow?: number;
  /** Normalized primary id: lower-case, no vendor path prefix. */
  key: string;
  label: string;
  maxOutputTokens?: number;
  pricing?: Readonly<Partial<Record<ModelProviderPresetId, ModelCatalogPricing>>>;
  source: { retrievedAt: string; url: string };
  thinking?: ModelCatalogThinking;
  vision?: boolean;
}

/** Where the installed snapshot was read from. `bundled` is the copy written
 *  into the image or release payload at packaging time, so a first start
 *  without network still has a catalog; `downloaded` is a snapshot this
 *  installation fetched itself. */
export type ModelCatalogOrigin = "bundled" | "downloaded";

export interface ModelCatalogSnapshot {
  /** ISO timestamp of the successful download this snapshot came from. This is
   *  the "last updated" the UI shows — not the time the file was read. */
  fetchedAt: string;
  origin: ModelCatalogOrigin;
  records: readonly ModelCatalogRecord[];
  /** The catalog endpoint the snapshot was downloaded from. */
  sourceUrl: string;
}

/** What `/api/model-catalog` returns and what a manual refresh replaces it
 *  with. `snapshot` is absent only when no snapshot has ever been installed —
 *  a source build that has never refreshed and carries no packaging copy. */
export interface ModelCatalogDetails {
  snapshot?: ModelCatalogSnapshot;
  /** The catalog endpoint a refresh downloads from, shown next to the button
   *  so the user can see where the data comes from. */
  sourceUrl: string;
}

let installed: ModelCatalogSnapshot | undefined;

/** Install a snapshot process-wide. Passing `undefined` clears the catalog,
 *  which tests use to assert the honest "unknown" behaviour. */
export function setModelCatalogSnapshot(snapshot: ModelCatalogSnapshot | undefined): void {
  installed = snapshot;
}

export function getModelCatalogSnapshot(): ModelCatalogSnapshot | undefined {
  return installed;
}

function catalogRecords(): readonly ModelCatalogRecord[] {
  return installed?.records ?? [];
}

/** Lower-case the id and strip a vendor path prefix ("org/model") plus common
 *  hosted-variant suffixes so rehosted ids match their canonical record. */
export function normalizeCatalogModelId(modelId: string): string {
  const lower = modelId.trim().toLowerCase();
  const slash = lower.lastIndexOf("/");
  const bare = slash === -1 ? lower : lower.slice(slash + 1);
  return bare.replace(/:(free|extended|exacto)$/, "");
}

/**
 * Resolve catalog metadata for a model id. Pricing is only returned when it
 * was recorded for the given preset — a rehosted model keeps its capability
 * facts but never inherits another vendor's prices.
 */
export function lookupModelCatalog(modelId: string, presetId?: string): ModelCatalogEntry | undefined {
  const normalized = normalizeCatalogModelId(modelId);
  const records = catalogRecords();
  const record = records.find((entry) => entry.key === normalized || entry.aliases?.includes(normalized))
    // Date-suffixed snapshots ("<id>-20260423" / "<id>-2026-04-23") match
    // their base record.
    ?? records.find((entry) => normalized.startsWith(`${entry.key}-2`));
  if (!record) return undefined;
  const pricing = presetId === undefined ? undefined : record.pricing?.[presetId as ModelProviderPresetId];
  return {
    ...(record.apiVariant ? { apiVariant: record.apiVariant } : {}),
    label: record.label,
    source: record.source,
    ...(record.contextWindow !== undefined ? { contextWindow: record.contextWindow } : {}),
    ...(record.maxOutputTokens !== undefined ? { maxOutputTokens: record.maxOutputTokens } : {}),
    ...(record.vision !== undefined ? { vision: record.vision } : {}),
    ...(record.thinking ? { thinking: record.thinking } : {}),
    ...(pricing ? { pricing } : {}),
  };
}

/** Narrow saved/user-selected thinking values to the official per-model
 * capability. This is also the migration path for legacy values such as
 * GPT-5.5 `max`, which safely becomes its nearest legal `xhigh` value. */
export function constrainCatalogThinking(
  modelId: string,
  mode?: ModelThinkingMode,
  effort?: ModelThinkingEffort,
  /** Effort stops the user declared for this endpoint. A gateway often accepts
   *  a narrower set than the vendor documents, and only the person who
   *  configured it knows that, so the declared list replaces the catalog's. */
  overrides?: { thinkingEfforts?: readonly ModelThinkingEffort[] },
): { effort: ModelThinkingEffort; mode: ModelThinkingMode } {
  const thinking = lookupModelCatalog(modelId)?.thinking;
  const declared = overrides?.thinkingEfforts?.length ? overrides.thinkingEfforts : undefined;
  const requestedMode = mode ?? thinking?.defaultMode ?? "auto";
  const requestedEffort = effort ?? thinking?.defaultEffort ?? "high";
  // A declared stop list is itself a statement that this endpoint thinks, so
  // it stands on its own even for a model the catalog has never heard of.
  if (!thinking?.supported && !declared) return { effort: requestedEffort, mode: requestedMode };

  const modes = thinking?.modes;
  const legalMode = modes?.length && !modes.includes(requestedMode)
    ? thinking?.defaultMode ?? (modes.includes("auto") ? "auto" : modes[0]!)
    : requestedMode;
  const efforts = declared ?? thinking?.efforts;
  let legalEffort = requestedEffort;
  if (efforts?.length && !efforts.includes(requestedEffort)) {
    const fallback = thinking?.defaultEffort;
    legalEffort = requestedEffort === "max" && efforts.includes("xhigh")
      ? "xhigh"
      : fallback !== undefined && efforts.includes(fallback)
        ? fallback
        : efforts.includes("high") ? "high" : efforts[0]!;
  }
  return { effort: legalEffort, mode: legalMode };
}

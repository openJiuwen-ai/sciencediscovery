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

import { readRenamedStorageItem } from "../browser-storage.js";
import type { ChartSpec, ChartType, DataTable } from "./types.js";

const CACHE_VERSION = 1;
const CHART_TYPES = new Set<ChartType>([
  "box",
  "dot-matrix",
  "heatmap",
  "histogram",
  "ranked-bar",
  "ranked-bubble",
  "scatter",
  "table",
  "violin",
  "volcano",
]);

export interface WorkspaceState {
  activeSpecId: string;
  specs: ChartSpec[];
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSpec(value: unknown, table: DataTable): ChartSpec | undefined {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.sourceArtifactVersionId !== table.source.sourceArtifactVersionId
    || value.tableId !== table.id
    || typeof value.id !== "string"
    || !value.id
    || typeof value.preset !== "string"
    || typeof value.type !== "string"
    || !CHART_TYPES.has(value.type as ChartType)
    || !isRecord(value.appearance)
    || typeof value.appearance.title !== "string"
    || !isRecord(value.mappings)
    || !Array.isArray(value.mappings.tooltip)
    || !isRecord(value.scales)
    || !Array.isArray(value.displayFilters)
    || !Array.isArray(value.thresholds)) {
    return undefined;
  }
  return {
    ...value,
    displayName: typeof value.displayName === "string" ? value.displayName : value.preset,
  } as unknown as ChartSpec;
}

export function workspaceCacheKey(artifactVersionId: string): string {
  return `sciencediscovery:csv-workspace:v${CACHE_VERSION}:${artifactVersionId}`;
}

export function removeChartFromWorkspace(
  state: WorkspaceState,
  specId: string,
): WorkspaceState {
  if (state.specs.length <= 1) return state;
  const removedIndex = state.specs.findIndex((spec) => spec.id === specId);
  if (removedIndex < 0) return state;
  const specs = state.specs.filter((spec) => spec.id !== specId);
  const activeSpecId = state.activeSpecId === specId
    ? specs[Math.min(removedIndex, specs.length - 1)]!.id
    : state.activeSpecId;
  return { activeSpecId, specs };
}

export function loadWorkspaceState(
  storage: StorageLike,
  table: DataTable,
  defaultSpecs: ChartSpec[],
): WorkspaceState {
  const fallback = {
    activeSpecId: defaultSpecs[0]?.id ?? "",
    specs: structuredClone(defaultSpecs),
  };
  try {
    const key = workspaceCacheKey(table.source.sourceArtifactVersionId);
    // Chart layouts saved under the former key prefix are imported once so an
    // upgrade does not silently discard the user's saved comparisons.
    const raw = readRenamedStorageItem(storage, key);
    if (!raw) return fallback;
    const cached = JSON.parse(raw) as unknown;
    if (!isRecord(cached) || cached.cacheVersion !== CACHE_VERSION || !Array.isArray(cached.specs)) {
      return fallback;
    }
    const seen = new Set<string>();
    const specs = cached.specs.flatMap((value) => {
      const normalized = normalizeSpec(value, table);
      if (!normalized || seen.has(normalized.id)) return [];
      seen.add(normalized.id);
      return [normalized];
    });
    if (!specs.length) return fallback;
    const activeSpecId = typeof cached.activeSpecId === "string"
      && specs.some((spec) => spec.id === cached.activeSpecId)
      ? cached.activeSpecId
      : specs[0]!.id;
    return { activeSpecId, specs };
  } catch {
    return fallback;
  }
}

export function saveWorkspaceState(
  storage: StorageLike,
  artifactVersionId: string,
  state: WorkspaceState,
): boolean {
  try {
    storage.setItem(workspaceCacheKey(artifactVersionId), JSON.stringify({
      activeSpecId: state.activeSpecId,
      cacheVersion: CACHE_VERSION,
      specs: state.specs,
    }));
    return true;
  } catch {
    return false;
  }
}

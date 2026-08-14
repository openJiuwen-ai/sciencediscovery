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

export function resolveSelectedRowIds(
  current: string[],
  incoming: string[],
  modified: boolean,
): string[] {
  const uniqueIncoming: string[] = [];
  const incomingSet = new Set<string>();
  for (const rowId of incoming) {
    if (!rowId || incomingSet.has(rowId)) continue;
    incomingSet.add(rowId);
    uniqueIncoming.push(rowId);
  }

  if (!modified) return uniqueIncoming;
  if (!uniqueIncoming.length) return [...current];

  const selected = new Set(current);
  if (uniqueIncoming.every((rowId) => selected.has(rowId))) {
    return current.filter((rowId) => !incomingSet.has(rowId));
  }

  const merged = [...current];
  for (const rowId of uniqueIncoming) {
    if (selected.has(rowId)) continue;
    selected.add(rowId);
    merged.push(rowId);
  }
  return merged;
}

export function rowIdsFromCustomData(customdata: unknown): string[] {
  if (typeof customdata === "object" && customdata !== null && !Array.isArray(customdata)) {
    const rowIds = (customdata as { rowIds?: unknown }).rowIds;
    if (Array.isArray(rowIds)) {
      return [...new Set(rowIds.flatMap((rowId) =>
        rowId === undefined || rowId === null ? [] : [String(rowId)]))];
    }
  }
  if (Array.isArray(customdata)) {
    return customdata[0] === undefined || customdata[0] === null
      ? []
      : [String(customdata[0])];
  }
  return customdata === undefined || customdata === null ? [] : [String(customdata)];
}

export function selectedPointIndicesByTrace(
  traces: Array<Record<string, unknown>>,
  selectedRowIds: string[],
): Array<number[] | null> {
  if (!selectedRowIds.length) return traces.map(() => null);

  const selected = new Set(selectedRowIds);
  return traces.map((trace) => {
    if (trace.type === "heatmap" || !Array.isArray(trace.customdata)) return null;
    return trace.customdata.flatMap((value, index) => {
      const [rowId] = rowIdsFromCustomData(value);
      return rowId && selected.has(rowId) ? [index] : [];
    });
  });
}

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

import type { ApiClient } from "./client.js";
import type { WorkbenchSearchResponse } from "./types.js";

/**
 * The page size the server allows (`MAX_SEARCH_RESULTS` in
 * `services/api/src/workbench/index.ts`). Asking for it in one request keeps
 * the client from paging a list it only ever shows grouped, and `hasMore` /
 * `total` say when even that page was truncated.
 */
export const WORKBENCH_SEARCH_LIMIT = 250;

export interface WorkbenchSearchOptions {
  limit?: number;
  offset?: number;
  /** The field aborts the previous request when the reader types on; the
   *  client passes the signal through to `fetch`. */
  signal?: AbortSignal;
}

/**
 * `GET /api/search` — the workbench search the web client already consumes.
 *
 * It matches Project names, Session titles and artifact names/titles; it does
 * not read message bodies, which is why the field's copy names the three
 * things it searches. The inbox Project is deliberately absent from the
 * server's answer, so the sidebar merges its already-loaded Sessions itself
 * (`app/sidebar-search.ts`).
 */
export function searchWorkbench(
  client: ApiClient,
  query: string,
  options: WorkbenchSearchOptions = {},
): Promise<WorkbenchSearchResponse> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? WORKBENCH_SEARCH_LIMIT),
    offset: String(options.offset ?? 0),
    q: query,
  });
  return client.request<WorkbenchSearchResponse>(`/api/search?${params.toString()}`, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

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
 * `GET /api/search`, the route the web client's palette uses.
 *
 * It matches project names, Session titles and artifact names/titles — **not
 * message bodies** — so the desktop field must not promise more than that.
 */
export function searchWorkbench(
  client: ApiClient,
  query: string,
  options: { limit?: number; offset?: number } = {},
): Promise<WorkbenchSearchResponse> {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  return client.request<WorkbenchSearchResponse>(
    `/api/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`,
  );
}

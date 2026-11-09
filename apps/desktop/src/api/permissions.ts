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
import type { PermissionDecision, PermissionDecisionResult, PermissionRequest } from "./types.js";

/**
 * Every request the Session ever raised, decided ones included.
 *
 * A replay is rebuilt from the run's own event stream, and a decision can
 * reach the catalog without reaching that stream — artifact downloads and
 * remote jobs answered outside a run's own wait were recorded only as a
 * catalog state in older builds. Opening a Session compares the two so such a
 * request does not come back as a card that can no longer be answered.
 */
export function listPermissionRequests(
  client: ApiClient,
  sessionId: string,
): Promise<PermissionRequest[]> {
  return client.request<PermissionRequest[]>(
    `/api/permission-requests?sessionId=${encodeURIComponent(sessionId)}`,
  );
}

/**
 * Answer one authorization request.
 *
 * The response is the whole picture, not just the request that was answered:
 * `allow_matching` resolves every other pending request its grant covers, so
 * `resolvedRequests` is what lets the UI settle those cards without waiting for
 * their `permission.resolved` events — which do still arrive, and which the
 * merge treats as idempotent.
 */
export function decidePermissionRequest(
  client: ApiClient,
  requestId: string,
  decision: PermissionDecision,
): Promise<PermissionDecisionResult> {
  return client.request<PermissionDecisionResult>(
    `/api/permission-requests/${encodeURIComponent(requestId)}/decision`,
    { body: JSON.stringify({ decision }), method: "POST" },
  );
}

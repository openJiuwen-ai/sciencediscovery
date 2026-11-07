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
 * The read-only half of 科学记忆: the two reads behind a citation card.
 *
 * Both are reverse-proxied by the control plane, and both answer 200 with an
 * empty payload plus a `reason` when the feature is off or the graph is
 * unreachable — the card decides between "not enabled", "temporarily
 * unavailable" and "nothing recorded yet" from that reason, never from an
 * exception.
 */

import type { ApiClient } from "./client.js";
import type {
  MemoryGraphChainResult,
  MemoryGraphMatchResponse,
  MemoryGraphNodeLabel,
} from "./types.js";

/** `POST /api/memory/query/by-node-type` — the card list. A `sessionId` of
 *  `undefined` reads every Session, which is what 全部会话 means. */
export function listMemoryNodes(
  client: ApiClient,
  nodeTypes: MemoryGraphNodeLabel[],
  sessionId?: string,
): Promise<MemoryGraphMatchResponse> {
  return client.request<MemoryGraphMatchResponse>("/api/memory/query/by-node-type", {
    body: JSON.stringify({ node_types: nodeTypes, session_id: sessionId }),
    method: "POST",
  });
}

/** `POST /api/memory/query/chain` — one directed short chain in a button's
 *  `kind`. The chain includes its source node, so callers filter by id. */
export function memoryChain(
  client: ApiClient,
  nodeId: string,
  sessionId: string | undefined,
  kind: string,
  version?: number,
): Promise<MemoryGraphChainResult> {
  return client.request<MemoryGraphChainResult>("/api/memory/query/chain", {
    body: JSON.stringify({
      node_id: nodeId,
      session_id: sessionId,
      version,
      kind,
    }),
    method: "POST",
  });
}

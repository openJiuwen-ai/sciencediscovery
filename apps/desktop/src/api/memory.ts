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
 * 科学记忆's browser client: the reads behind a citation card, plus the one
 * write the card offers — deleting a single Evidence record.
 *
 * The reads are reverse-proxied by the control plane and answer 200 with an
 * empty payload plus a `reason` when the feature is off or the graph cannot
 * answer, so the card decides between "not enabled", "unavailable" and
 * "nothing recorded yet" from that reason. The delete is a write and cannot
 * degrade silently: it rejects with an `ApiRequestError` whose status and code
 * say whether the record was unknown, the type refused, memory off, the token
 * rejected or the sidecar unreachable.
 */

import type { ApiClient } from "./client.js";
import type {
  MemoryGraphChainResult,
  MemoryGraphDeleteResult,
  MemoryGraphMatchResponse,
  MemoryGraphNodeLabel,
} from "./types.js";

/** Whether a `reason` means the graph could not answer *this* query, so the
 *  card must offer a retry rather than claim the reference does not exist.
 *  `memory_graph_query_limit` is the sidecar's HTTP 503 budget refusal; it is
 *  not a missing node and must not render as one. An auth rejection is
 *  deliberately absent: retrying with the same token cannot help, and telling
 *  the reader the service is down would point at the wrong thing. */
export function graphTemporarilyUnavailable(reason?: string): boolean {
  return reason === "memory_graph_unreachable" || reason === "memory_graph_query_limit";
}

/** Whether the memory service answered but refused this installation's
 *  credentials (HTTP 401/403). The service is up; the internal token does not
 *  match. The card says so instead of "the memory service did not answer". */
export function graphCredentialsRejected(reason?: string): boolean {
  return reason === "memory_graph_unauthorized";
}

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

/** `POST /api/memory/delete/node` — remove one Evidence record and its edges.
 *  The control plane answers explicit statuses: 404 unknown node, 400 refused
 *  type, 409 memory off, 502 sidecar unreachable. A rejection (including
 *  unreachable) therefore reaches the card as an `ApiRequestError`, never as
 *  the read routes' "missing" payload. */
export function deleteMemoryNode(
  client: ApiClient,
  nodeId: string,
  sessionId?: string,
): Promise<MemoryGraphDeleteResult> {
  return client.request<MemoryGraphDeleteResult>("/api/memory/delete/node", {
    body: JSON.stringify({
      node_id: nodeId,
      node_type: "Evidence",
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
    }),
    method: "POST",
  });
}

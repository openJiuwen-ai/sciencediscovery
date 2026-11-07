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

/** [first-message-latency] First-chat warmup.
 *
 * After the cluster reports ready, the control API's MCP catalog is still
 * cold: the bundled stdio MCP servers are spawned and their tools enumerated
 * on the first catalog reload, which the first chat run triggers — field
 * measurements put that chunk at ~48s of first-message latency on a fresh
 * install. The catalog load is exactly what `POST /api/mcp/sources/reload`
 * (the MCP settings page's refresh) triggers, so the shell issues the same
 * request in the background the moment the cluster becomes ready — the user
 * is typically still reading the ready screen, and the first message then
 * finds the catalog warm.
 *
 * Note: `GET /api/mcp/sources` only reads the cached manifest/status list;
 * it never spawns the stdio servers. The reload endpoint is the one that
 * connects and enumerates (verified live 2026-11-05: GET returned 200 in ~1s
 * with zero stdio processes; POST /reload spawned them in ~3.3s).
 *
 * Best-effort by contract: any failure is logged by the caller and never
 * surfaces to the user. When the warmup loses the race (user sends the first
 * message before it completes), the run path re-runs the same steps — no
 * behavioural fork, only a head start.
 */

export const FIRST_CHAT_WARMUP_PATH = "/api/mcp/sources/reload";
export const FIRST_CHAT_WARMUP_TIMEOUT_MS = 60_000;

/** The warmup target: the adapter origin serving the UI, catalog endpoint appended. */
export function firstChatWarmupUrl(uiOrigin: string): string {
  return `${new URL(uiOrigin).origin}${FIRST_CHAT_WARMUP_PATH}`;
}

/** Authorization headers for the warmup request; empty object without a usable token. */
export function firstChatWarmupHeaders(token: string | null): Record<string, string> {
  const trimmed = token?.trim();
  return trimmed ? { authorization: `Bearer ${trimmed}` } : {};
}

export async function runFirstChatWarmup(uiOrigin: string, token: string | null): Promise<number> {
  const res = await fetch(firstChatWarmupUrl(uiOrigin), {
    method: "POST",
    headers: firstChatWarmupHeaders(token),
    signal: AbortSignal.timeout(FIRST_CHAT_WARMUP_TIMEOUT_MS),
  });
  return res.status;
}

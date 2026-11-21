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
 * Proof that a request for this machine's control-plane token came from a real
 * HUAWEI sign-in.
 *
 * The account service is the only authority that can tell a live access token
 * from a made-up one, so the loopback bootstrap route asks it. Nothing about a
 * `Bearer <anything>` header is trusted on its own.
 */

export interface AccountVerificationOptions {
  /** Base URL of the account service; empty means verification is unavailable. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Bound on the round trip so a wedged account service cannot park the route. */
  timeoutMs?: number;
}

export type AccountVerification =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "unauthorized" | "unreachable" };

export async function verifyAccountAccessToken(
  authorization: string | undefined,
  options: AccountVerificationOptions,
): Promise<AccountVerification> {
  const base = options.baseUrl.trim().replace(/\/+$/u, "");
  if (!base) return { ok: false, reason: "not_configured" };
  const token = /^Bearer\s+(\S+)$/u.exec(authorization?.trim() ?? "")?.[1] ?? "";
  if (!token) return { ok: false, reason: "unauthorized" };
  try {
    const response = await (options.fetchImpl ?? fetch)(`${base}/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "unauthorized" };
    if (!response.ok) return { ok: false, reason: "unreachable" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/** The Host header must name this machine: a browser page reaching the loopback
 *  port through DNS rebinding carries its own hostname, not `127.0.0.1`. */
export function isLoopbackHost(host: string | undefined): boolean {
  const name = (host ?? "").trim().toLowerCase();
  if (!name) return false;
  const hostname = name.startsWith("[")
    ? name.slice(1, name.indexOf("]"))
    : name.split(":")[0] ?? "";
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

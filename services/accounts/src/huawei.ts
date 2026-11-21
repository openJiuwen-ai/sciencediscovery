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
 * HUAWEI ID code exchange, server side.
 *
 * The authorization code is the only thing the browser carries back, and only
 * this service can turn it into an identity. Two proofs are supported:
 *
 *   - a PKCE `code_verifier`, when the client still sends `code_challenge`;
 *   - `HUAWEI_CLIENT_SECRET`, when the client does not. That value is optional:
 *     public clients and PKCE deployments omit it entirely.
 *
 * The desktop build historically used PKCE because it had no safe place for a
 * secret; that still works. A cloud callback cannot read the client's cookie, so
 * deployments that keep PKCE must forward the verifier explicitly and
 * deployments that do not simply rely on the secret. Either way the openid is
 * produced here, never accepted from the client.
 */

export interface HuaweiProfile {
  openid: string;
  displayName?: string;
  avatarUrl?: string;
  email?: string;
}

export class HuaweiExchangeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HuaweiExchangeError";
  }
}

export interface ExchangeInput {
  clientId: string;
  /** Optional for public clients and PKCE deployments. */
  clientSecret?: string | undefined;
  code: string;
  redirectUri: string;
  codeVerifier?: string | undefined;
  tokenEndpoint: string;
  /** Expected `iss`. HUAWEI ID tokens name `https://accounts.huawei.com`. */
  issuer?: string | undefined;
  /** Tolerance for `exp`/`iat`, in seconds. */
  clockSkewSeconds?: number | undefined;
  now?: (() => number) | undefined;
  fetchImpl?: typeof fetch;
}

export const HUAWEI_ISSUER = "https://accounts.huawei.com";

function readClaimText(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The signature can be skipped because the token comes straight from the token
 * endpoint over TLS (OIDC Core 3.1.3.7), but the claims cannot: without `aud`,
 * an ID token minted for another client would be accepted as this identity.
 */
function assertIdTokenClaims(
  claims: Record<string, unknown>,
  options: { clientId: string; issuer: string; clockSkewSeconds: number; now: number },
): void {
  const issuer = readClaimText(claims, "iss");
  if (!issuer || issuer !== options.issuer) {
    throw new HuaweiExchangeError("id_token_wrong_issuer", `ID token issuer is not ${options.issuer}`);
  }
  const audience = claims.aud;
  const audiences = typeof audience === "string" ? [audience] : Array.isArray(audience) ? audience.filter((value): value is string => typeof value === "string") : [];
  if (!audiences.includes(options.clientId)) {
    throw new HuaweiExchangeError("id_token_wrong_audience", "ID token was not issued for this client");
  }
  const authorizedParty = readClaimText(claims, "azp");
  if (authorizedParty && authorizedParty !== options.clientId) {
    throw new HuaweiExchangeError("id_token_wrong_audience", "ID token was authorized for another party");
  }
  const expiresAt = claims.exp;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new HuaweiExchangeError("id_token_expired", "ID token carries no expiry");
  }
  const seconds = Math.floor(options.now / 1000);
  if (expiresAt + options.clockSkewSeconds < seconds) {
    throw new HuaweiExchangeError("id_token_expired", "ID token has expired");
  }
  const issuedAt = claims.iat;
  if (typeof issuedAt === "number" && Number.isFinite(issuedAt) && issuedAt - options.clockSkewSeconds > seconds) {
    throw new HuaweiExchangeError("id_token_expired", "ID token was issued in the future");
  }
}

export async function exchangeCodeForProfile(input: ExchangeInput): Promise<HuaweiProfile> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
  });
  if (input.codeVerifier) body.set("code_verifier", input.codeVerifier);
  else if (input.clientSecret) body.set("client_secret", input.clientSecret);

  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new HuaweiExchangeError("token_response_unreadable", `token endpoint returned ${response.status}`);
  }
  const idToken = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>).id_token : undefined;
  if (!response.ok || typeof idToken !== "string") {
    const detail = payload !== null && typeof payload === "object" ? ((payload as Record<string, unknown>).error_description ?? (payload as Record<string, unknown>).error) : undefined;
    throw new HuaweiExchangeError("token_exchange_failed", typeof detail === "string" ? detail : `HTTP ${response.status}`);
  }

  const segments = idToken.split(".");
  if (segments.length < 2) throw new HuaweiExchangeError("id_token_malformed", "ID token is not a JWT");
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8"));
  } catch {
    throw new HuaweiExchangeError("id_token_malformed", "ID token payload is not JSON");
  }
  if (claims === null || typeof claims !== "object") throw new HuaweiExchangeError("id_token_malformed", "ID token payload is not an object");

  const record = claims as Record<string, unknown>;
  assertIdTokenClaims(record, {
    clientId: input.clientId,
    issuer: input.issuer ?? HUAWEI_ISSUER,
    clockSkewSeconds: input.clockSkewSeconds ?? 60,
    now: (input.now ?? Date.now)(),
  });
  const openid = readClaimText(record, "openid") ?? readClaimText(record, "sub");
  if (!openid) throw new HuaweiExchangeError("id_token_without_openid", "ID token carries no openid");
  const profile: HuaweiProfile = { openid };
  const displayName = readClaimText(record, "display_name") ?? readClaimText(record, "nickname");
  const avatarUrl = readClaimText(record, "picture") ?? readClaimText(record, "head_img_url");
  const email = readClaimText(record, "email");
  if (displayName) profile.displayName = displayName;
  if (avatarUrl) profile.avatarUrl = avatarUrl;
  if (email) profile.email = email;
  return profile;
}

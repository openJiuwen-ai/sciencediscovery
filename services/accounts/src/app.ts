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
 * Every route the account service serves, user side and admin side alike.
 *
 * The two sides share one process and one store but nothing else: a user proves
 * itself with a Bearer access token tied to a session row, an admin proves itself
 * with a cookie tied to an admin session. No admin route accepts an openid or a
 * user id from the caller as identity, and no user route touches admin tables.
 *
 * Writing routes need role >= 1. Each of them also lands an audit row inside the
 * same transaction as the change itself, so an audit trail cannot lag a balance.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

import type { AccountsConfig } from "./config.js";
import { randomToken, sha256, signJwt, verifyJwt, verifyPassword } from "./crypto.js";
import { HttpError, Router, json, parseBearer, readCookie, readJsonBody, readNumber, readString, redirect, serializeCookie, type HttpRequest, type HttpResponse } from "./http.js";
import { HuaweiExchangeError, exchangeCodeForProfile, type HuaweiProfile } from "./huawei.js";
import { MILLI_PER_CREDIT, estimateHoldMilli, estimateInputTokens, settleMilli } from "./pricing.js";
import type { AdminSessionRow, AccountsStore, CreditRow, LedgerRow, SessionRow, UserRow } from "./store.js";

const ADMIN_COOKIE = "sd_admin";
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const RECENT_WINDOW_MS = 30 * 60 * 1000;
/**
 * Splits the CSRF nonce from the hex-packed return URL in `state`; mirrors
 * `apps/web/src/auth/huawei.ts`, where HUAWEI needs an alphanumeric `state`.
 */
const RETURN_SEPARATOR = "z";
const AUTH_STATE_PATTERN = /^[A-Za-z0-9]{16,128}$/u;
const AUTH_FLOW_TTL_MS = 10 * 60 * 1000;
const HUAWEI_AUTHORIZE_ENDPOINT = "https://oauth-login.cloud.huawei.com/oauth2/v3/authorize";
const HUAWEI_SCOPE = "openid profile email";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** How long after a rotation the predecessor is recognised as a retry rather
 *  than a leak. It is measured from `prev_rotated_at`, never from activity, and
 *  the retry is refused without revoking — it never rotates the current digest. */
const REFRESH_REPLAY_GRACE_MS = 30_000;
/** Output budget the proxy freezes when the client sends no `max_tokens`. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const MAX_OUTPUT_TOKENS = 131_072;

export interface AppDeps {
  config: AccountsConfig;
  store: AccountsStore;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

export interface UserContext {
  user: UserRow;
  session: SessionRow;
}

interface AdminContext {
  session: AdminSessionRow;
}

function parseBigId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "invalid_id", "id must be a positive integer");
  return id;
}

function readInteger(source: Record<string, unknown>, key: string, range: { min?: number; max?: number }): number | undefined {
  const value = readNumber(source, key, range);
  if (value !== undefined && !Number.isSafeInteger(value)) throw new HttpError(400, "invalid_field", `${key} must be an integer`);
  return value;
}

/** Request ids are the idempotency key for holds, so they must be UUIDs. */
function readRequestId(body: Record<string, unknown>): string {
  const value = readString(body, "requestId", { maxLength: 36 });
  if (!value || !UUID_PATTERN.test(value)) {
    throw new HttpError(400, "invalid_field", "requestId must be a UUID");
  }
  return value;
}

interface UpstreamUsage {
  input: number;
  cached: number;
  output: number;
}

/** Reads the OpenAI `usage` object LiteLLM reports on both streamed and plain replies. */
function readUsage(raw: unknown): UpstreamUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const input = Number(usage.prompt_tokens);
  const output = Number(usage.completion_tokens);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  const details = usage.prompt_tokens_details;
  const cached = details !== null && typeof details === "object" ? Number((details as Record<string, unknown>).cached_tokens) : 0;
  return {
    input: Math.max(0, Math.trunc(input)),
    cached: Number.isFinite(cached) ? Math.max(0, Math.trunc(cached)) : 0,
    output: Math.max(0, Math.trunc(output)),
  };
}

function requireUserId(body: Record<string, unknown>): number {
  const userId = readInteger(body, "userId", { min: 1 });
  if (userId === undefined) throw new HttpError(400, "invalid_field", "userId is required");
  return userId;
}

function credits(milli: number): number {
  return Math.round(milli) / MILLI_PER_CREDIT;
}

function creditView(credit: CreditRow | undefined): Record<string, number | string | null> {
  if (!credit) return { balance: 0, balanceCredits: 0, frozen: 0, frozenCredits: 0, totalEarned: 0, totalEarnedCredits: 0, totalSpent: 0, totalSpentCredits: 0, updatedAt: null };
  return {
    balance: credit.balance,
    balanceCredits: credits(credit.balance),
    frozen: credit.frozen,
    frozenCredits: credits(credit.frozen),
    totalEarned: credit.totalEarned,
    totalEarnedCredits: credits(credit.totalEarned),
    totalSpent: credit.totalSpent,
    totalSpentCredits: credits(credit.totalSpent),
    updatedAt: credit.updatedAt,
  };
}

function ledgerView(row: LedgerRow): Record<string, unknown> {
  return { ...row, deltaCredits: credits(row.delta), balanceAfterCredits: credits(row.balanceAfter) };
}

function userView(user: UserRow): Record<string, unknown> {
  return { ...user, openidTail: user.openid.slice(-6) };
}

function sessionView(session: SessionRow, nowMs: number): Record<string, unknown> {
  const lastSeen = new Date(session.lastSeenAt).getTime();
  const online = !session.revokedAt && lastSeen >= nowMs - ONLINE_WINDOW_MS;
  const recent = !session.revokedAt && lastSeen >= nowMs - RECENT_WINDOW_MS;
  // Enumerate the public fields: the row also carries the refresh digest, which
  // must never leave the store.
  return {
    id: session.id,
    userId: session.userId,
    platform: session.platform,
    deviceLabel: session.deviceLabel,
    deviceId: session.deviceId,
    ip: session.ip,
    userAgent: session.userAgent,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
    revokedReason: session.revokedReason,
    platformLabel: session.platform === 2 ? "Linux Web" : "Windows 桌面",
    online,
    presence: session.revokedAt ? "revoked" : online ? "online" : recent ? "recent" : "offline",
  };
}

/**
 * Matches a browser origin against `WEB_ORIGINS`. An entry may end in `:*` to
 * accept any port on that host, which the desktop client needs: its UI port
 * shifts when the default one is already taken.
 */
export function originAllowed(origin: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === origin) return true;
    if (!pattern.endsWith(":*")) return false;
    const prefix = pattern.slice(0, -1);
    return origin.startsWith(prefix) && /^\d{1,5}$/u.test(origin.slice(prefix.length));
  });
}

function errorResponse(error: unknown): HttpResponse {
  if (error instanceof HttpError) return json(error.status, { error: { code: error.code, message: error.message } });
  console.error("accounts request failed", error instanceof Error ? error.stack ?? error.message : error);
  return json(500, { error: { code: "internal_error", message: "internal error" } });
}

const staticAssets = new Map<string, { type: string; body: Buffer }>();

function staticAsset(name: string, type: string): HttpResponse {
  const cached = staticAssets.get(name);
  if (cached) return { status: 200, headers: { "content-type": cached.type, "cache-control": "no-cache" }, body: cached.body };
  let body: Buffer;
  try {
    body = readFileSync(new URL(`../admin/${name}`, import.meta.url));
  } catch {
    throw new HttpError(404, "not_found", `${name} is not deployed`);
  }
  staticAssets.set(name, { type, body });
  return { status: 200, headers: { "content-type": type, "cache-control": "no-cache" }, body };
}

export function createApp(deps: AppDeps): (request: HttpRequest) => Promise<HttpResponse> {
  const { config, store } = deps;
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const router = new Router();

  function authFlowReturnUrl(request: HttpRequest): string {
    const requested = (request.query.get("returnUrl") ?? "").trim();
    if (!requested) return config.webReturnUrl;
    let target: URL;
    try {
      target = new URL(requested);
    } catch {
      throw new HttpError(400, "invalid_return_url", "returnUrl is not a valid absolute URL");
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") throw new HttpError(400, "invalid_return_url", "returnUrl must be http or https");
    let configuredOrigin = "";
    try {
      configuredOrigin = new URL(config.webReturnUrl).origin;
    } catch {
      configuredOrigin = "";
    }
    if (target.origin !== configuredOrigin && !originAllowed(target.origin, config.webOrigins)) {
      throw new HttpError(400, "invalid_return_url", "returnUrl is not an allowed web origin");
    }
    return target.toString();
  }

  /**
   * Where the browser goes after HUAWEI signs the user in. The client packs its
   * own `/login` URL into `state`, because `state` is the only value HUAWEI
   * echoes back; that is what lets a desktop install return to its loopback UI
   * while the web build returns to the public site. Anything outside
   * `WEB_RETURN_URL` and `WEB_ORIGINS` falls back to the configured site, so the
   * callback cannot become an open redirect that hands a ticket to a stranger.
   */
  function returnTarget(state: string | undefined): string {
    const separator = state?.lastIndexOf(RETURN_SEPARATOR) ?? -1;
    if (!state || separator < 0) return config.webReturnUrl;
    const hex = state.slice(separator + 1);
    if (!/^(?:[0-9a-f]{2})+$/u.test(hex)) return config.webReturnUrl;
    let requested: URL;
    try {
      requested = new URL(Buffer.from(hex, "hex").toString("utf8"));
    } catch {
      return config.webReturnUrl;
    }
    if (requested.protocol !== "https:" && requested.protocol !== "http:") return config.webReturnUrl;
    let configuredOrigin = "";
    try {
      configuredOrigin = new URL(config.webReturnUrl).origin;
    } catch {
      configuredOrigin = "";
    }
    if (requested.origin !== configuredOrigin && !originAllowed(requested.origin, config.webOrigins)) return config.webReturnUrl;
    return requested.toString();
  }

  function accessToken(userId: number, sessionId: string): string {
    return signJwt({ sub: userId, sid: sessionId, typ: "access" }, config.jwtSecret, config.accessTtlSeconds, now().getTime());
  }

  function adminCookie(token: string): string {
    return serializeCookie(ADMIN_COOKIE, token, {
      maxAge: config.adminSessionTtlSeconds,
      domain: config.adminCookieDomain || undefined,
      secure: config.cookieSecure,
      httpOnly: true,
    });
  }

  function clearedAdminCookie(): string {
    return serializeCookie(ADMIN_COOKIE, "", { maxAge: 0, domain: config.adminCookieDomain || undefined, secure: config.cookieSecure, httpOnly: true });
  }

  async function requireUser(request: HttpRequest): Promise<UserContext> {
    const token = parseBearer(request.headers.authorization);
    if (!token) throw new HttpError(401, "missing_token", "Authorization: Bearer <access token> is required");
    const claims = verifyJwt<{ sub?: unknown; sid?: unknown; typ?: unknown }>(token, config.jwtSecret, now().getTime());
    if (!claims || claims.typ !== "access") throw new HttpError(401, "invalid_token", "access token is not valid");
    const userId = Number(claims.sub);
    const sessionId = typeof claims.sid === "string" ? claims.sid : "";
    if (!Number.isSafeInteger(userId) || !sessionId) throw new HttpError(401, "invalid_token", "access token is not valid");

    const session = await store.getSession(sessionId);
    if (!session || session.userId !== userId) throw new HttpError(401, "invalid_token", "session is unknown");
    if (session.revokedAt) throw new HttpError(401, "session_revoked", "session was signed out");
    if (new Date(session.expiresAt).getTime() <= now().getTime()) throw new HttpError(401, "session_expired", "session expired");
    const user = await store.getUser(userId);
    if (!user) throw new HttpError(401, "invalid_token", "account no longer exists");
    if (user.status === 2 || user.status === 3) throw new HttpError(403, "account_frozen", "account is frozen");
    await store.touchSession(sessionId, now());
    return { user, session };
  }

  async function requireAdmin(request: HttpRequest, minimumRole = 0): Promise<AdminContext> {
    const token = readCookie(request.headers.cookie, ADMIN_COOKIE);
    if (!token) throw new HttpError(401, "admin_auth_required", "sign in to the admin console");
    const session = await store.findAdminSession(sha256(token));
    if (!session) throw new HttpError(401, "admin_auth_required", "admin session expired");
    if (session.role < minimumRole) throw new HttpError(403, "forbidden", "this action needs an operator role");
    await store.touchAdminSession(session.id, now());
    return { session };
  }

  /** The proxy is a trusted service, so a shared secret is enough here. */
  function requireServiceToken(request: HttpRequest): void {
    if (!config.billingToken) throw new HttpError(503, "billing_disabled", "billing endpoints need BILLING_TOKEN");
    const presented = parseBearer(request.headers.authorization) ?? "";
    const expected = Buffer.from(config.billingToken, "utf8");
    const actual = Buffer.from(presented, "utf8");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new HttpError(401, "invalid_service_token", "service token is missing or wrong");
    }
  }

  function dayStartUtc(): Date {
    const current = now();
    return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate()));
  }

  function onlineSince(): Date {
    return new Date(now().getTime() - ONLINE_WINDOW_MS);
  }

  // ---------------------------------------------------------------- health

  router.add("GET", "/healthz", async () => json(200, { ok: true, service: "accounts", time: now().toISOString() }));

  // ------------------------------------------------------------- user auth

  router.add("GET", "/v1/auth/huawei/start", async (request) => {
    const returnUrl = authFlowReturnUrl(request);
    // HUAWEI rejects non-alphanumeric `state`; hex keeps the value opaque while
    // satisfying the callback validator below.
    const state = randomBytes(24).toString("hex");
    const codeVerifier = randomBytes(48).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    await store.createAuthFlow({ state, codeVerifier, returnUrl, expiresAt: new Date(now().getTime() + AUTH_FLOW_TTL_MS) });

    const redirectUri = config.huaweiRedirectUri || `${request.headers["x-forwarded-proto"] ?? "https"}://${request.headers.host ?? "localhost"}/v1/auth/huawei/callback`;
    const query = new URLSearchParams({
      response_type: "code",
      client_id: config.huaweiClientId,
      redirect_uri: redirectUri,
      scope: HUAWEI_SCOPE,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return redirect(`${HUAWEI_AUTHORIZE_ENDPOINT}?${query.toString()}`, {}, 303);
  });

  router.add("GET", "/v1/auth/huawei/callback", async (request) => {
    const state = request.query.get("state") ?? undefined;
    const pending = state && AUTH_STATE_PATTERN.test(state) ? await store.consumeAuthFlow(state, now()) : undefined;
    if (!pending) console.error("huawei callback has no pending flow", state ? "unknown or expired state" : "no state");
    const target = pending?.returnUrl ?? returnTarget(state);
    const denied = request.query.get("error");
    if (denied) {
      console.error("huawei callback error", denied, request.query.get("error_description") ?? "");
      return redirect(`${target}#error=${encodeURIComponent(denied)}`);
    }

    const code = (request.query.get("code") ?? "").trim();
    if (!code) throw new HttpError(400, "missing_code", "HUAWEI redirect carried no authorization code");

    let profile: HuaweiProfile;
    try {
      profile = await exchangeCodeForProfile({
        clientId: config.huaweiClientId,
        code,
        redirectUri:
          config.huaweiRedirectUri ||
          `${request.headers["x-forwarded-proto"] ?? "https"}://${request.headers.host ?? "localhost"}/v1/auth/huawei/callback`,
        codeVerifier: pending?.codeVerifier,
        clientSecret: pending ? undefined : config.huaweiClientSecret,
        tokenEndpoint: config.huaweiTokenEndpoint,
        fetchImpl,
      });
    } catch (error) {
      const code2 = error instanceof HuaweiExchangeError ? error.code : "token_exchange_failed";
      console.error("huawei exchange failed", error instanceof HuaweiExchangeError ? `${error.code}: ${error.message}` : error);
      return redirect(`${target}#error=${encodeURIComponent(code2)}`);
    }

    const signed = await store.signIn({
      openid: profile.openid,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      email: profile.email,
      grantMilliCredits: Math.round(config.registerGrantCredits * MILLI_PER_CREDIT),
      dailyReward: {
        milliCredits: Math.round(config.dailyRewardCredits * MILLI_PER_CREDIT),
        cycleDays: config.checkinBonusEveryDays,
        bonusMilliCredits: Math.round(config.streakBonusCredits * MILLI_PER_CREDIT),
      },
      ip: request.ip ?? undefined,
      userAgent: request.headers["user-agent"],
    });

    const jti = randomUUID();
    const ticket = signJwt({ jti, openid: profile.openid, typ: "ticket", fresh: signed.isNewUser }, config.jwtSecret, config.ticketTtlSeconds, now().getTime());
    await store.createTicket(jti, profile.openid, new Date(now().getTime() + config.ticketTtlSeconds * 1000));

    const fragment = new URLSearchParams({ "auth-ticket": ticket });
    if (state) fragment.set("state", state);
    return redirect(`${target}#${fragment.toString()}`);
  });

  router.add("POST", "/v1/auth/ticket", async (request) => {
    const body = readJsonBody(request);
    const ticket = readString(body, "ticket", { maxLength: 8192 });
    if (!ticket) throw new HttpError(400, "missing_ticket", "ticket is required");

    const claims = verifyJwt<{ jti?: unknown; openid?: unknown; typ?: unknown; fresh?: unknown }>(ticket, config.jwtSecret, now().getTime());
    if (!claims || claims.typ !== "ticket" || typeof claims.jti !== "string" || typeof claims.openid !== "string") throw new HttpError(401, "ticket_invalid", "ticket is not valid");

    // The single-use guarantee lives in the database, not in the signature: a
    // token can be copied, an UPDATE ... WHERE used_at IS NULL RETURNING cannot
    // succeed twice.
    const openid = await store.consumeTicket(claims.jti, now());
    if (!openid) throw new HttpError(401, "ticket_invalid", "ticket was already used or expired");
    const user = await store.findUserByOpenid(openid);
    if (!user) throw new HttpError(401, "ticket_invalid", "ticket refers to no account");
    if (user.status === 2 || user.status === 3) throw new HttpError(403, "account_frozen", "account is frozen");

    const refreshToken = randomToken();
    const session = await store.createSession({
      userId: user.id,
      refreshHash: sha256(refreshToken),
      platform: readNumber(body, "platform", { min: 1, max: 2 }) ?? 1,
      deviceLabel: readString(body, "deviceLabel", { maxLength: 128 }),
      deviceId: readString(body, "deviceId", { maxLength: 64 }),
      ip: request.ip ?? undefined,
      userAgent: request.headers["user-agent"],
      expiresAt: new Date(now().getTime() + config.refreshTtlSeconds * 1000),
    });
    await store.recordLoginEvent({ userId: user.id, sessionId: session.id, event: "SIGN_IN", ip: request.ip ?? undefined, userAgent: request.headers["user-agent"] });
    const credit = await store.getCredit(user.id);
    return json(200, {
      accessToken: accessToken(user.id, session.id),
      accessExpiresIn: config.accessTtlSeconds,
      refreshToken,
      refreshExpiresAt: session.expiresAt,
      isNewUser: claims.fresh === true,
      user: userView(user),
      credit: creditView(credit),
    });
  });

  router.add("POST", "/v1/auth/refresh", async (request) => {
    const body = readJsonBody(request);
    const refreshToken = readString(body, "refreshToken", { maxLength: 512 });
    if (!refreshToken) throw new HttpError(400, "missing_refresh_token", "refreshToken is required");

    const presentedHash = sha256(refreshToken);
    const session = await store.findSessionByRefreshHash(presentedHash);
    if (!session) {
      // A rotated token reappearing is normally the leak signal: kill the
      // session rather than hand out another pair. Inside the retry window it
      // is the client's lost response or a concurrent refresh, so refuse this
      // one without revoking — a previous token can never rotate the current
      // digest, because that would hand the session to whoever held it.
      const replayed = await store.findSessionByPrevRefreshHash(presentedHash);
      const rotatedAt = replayed?.prevRotatedAt ? Date.parse(replayed.prevRotatedAt) : Number.NaN;
      const retryInWindow = replayed !== undefined && !replayed.revokedAt && Number.isFinite(rotatedAt) && now().getTime() - rotatedAt <= REFRESH_REPLAY_GRACE_MS;
      if (retryInWindow) throw new HttpError(401, "refresh_retried", "refresh token was already rotated");
      if (replayed) {
        await store.revokeSession(replayed.id, "ROTATE_REUSE", now());
        await store.recordLoginEvent({ userId: replayed.userId, sessionId: replayed.id, event: "REJECTED", result: 1, ip: request.ip ?? undefined, userAgent: request.headers["user-agent"] });
      }
      throw new HttpError(401, "invalid_refresh", "refresh token is not valid");
    }
    if (session.revokedAt) throw new HttpError(401, "session_revoked", "session was signed out");
    if (new Date(session.expiresAt).getTime() <= now().getTime()) {
      await store.revokeSession(session.id, "EXPIRED", now());
      throw new HttpError(401, "session_expired", "session expired");
    }
    const user = await store.getUser(session.userId);
    if (!user) throw new HttpError(401, "invalid_refresh", "account no longer exists");
    if (user.status === 2 || user.status === 3) throw new HttpError(403, "account_frozen", "account is frozen");

    const nextRefresh = randomToken();
    if (!(await store.replaceSessionRefresh(session.id, presentedHash, sha256(nextRefresh), now()))) {
      // A concurrent request rotated first. Refuse this one without revoking:
      // its token is the predecessor now, and the winner already holds the
      // successor. Rotating again would invalidate the winner's token.
      throw new HttpError(401, "refresh_retried", "refresh token was already rotated");
    }
    await store.recordLoginEvent({ userId: user.id, sessionId: session.id, event: "REFRESH", ip: request.ip ?? undefined, userAgent: request.headers["user-agent"] });
    const credit = await store.getCredit(user.id);
    return json(200, {
      accessToken: accessToken(user.id, session.id),
      accessExpiresIn: config.accessTtlSeconds,
      refreshToken: nextRefresh,
      refreshExpiresAt: session.expiresAt,
      user: userView(user),
      credit: creditView(credit),
    });
  });

  router.add("POST", "/v1/auth/logout", async (request) => {
    const context = await requireUser(request);
    await store.revokeSession(context.session.id, "LOGOUT", now());
    await store.recordLoginEvent({ userId: context.user.id, sessionId: context.session.id, event: "SIGN_OUT" });
    return json(200, { ok: true });
  });

  // ------------------------------------------------------------ user data

  router.add("GET", "/v1/me", async (request) => {
    const context = await requireUser(request);
    const credit = await store.getCredit(context.user.id);
    const sessions = await store.listSessions(context.user.id, 50);
    return json(200, {
      user: userView(context.user),
      credit: creditView(credit),
      onlineSessions: sessions.filter((item) => !item.revokedAt && new Date(item.lastSeenAt).getTime() >= onlineSince().getTime()).length,
      activeSessions: sessions.filter((item) => !item.revokedAt).length,
      currentSessionId: context.session.id,
    });
  });

  router.add("PATCH", "/v1/me", async (request) => {
    const context = await requireUser(request);
    const body = readJsonBody(request);
    const displayName = readString(body, "displayName", { maxLength: 24 });
    if (displayName !== undefined && (displayName.length < 1 || displayName.length > 24)) throw new HttpError(400, "invalid_display_name", "displayName must be 1-24 characters");
    // Email is read-only in the account page even though an administrator may
    // still correct it elsewhere; accepting it here would let the account
    // owner rewrite the identity HUAWEI shared.
    const updated = await store.updateProfile(context.user.id, { displayName });
    if (!updated) throw new HttpError(404, "user_not_found", "account no longer exists");
    return json(200, { user: userView(updated) });
  });

  router.add("GET", "/v1/me/sessions", async (request) => {
    const context = await requireUser(request);
    const sessions = await store.listSessions(context.user.id, 50);
    return json(200, {
      currentSessionId: context.session.id,
      items: sessions.map((session) => ({ ...sessionView(session, now().getTime()), current: session.id === context.session.id })),
    });
  });

  router.add("DELETE", "/v1/me/sessions/:id", async (request, params) => {
    const context = await requireUser(request);
    const sessionId = params.id ?? "";
    const target = await store.getSession(sessionId);
    if (!target || target.userId !== context.user.id) throw new HttpError(404, "session_not_found", "no such session");
    const revoked = await store.revokeSession(sessionId, sessionId === context.session.id ? "LOGOUT" : "SELF_OFFLINE", now());
    await store.recordLoginEvent({ userId: context.user.id, sessionId, event: "REVOKED", result: revoked ? 0 : 1 });
    return json(200, { ok: true });
  });

  router.add("GET", "/v1/me/usage", async (request) => {
    const context = await requireUser(request);
    const since = new Date(now().getTime() - 5 * 86400 * 1000);
    const [days, records] = await Promise.all([
      store.listUsageDaily(context.user.id, since),
      store.listUsageRecent(context.user.id, since, 100),
    ]);
    return json(200, { days, records });
  });

  router.add("GET", "/v1/credits", async (request) => {
    const context = await requireUser(request);
    const credit = await store.getCredit(context.user.id);
    return json(200, {
      credit: creditView(credit),
      conversationEstimate: Math.floor((credit?.balance ?? 0) / (MILLI_PER_CREDIT * 2)),
    });
  });

  router.add("GET", "/v1/credits/ledger", async (request) => {
    const context = await requireUser(request);
    const before = request.query.get("beforeId");
    const limit = Math.min(Math.max(Number(request.query.get("limit") ?? 20), 1), 100);
    const rows = await store.listLedger(context.user.id, before ? parseBigId(before) : undefined, limit);
    return json(200, { items: rows.map(ledgerView), nextBeforeId: rows.length === limit ? rows[rows.length - 1]!.id : null });
  });

  // ----------------------------------------------------------- model proxy
  // The only way a client reaches a model. The caller proves itself with a user
  // session, this service freezes credits, forwards to the gateway with the
  // internal key, and settles on the usage the gateway reports. The gateway
  // itself never learns who the user is.

  // Model listings go through this service too: a client asks what it may run
  // without ever holding the gateway's internal key.
  router.add("GET", "/v1/models", async (request) => {
    await requireUser(request);
    if (!config.litellmBaseUrl || !config.litellmApiKey) throw new HttpError(503, "llm_proxy_disabled", "LLM proxy needs LITELLM_BASE_URL and LITELLM_MASTER_KEY");
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${config.litellmBaseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${config.litellmApiKey}` },
        signal: request.signal,
      });
    } catch (error) {
      console.error("llm models unreachable", error instanceof Error ? error.message : error);
      throw new HttpError(502, "upstream_unreachable", "model gateway is unreachable");
    }
    const text = await upstream.text();
    return { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8", "cache-control": "no-store" }, body: text };
  });

  router.add("POST", "/v1/chat/completions", async (request) => {
    const context = await requireUser(request);
    if (!config.litellmBaseUrl || !config.litellmApiKey) throw new HttpError(503, "llm_proxy_disabled", "LLM proxy needs LITELLM_BASE_URL and LITELLM_MASTER_KEY");

    const body = readJsonBody(request);
    const model = readString(body, "model", { maxLength: 64 });
    if (!model) throw new HttpError(400, "invalid_field", "model is required");
    const price = await store.getModelPrice(model);
    if (!price) throw new HttpError(400, "unknown_model", `${model} has no price configured`);

    const requestedOutput =
      readInteger(body, "max_completion_tokens", { min: 1, max: MAX_OUTPUT_TOKENS })
      ?? readInteger(body, "max_tokens", { min: 1, max: MAX_OUTPUT_TOKENS })
      ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const inputChars = JSON.stringify(body.messages ?? body).length;
    const holdMilli = estimateHoldMilli(inputChars, requestedOutput, price);
    const headerId = (request.headers["x-request-id"] ?? "").trim();
    const requestId = UUID_PATTERN.test(headerId) ? headerId : randomUUID();
    const userId = context.user.id;

    const hold = await store.holdCredits({ userId, requestId, holdMilli });
    if (hold.status === "insufficient") {
      return json(402, { error: { code: "CREDIT_INSUFFICIENT", message: "not enough credits for this request", balance: hold.balance, need: hold.holdAmount } });
    }
    if (hold.status === "no_account") throw new HttpError(404, "user_not_found", "no credit account for this user");
    if (hold.status === "closed") throw new HttpError(409, "hold_closed", "this request was already settled or released");

    const release = async (): Promise<void> => {
      await store.releaseHold({ userId, requestId }).catch((error: unknown) => {
        console.error("llm hold release failed", error instanceof Error ? error.message : error);
      });
    };
    const startedAt = now().getTime();
    const settle = async (inputTokens: number, cachedTokens: number, outputTokens: number): Promise<void> => {
      try {
        await store.settleCredits({
          userId, requestId, model, inputTokens, cachedTokens, outputTokens,
          chargedMilli: settleMilli(inputTokens, cachedTokens, outputTokens, price),
          channel: 1,
          latencyMs: Math.max(0, now().getTime() - startedAt),
        });
      } catch (error) {
        // The answer may already be on its way, so a bookkeeping failure must
        // not truncate it; refund the hold instead of freezing it forever.
        console.error("llm settle failed", error instanceof Error ? error.message : error);
        await release();
      }
    };

    const stream = body.stream === true;
    const upstreamBody: Record<string, unknown> = { ...body, model };
    if (stream) {
      // Without this the gateway reports no token counts on a streamed reply,
      // and the hold could only be refunded, never settled on real usage.
      const options = body.stream_options;
      upstreamBody.stream_options = { ...(options !== null && typeof options === "object" ? (options as Record<string, unknown>) : {}), include_usage: true };
    }

    const signals = [AbortSignal.timeout(config.litellmTimeoutSeconds * 1000)];
    if (request.signal) signals.push(request.signal);
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${config.litellmBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.litellmApiKey}` },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      await release();
      console.error("llm upstream unreachable", error instanceof Error ? error.message : error);
      throw new HttpError(502, "upstream_unreachable", "model gateway is unreachable");
    }

    if (!upstream.ok) {
      await release();
      const text = await upstream.text().catch(() => "");
      return { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8", "cache-control": "no-store" }, body: text };
    }

    if (!stream) {
      const text = await upstream.text();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        await release();
        throw new HttpError(502, "upstream_invalid", "model gateway returned a non-JSON reply");
      }
      const usage = readUsage(parsed.usage);
      if (usage) {
        await settle(usage.input, usage.cached, usage.output);
      } else {
        // No usage means no trustworthy bill; charge the estimate so a reply is
        // never free.
        const message = (parsed.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message;
        const content = message !== null && typeof message === "object" ? (message as Record<string, unknown>).content : "";
        await settle(estimateInputTokens(inputChars), 0, estimateInputTokens(typeof content === "string" ? content.length : 0));
      }
      return { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: text };
    }

    if (!upstream.body) {
      await release();
      throw new HttpError(502, "upstream_invalid", "model gateway returned an empty stream");
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let outputChars = 0;
    let observed: UpstreamUsage | undefined;
    const consume = (text: string): void => {
      pending += text;
      for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          continue;
        }
        const usage = readUsage(chunk.usage);
        if (usage) observed = usage;
        if (!Array.isArray(chunk.choices)) continue;
        for (const choice of chunk.choices) {
          const delta = choice !== null && typeof choice === "object" ? (choice as Record<string, unknown>).delta : undefined;
          if (delta === null || typeof delta !== "object") continue;
          for (const key of ["content", "reasoning_content"]) {
            const piece = (delta as Record<string, unknown>)[key];
            if (typeof piece === "string") outputChars += piece.length;
          }
        }
      }
    };

    async function* relay(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            consume(decoder.decode(value, { stream: true }));
            yield value;
          }
        }
        consume(`${decoder.decode()}\n`);
      } finally {
        // Reached on normal completion, on an upstream failure, and when the
        // client hangs up (the signal aborted the gateway connection).
        await reader.cancel().catch(() => undefined);
        if (observed) await settle(observed.input, observed.cached, observed.output);
        else await settle(estimateInputTokens(inputChars), 0, estimateInputTokens(outputChars));
      }
    }

    return {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        "x-accel-buffering": "no",
      },
      body: "",
      stream: relay(),
    };
  });

  // --------------------------------------------------------------- billing
  // Called by the LLM proxy, never by a client: a client that could settle its
  // own hold could pay whatever it liked.

  router.add("POST", "/internal/billing/hold", async (request) => {
    requireServiceToken(request);
    const body = readJsonBody(request);
    const userId = requireUserId(body);
    const requestId = readRequestId(body);
    const model = readString(body, "model", { maxLength: 64 });
    if (!model) throw new HttpError(400, "invalid_field", "model is required");
    const estimatedInputChars = readInteger(body, "estimatedInputChars", { min: 0, max: 2_000_000 });
    const maxOutputTokens = readInteger(body, "maxOutputTokens", { min: 1, max: 131_072 });
    if (estimatedInputChars === undefined || maxOutputTokens === undefined) {
      throw new HttpError(400, "invalid_field", "estimatedInputChars and maxOutputTokens are required");
    }

    const price = await store.getModelPrice(model);
    if (!price) throw new HttpError(400, "unknown_model", `${model} has no price configured`);
    const holdMilli = estimateHoldMilli(estimatedInputChars, maxOutputTokens, price);
    const result = await store.holdCredits({ userId, requestId, holdMilli });
    if (result.status === "insufficient") {
      return json(402, {
        error: { code: "CREDIT_INSUFFICIENT", message: "not enough credits for this request", balance: result.balance, need: result.holdAmount },
      });
    }
    if (result.status === "no_account") throw new HttpError(404, "user_not_found", "no credit account for this user");
    if (result.status === "closed") throw new HttpError(409, "hold_closed", "this request was already settled or released");
    return json(200, {
      requestId,
      status: "held",
      holdAmount: result.holdAmount,
      holdCredits: credits(result.holdAmount),
      balance: result.balance,
      balanceCredits: credits(result.balance),
      frozen: result.frozen,
    });
  });

  router.add("POST", "/internal/billing/settle", async (request) => {
    requireServiceToken(request);
    const body = readJsonBody(request);
    const userId = requireUserId(body);
    const requestId = readRequestId(body);
    const model = readString(body, "model", { maxLength: 64 });
    if (!model) throw new HttpError(400, "invalid_field", "model is required");
    const inputTokens = readInteger(body, "inputTokens", { min: 0, max: 2_000_000 });
    const cachedTokens = readInteger(body, "cachedTokens", { min: 0, max: 2_000_000 }) ?? 0;
    const outputTokens = readInteger(body, "outputTokens", { min: 0, max: 2_000_000 });
    if (inputTokens === undefined || outputTokens === undefined) {
      throw new HttpError(400, "invalid_field", "inputTokens and outputTokens are required");
    }
    const channel = readInteger(body, "channel", { min: 1, max: 2 }) ?? 1;
    const latencyMs = readInteger(body, "latencyMs", { min: 0, max: 600_000 });

    const price = await store.getModelPrice(model);
    if (!price) throw new HttpError(400, "unknown_model", `${model} has no price configured`);
    const chargedMilli = settleMilli(inputTokens, cachedTokens, outputTokens, price);
    const result = await store.settleCredits({ userId, requestId, model, inputTokens, cachedTokens, outputTokens, chargedMilli, channel, latencyMs });
    if (result.status === "missing") throw new HttpError(404, "hold_not_found", "no hold for this request");
    if (result.status === "released") throw new HttpError(409, "hold_released", "this request was already released");
    return json(200, {
      requestId,
      status: result.status,
      charged: result.charged,
      chargedCredits: credits(result.charged),
      balance: result.balance,
      balanceCredits: credits(result.balance),
      frozen: result.frozen,
    });
  });

  router.add("POST", "/internal/billing/release", async (request) => {
    requireServiceToken(request);
    const body = readJsonBody(request);
    const userId = requireUserId(body);
    const requestId = readRequestId(body);

    const result = await store.releaseHold({ userId, requestId });
    if (result.status === "missing") throw new HttpError(404, "hold_not_found", "no hold for this request");
    if (result.status === "settled") throw new HttpError(409, "hold_settled", "this request was already settled");
    return json(200, {
      requestId,
      status: result.status,
      released: result.holdAmount,
      releasedCredits: credits(result.holdAmount),
      balance: result.balance,
      balanceCredits: credits(result.balance),
      frozen: result.frozen,
    });
  });

  // ------------------------------------------------------------ admin auth

  router.add("POST", "/v1/admin/auth/login", async (request) => {
    const body = readJsonBody(request);
    const username = readString(body, "username", { maxLength: 64 });
    const password = readString(body, "password", { maxLength: 200 });
    if (!username || !password) throw new HttpError(400, "invalid_credentials", "username and password are required");

    const admin = await store.findAdmin(username);
    if (!admin) throw new HttpError(401, "invalid_credentials", "username or password is wrong");
    if (admin.lockedUntil && new Date(admin.lockedUntil).getTime() > now().getTime()) throw new HttpError(423, "admin_locked", "account is temporarily locked");
    if (admin.status !== 0) throw new HttpError(403, "admin_disabled", "account is disabled");

    if (!(await verifyPassword(password, admin.passwordHash))) {
      const attempts = admin.failedCount + 1;
      const lock = attempts >= config.adminMaxFailures ? new Date(now().getTime() + config.adminLockSeconds * 1000) : undefined;
      await store.recordAdminFailure(admin.id, lock);
      throw new HttpError(401, "invalid_credentials", "username or password is wrong");
    }

    const token = randomToken();
    await store.createAdminSession({ adminId: admin.id, tokenHash: sha256(token), ip: request.ip ?? undefined, expiresAt: new Date(now().getTime() + config.adminSessionTtlSeconds * 1000) });
    await store.resetAdminFailures(admin.id, now());
    return json(200, { admin: { id: admin.id, username: admin.username, role: admin.role } }, { "set-cookie": adminCookie(token) });
  });

  router.add("POST", "/v1/admin/auth/logout", async (request) => {
    const token = readCookie(request.headers.cookie, ADMIN_COOKIE);
    if (token) {
      const session = await store.findAdminSession(sha256(token));
      if (session) await store.revokeAdminSession(session.id, now());
    }
    return json(200, { ok: true }, { "set-cookie": clearedAdminCookie() });
  });

  router.add("GET", "/v1/admin/me", async (request) => {
    const context = await requireAdmin(request);
    return json(200, { admin: { id: context.session.adminId, username: context.session.username, role: context.session.role }, expiresAt: context.session.expiresAt });
  });

  // ----------------------------------------------------------- admin reads

  router.add("GET", "/v1/admin/overview", async (request) => {
    await requireAdmin(request);
    const overview = await store.overview(dayStartUtc(), onlineSince());
    const { spentTodayMilli, ...rest } = overview;
    return json(200, { ...rest, spentToday: credits(spentTodayMilli), generatedAt: now().toISOString() });
  });

  router.add("GET", "/v1/admin/users", async (request) => {
    await requireAdmin(request);
    const query = request.query;
    const page = Math.max(Number(query.get("page") ?? 1), 1);
    const pageSize = Math.min(Math.max(Number(query.get("pageSize") ?? 20), 1), 1000);
    const statusRaw = query.get("status");
    const onlineRaw = query.get("online");
    const sortRaw = query.get("sort");
    const orderRaw = query.get("order");
    const result = await store.listUsers({
      q: query.get("q")?.trim() || undefined,
      status: statusRaw === null || statusRaw === "" ? undefined : Number(statusRaw),
      online: onlineRaw === null || onlineRaw === "" ? undefined : onlineRaw === "1" || onlineRaw === "true",
      onlineSince: onlineSince(),
      sort: sortRaw === "balance" || sortRaw === "spent" || sortRaw === "recent" ? sortRaw : "id",
      order: orderRaw === "asc" ? "asc" : "desc",
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return json(200, {
      page,
      pageSize,
      total: result.total,
      items: result.rows.map((row) => ({ ...userView(row), online: row.onlineSessions > 0, presence: row.onlineSessions > 0 ? "online" : "offline" })),
    });
  });

  router.add("GET", "/v1/admin/users/:id", async (request, params) => {
    await requireAdmin(request);
    const userId = parseBigId(params.id ?? "");
    const user = await store.getUser(userId);
    if (!user) throw new HttpError(404, "user_not_found", "no such user");
    const credit = await store.getCredit(userId);
    const sessions = await store.listSessions(userId, 50);
    const ledger = await store.listLedger(userId, undefined, 30);
    const usage = await store.listUsageDaily(userId, new Date(now().getTime() - 30 * 86400 * 1000));
    return json(200, {
      user: userView(user),
      credit: creditView(credit),
      onlineSessions: sessions.filter((item) => !item.revokedAt && new Date(item.lastSeenAt).getTime() >= onlineSince().getTime()).length,
      activeSessions: sessions.filter((item) => !item.revokedAt).length,
      sessions: sessions.map((session) => sessionView(session, now().getTime())),
      ledger: ledger.map(ledgerView),
      usage,
    });
  });

  router.add("GET", "/v1/admin/users/:id/ledger", async (request, params) => {
    await requireAdmin(request);
    const userId = parseBigId(params.id ?? "");
    const before = request.query.get("beforeId");
    const limit = Math.min(Math.max(Number(request.query.get("limit") ?? 30), 1), 100);
    const rows = await store.listLedger(userId, before ? parseBigId(before) : undefined, limit);
    return json(200, { items: rows.map(ledgerView), nextBeforeId: rows.length === limit ? rows[rows.length - 1]!.id : null });
  });

  router.add("GET", "/v1/admin/users/:id/usage", async (request, params) => {
    await requireAdmin(request);
    const userId = parseBigId(params.id ?? "");
    const days = Math.min(Math.max(Number(request.query.get("days") ?? 30), 1), 180);
    const usage = await store.listUsageDaily(userId, new Date(now().getTime() - days * 86400 * 1000));
    return json(200, { days, items: usage });
  });

  router.add("GET", "/v1/admin/users/:id/sessions", async (request, params) => {
    await requireAdmin(request);
    const userId = parseBigId(params.id ?? "");
    const sessions = await store.listSessions(userId, 100);
    return json(200, { items: sessions.map((session) => sessionView(session, now().getTime())) });
  });

  router.add("GET", "/v1/admin/users/:id/audit", async (request, params) => {
    await requireAdmin(request);
    const userId = parseBigId(params.id ?? "");
    return json(200, { items: await store.listUserAudit(userId, 50) });
  });

  router.add("GET", "/v1/admin/audit", async (request) => {
    await requireAdmin(request);
    const before = request.query.get("beforeId");
    const limit = Math.min(Math.max(Number(request.query.get("limit") ?? 50), 1), 200);
    const rows = await store.listAudit(before ? parseBigId(before) : undefined, limit);
    return json(200, { items: rows, nextBeforeId: rows.length === limit ? rows[rows.length - 1]!.id : null });
  });

  // ---------------------------------------------------------- admin writes

  router.add("POST", "/v1/admin/users/:id/sessions/:sid/revoke", async (request, params) => {
    const context = await requireAdmin(request, 1);
    const userId = parseBigId(params.id ?? "");
    const sessionId = params.sid ?? "";
    const target = await store.getSession(sessionId);
    if (!target || target.userId !== userId) throw new HttpError(404, "session_not_found", "no such session for this user");
    const revoked = await store.revokeSession(sessionId, "ADMIN_OFFLINE", now());
    await store.writeAudit({ adminId: context.session.adminId, action: "SESSION_REVOKE", targetType: "user", targetId: String(userId), detail: { sessionId }, ip: request.ip ?? undefined });
    await store.recordLoginEvent({ userId, sessionId, event: "REVOKED", result: revoked ? 0 : 1 });
    return json(200, { ok: true, revoked });
  });

  router.add("POST", "/v1/admin/users/:id/credits/adjust", async (request, params) => {
    const context = await requireAdmin(request, 1);
    const userId = parseBigId(params.id ?? "");
    const body = readJsonBody(request);
    const deltaCredits = readNumber(body, "deltaCredits", { min: -config.adminAdjustLimitCredits, max: config.adminAdjustLimitCredits });
    const reason = readString(body, "reason", { maxLength: 120 });
    if (deltaCredits === undefined || deltaCredits === 0) throw new HttpError(400, "invalid_delta", "deltaCredits must be non-zero");
    if (!reason) throw new HttpError(400, "missing_reason", "reason is required");

    const result = await store.adjustCredits({ userId, deltaMilli: Math.round(deltaCredits * MILLI_PER_CREDIT), remark: reason, adminId: context.session.adminId, ip: request.ip ?? undefined });
    if (!result) throw new HttpError(409, "adjust_rejected", "balance would go negative or the account has no credit row");
    return json(200, { balance: result.balance, balanceCredits: credits(result.balance), ledger: ledgerView(result.ledger) });
  });

  router.add("POST", "/v1/admin/users/:id/status", async (request, params) => {
    const context = await requireAdmin(request, 1);
    const userId = parseBigId(params.id ?? "");
    const body = readJsonBody(request);
    const status = readNumber(body, "status", { min: 0, max: 3 });
    if (status === undefined) throw new HttpError(400, "invalid_status", "status must be 0..3");
    const updated = await store.setUserStatus(userId, status, { adminId: context.session.adminId, action: "USER_STATUS", ip: request.ip ?? undefined });
    if (!updated) throw new HttpError(404, "user_not_found", "no such user");
    return json(200, { user: userView(updated) });
  });

  // -------------------------------------------------------- admin console

  router.add("GET", "/admin", async () => staticAsset("index.html", "text/html; charset=utf-8"));
  router.add("GET", "/admin/app.js", async () => staticAsset("app.js", "text/javascript; charset=utf-8"));
  router.add("GET", "/admin/styles.css", async () => staticAsset("styles.css", "text/css; charset=utf-8"));

  return async (request) => {
    const origin = request.headers.origin;
    const cors: Record<string, string> = { vary: "origin" };
    if (origin && origin === config.adminOrigin) {
      cors["access-control-allow-origin"] = origin;
      cors["access-control-allow-credentials"] = "true";
      cors["access-control-allow-headers"] = "content-type";
      cors["access-control-allow-methods"] = "GET,POST,PATCH,DELETE,OPTIONS";
    } else if (origin && originAllowed(origin, config.webOrigins)) {
      // The clients keep their tokens in memory/storage and send them as a
      // header, so these origins get no credentials-carrying CORS.
      cors["access-control-allow-origin"] = origin;
      cors["access-control-allow-headers"] = "content-type,authorization";
      cors["access-control-allow-methods"] = "GET,POST,PATCH,DELETE,OPTIONS";
    }
    if (request.method === "OPTIONS") return { status: 204, headers: cors, body: "" };
    try {
      const match = router.match(request.method, request.path);
      if (!match) throw new HttpError(404, "not_found", "no such route");
      const response = await match.handler(request, match.params);
      return { ...response, headers: { ...response.headers, ...cors } };
    } catch (error) {
      const response = errorResponse(error);
      return { ...response, headers: { ...response.headers, ...cors } };
    }
  };
}

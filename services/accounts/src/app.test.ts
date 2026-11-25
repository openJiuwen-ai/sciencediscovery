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
 * Route-level tests against an in-memory store.
 *
 * The SQL itself is exercised by the deployment, not here; what these tests pin
 * down is the part that is easy to get wrong in review: a ticket works once, a
 * rotated refresh token is a leak signal, and an admin without the operator role
 * cannot move credits.
 */

import { createTest } from "../../../test/support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createApp } from "./app.js";
import { ConfigError, loadConfig, type AccountsConfig } from "./config.js";
import { hashPassword } from "./crypto.js";
import type { HttpRequest, HttpResponse } from "./http.js";
import { ledgerAfter } from "./ledger.js";
import type { ModelPrice } from "./pricing.js";
import type {
  AccountsStore, AdminRow, AdminSessionRow, AuditRow, AuthFlowRow, CreditRow, HoldInput, HoldResult, LedgerRow, OverviewRow,
  ReleaseResult, SessionRow, SettleInput, SettleResult, SignInInput, SignInResult, UsageDayRow, UsageRecordRow, UserFilter, UserListRow, UserRow,
} from "./store.js";

test("account configuration validates sign-in rewards and preserves explicit zero", () => {
  const env = {
    DATABASE_URL: "postgres://local/accounts_test",
    JWT_SECRET: randomUUID(),
    HUAWEI_CLIENT_ID: "local-fixture",
    WEB_RETURN_URL: "http://localhost/return",
    ADMIN_ORIGIN: "http://localhost",
  };
  function rewards(overrides: NodeJS.ProcessEnv = {}) {
    const config = loadConfig({ ...env, ...overrides });
    return [config.dailyRewardCredits, config.checkinBonusEveryDays, config.streakBonusCredits];
  }
  assert.deepEqual(rewards(), [100, 7, 50]);
  assert.deepEqual(rewards({ DAILY_REWARD_DAYS: "9" }), [100, 9, 50]);
  assert.deepEqual(rewards({ DAILY_REWARD_CREDITS: "0", CHECKIN_BONUS_EVERY_DAYS: "0", DAILY_REWARD_DAYS: "9", STREAK_BONUS_CREDITS: "0" }), [0, 0, 0]);
  for (const [key, value] of [
    ["DAILY_REWARD_CREDITS", "100credits"],
    ["DAILY_REWARD_CREDITS", String(Number.MAX_SAFE_INTEGER)],
    ["CHECKIN_BONUS_EVERY_DAYS", "   "],
    ["DAILY_REWARD_DAYS", "1.5"],
    ["STREAK_BONUS_CREDITS", "-1"],
  ] as const) {
    assert.throws(() => rewards({ [key]: value }), (error: unknown) => error instanceof ConfigError && error.message.includes(key));
  }
});

const SERVICE_TOKEN = "service-token";

const NOW = new Date("2026-03-01T08:00:00.000Z");
const SECRET = "test-secret-that-is-long-enough-for-hs256";
/** Generated per run so no login credential is ever a literal in the source. */
const ADMIN_PASSWORD = randomUUID();

class MemoryStore implements AccountsStore {
  users = new Map<number, UserRow>();
  credits = new Map<number, CreditRow>();
  ledger: LedgerRow[] = [];
  sessions = new Map<string, SessionRow & { refreshHash: Buffer; prevRefreshHash?: Buffer }>();
  tickets = new Map<string, { openid: string; expiresAt: Date; usedAt: Date | null }>();
  authFlows = new Map<string, { codeVerifier: string; returnUrl: string; expiresAt: Date; usedAt: Date | null }>();
  admins: AdminRow[] = [];
  adminSessions = new Map<string, AdminSessionRow & { tokenHash: Buffer; revokedAt: string | null }>();
  audits: AuditRow[] = [];
  prices = new Map<string, ModelPrice>([
    ["deepseek-v4-flash", { model: "deepseek-v4-flash", inputMilliPer1k: 25, cachedInputMilliPer1k: 3, outputMilliPer1k: 50 }],
    ["deepseek-v4-pro", { model: "deepseek-v4-pro", inputMilliPer1k: 150, cachedInputMilliPer1k: 15, outputMilliPer1k: 300 }],
  ]);
  holds = new Map<string, { userId: number; holdAmount: number; status: number; settledAmount: number | null }>();
  private nextUserId = 1;
  private nextLedgerId = 1;
  private nextAuditId = 1;

  async signIn(input: SignInInput): Promise<SignInResult> {
    let user = [...this.users.values()].find((item) => item.openid === input.openid);
    const isNewUser = !user;
    let grantedMilli = 0;
    if (!user) {
      user = {
        id: this.nextUserId++, openid: input.openid, displayName: input.displayName ?? null,
        avatarUrl: input.avatarUrl ?? null, email: input.email ?? null, status: 0,
        createdAt: NOW.toISOString(), lastLoginAt: NOW.toISOString(),
      };
      this.users.set(user.id, user);
      this.credits.set(user.id, { userId: user.id, balance: 0, frozen: 0, totalEarned: 0, totalSpent: 0, updatedAt: NOW.toISOString() });
      if (input.grantMilliCredits > 0) {
        this.pushLedger(user.id, input.grantMilliCredits, "REGISTER", String(user.id), "注册赠送");
        grantedMilli += input.grantMilliCredits;
      }
    }
    // The daily reward needs calendar arithmetic; the HTTP tests only exercise
    // the first sign-in, so the fake leaves the programme out.
    return { user, credit: this.credits.get(user.id)!, isNewUser, rewardDay: 0, grantedMilli };
  }

  async getUser(userId: number): Promise<UserRow | undefined> {
    return this.users.get(userId);
  }

  async findUserByOpenid(openid: string): Promise<UserRow | undefined> {
    return [...this.users.values()].find((item) => item.openid === openid);
  }

  async getCredit(userId: number): Promise<CreditRow | undefined> {
    return this.credits.get(userId);
  }

  async updateProfile(userId: number, patch: { displayName?: string | undefined; email?: string | undefined }): Promise<UserRow | undefined> {
    const user = this.users.get(userId);
    if (!user) return undefined;
    const updated = { ...user, displayName: patch.displayName ?? user.displayName, email: patch.email ?? user.email };
    this.users.set(userId, updated);
    return updated;
  }

  async listLedger(userId: number, beforeId: number | undefined, limit: number): Promise<LedgerRow[]> {
    return this.ledger.filter((row) => row.userId === userId && (beforeId === undefined || row.id < beforeId)).sort((a, b) => b.id - a.id).slice(0, limit);
  }

  async countCheckins(userId: number): Promise<{ total: number; lastDate: string | null }> {
    const rows = this.ledger.filter((row) => row.userId === userId && row.bizType === "CHECKIN");
    const lastDate = rows.map((row) => row.bizId.split(":")[1] ?? "").sort().at(-1) ?? null;
    return { total: rows.length, lastDate };
  }

  async createTicket(jti: string, openid: string, expiresAt: Date): Promise<void> {
    this.tickets.set(jti, { openid, expiresAt, usedAt: null });
  }

  async consumeTicket(jti: string, now: Date): Promise<string | undefined> {
    const ticket = this.tickets.get(jti);
    if (!ticket || ticket.usedAt || ticket.expiresAt <= now) return undefined;
    ticket.usedAt = now;
    return ticket.openid;
  }

  async createAuthFlow(input: { state: string; codeVerifier: string; returnUrl: string; expiresAt: Date }): Promise<void> {
    this.authFlows.set(input.state, { codeVerifier: input.codeVerifier, returnUrl: input.returnUrl, expiresAt: input.expiresAt, usedAt: null });
  }

  async consumeAuthFlow(state: string, now: Date): Promise<AuthFlowRow | undefined> {
    const flow = this.authFlows.get(state);
    if (!flow || flow.usedAt || flow.expiresAt <= now) return undefined;
    flow.usedAt = now;
    return { state, codeVerifier: flow.codeVerifier, returnUrl: flow.returnUrl, expiresAt: flow.expiresAt.toISOString(), usedAt: now.toISOString() };
  }

  async createSession(input: Parameters<AccountsStore["createSession"]>[0]): Promise<SessionRow> {
    const session = {
      id: randomUUID(), userId: input.userId, platform: input.platform, deviceLabel: input.deviceLabel ?? null,
      deviceId: input.deviceId ?? null, ip: input.ip ?? null, userAgent: input.userAgent ?? null,
      createdAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(), expiresAt: input.expiresAt.toISOString(),
      revokedAt: null, revokedReason: null, refreshHash: input.refreshHash,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async findSessionByRefreshHash(hash: Buffer): Promise<SessionRow | undefined> {
    return [...this.sessions.values()].find((session) => session.refreshHash.equals(hash));
  }

  async findSessionByPrevRefreshHash(hash: Buffer): Promise<SessionRow | undefined> {
    return [...this.sessions.values()].find((session) => session.prevRefreshHash?.equals(hash) === true);
  }

  async replaceSessionRefresh(sessionId: string, expectedHash: Buffer, nextHash: Buffer, now: Date): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.revokedAt || !session.refreshHash?.equals(expectedHash)) return false;
    session.prevRefreshHash = session.refreshHash;
    session.prevRotatedAt = now.toISOString();
    session.refreshHash = nextHash;
    session.lastSeenAt = now.toISOString();
    return true;
  }

  async getSession(sessionId: string): Promise<SessionRow | undefined> {
    return this.sessions.get(sessionId);
  }

  async touchSession(sessionId: string, now: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.lastSeenAt = now.toISOString();
  }

  async revokeSession(sessionId: string, reason: string, now: Date): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.revokedAt) return false;
    session.revokedAt = now.toISOString();
    session.revokedReason = reason;
    return true;
  }

  async listSessions(userId: number, limit: number): Promise<SessionRow[]> {
    return [...this.sessions.values()].filter((session) => session.userId === userId).slice(0, limit);
  }

  async countOnlineSessions(userId: number, since: Date): Promise<number> {
    return [...this.sessions.values()].filter((session) => session.userId === userId && !session.revokedAt && new Date(session.lastSeenAt) >= since).length;
  }

  async recordLoginEvent(): Promise<void> {}

  async findAdmin(username: string): Promise<AdminRow | undefined> {
    return this.admins.find((admin) => admin.username === username);
  }

  async findAdminById(adminId: number): Promise<AdminRow | undefined> {
    return this.admins.find((admin) => admin.id === adminId);
  }

  async recordAdminFailure(adminId: number, lockedUntil: Date | undefined): Promise<number> {
    const admin = this.admins.find((item) => item.id === adminId);
    if (!admin) return 0;
    admin.failedCount += 1;
    admin.lockedUntil = lockedUntil?.toISOString() ?? null;
    return admin.failedCount;
  }

  async resetAdminFailures(adminId: number, loginAt: Date): Promise<void> {
    const admin = this.admins.find((item) => item.id === adminId);
    if (!admin) return;
    admin.failedCount = 0;
    admin.lockedUntil = null;
    admin.lastLoginAt = loginAt.toISOString();
  }

  async createAdminSession(input: Parameters<AccountsStore["createAdminSession"]>[0]): Promise<string> {
    const admin = this.admins.find((item) => item.id === input.adminId)!;
    const id = randomUUID();
    this.adminSessions.set(id, {
      id, adminId: input.adminId, username: admin.username, role: admin.role,
      expiresAt: input.expiresAt.toISOString(), tokenHash: input.tokenHash, revokedAt: null,
    });
    return id;
  }

  async findAdminSession(tokenHash: Buffer): Promise<AdminSessionRow | undefined> {
    return [...this.adminSessions.values()].find((session) => session.tokenHash.equals(tokenHash) && !session.revokedAt && new Date(session.expiresAt) > NOW);
  }

  async touchAdminSession(): Promise<void> {}

  async revokeAdminSession(sessionId: string, now: Date): Promise<void> {
    const session = this.adminSessions.get(sessionId);
    if (session) session.revokedAt = now.toISOString();
  }

  async overview(): Promise<OverviewRow> {
    const rows = [...this.users.values()];
    const spent = this.ledger.filter((row) => row.delta < 0).reduce((sum, row) => sum - row.delta, 0);
    return {
      totalUsers: rows.length,
      newUsersToday: rows.filter((row) => row.createdAt >= "2026-03-01").length,
      activeToday: rows.length,
      spentTodayMilli: spent,
      onlineSessions: [...this.sessions.values()].filter((session) => !session.revokedAt).length,
      frozenUsers: rows.filter((row) => row.status === 2).length,
    };
  }

  async listUsers(filter: UserFilter): Promise<{ rows: UserListRow[]; total: number }> {
    const all: UserListRow[] = [...this.users.values()].map((user) => {
      const credit = this.credits.get(user.id)!;
      const online = [...this.sessions.values()].filter((session) => session.userId === user.id && !session.revokedAt).length;
      return { ...user, balance: credit.balance, totalEarned: credit.totalEarned, totalSpent: credit.totalSpent, onlineSessions: online, lastSeenAt: user.lastLoginAt };
    }).filter((row) => {
      if (filter.q && !`${row.displayName ?? ""}${row.openid}${row.email ?? ""}`.includes(filter.q)) return false;
      if (filter.status !== undefined && row.status !== filter.status) return false;
      if (filter.online === true && row.onlineSessions === 0) return false;
      if (filter.online === false && row.onlineSessions > 0) return false;
      return true;
    });
    return { total: all.length, rows: all.slice(filter.offset, filter.offset + filter.limit) };
  }

  async listUsageDaily(): Promise<UsageDayRow[]> {
    return [];
  }

  async listUsageRecent(): Promise<UsageRecordRow[]> {
    return [];
  }

  async getModelPrice(model: string): Promise<ModelPrice | undefined> {
    return this.prices.get(model);
  }

  async holdCredits(input: HoldInput): Promise<HoldResult> {
    const credit = this.credits.get(input.userId);
    const balance = credit?.balance ?? 0;
    const frozen = credit?.frozen ?? 0;
    const existing = this.holds.get(input.requestId);
    if (existing) {
      const status = existing.userId === input.userId && existing.status === 0 ? "held" : "closed";
      return { status, balance, frozen, holdAmount: existing.holdAmount };
    }
    if (!credit) return { status: "no_account", balance, frozen, holdAmount: input.holdMilli };
    if (credit.balance < input.holdMilli) return { status: "insufficient", balance, frozen, holdAmount: input.holdMilli };
    credit.balance -= input.holdMilli;
    credit.frozen += input.holdMilli;
    this.holds.set(input.requestId, { userId: input.userId, holdAmount: input.holdMilli, status: 0, settledAmount: null });
    return { status: "held", balance: credit.balance, frozen: credit.frozen, holdAmount: input.holdMilli };
  }

  async settleCredits(input: SettleInput): Promise<SettleResult> {
    const credit = this.credits.get(input.userId);
    const balance = credit?.balance ?? 0;
    const frozen = credit?.frozen ?? 0;
    const hold = this.holds.get(input.requestId);
    if (!hold || hold.userId !== input.userId) return { status: "missing", balance, frozen, holdAmount: 0, charged: 0 };
    if (hold.status === 2) return { status: "released", balance, frozen, holdAmount: hold.holdAmount, charged: 0 };
    if (hold.status === 1) {
      return { status: "already_settled", balance, frozen, holdAmount: hold.holdAmount, charged: hold.settledAmount ?? 0 };
    }
    if (!credit) return { status: "missing", balance, frozen, holdAmount: hold.holdAmount, charged: 0 };
    // The platform absorbs anything past the hold, so a balance never goes negative.
    const charged = Math.min(input.chargedMilli, hold.holdAmount);
    hold.status = 1;
    hold.settledAmount = charged;
    credit.frozen -= hold.holdAmount;
    credit.balance += hold.holdAmount;
    // Same rule as PostgresStore: the row continues the ledger's running total
    // rather than snapshotting a balance another in-flight hold has already
    // dipped into.
    this.pushLedger(input.userId, -charged, "LLM_USAGE", input.requestId, `${input.model} 调用`);
    return { status: "settled", balance: credit.balance, frozen: credit.frozen, holdAmount: hold.holdAmount, charged };
  }

  async releaseHold(input: { userId: number; requestId: string }): Promise<ReleaseResult> {
    const credit = this.credits.get(input.userId);
    const balance = credit?.balance ?? 0;
    const frozen = credit?.frozen ?? 0;
    const hold = this.holds.get(input.requestId);
    if (!hold || hold.userId !== input.userId) return { status: "missing", balance, frozen, holdAmount: 0 };
    if (hold.status === 1) return { status: "settled", balance, frozen, holdAmount: hold.holdAmount };
    if (hold.status === 2) return { status: "already_released", balance, frozen, holdAmount: hold.holdAmount };
    if (!credit) return { status: "missing", balance, frozen, holdAmount: hold.holdAmount };
    hold.status = 2;
    credit.frozen -= hold.holdAmount;
    credit.balance += hold.holdAmount;
    return { status: "released", balance: credit.balance, frozen: credit.frozen, holdAmount: hold.holdAmount };
  }

  async adjustCredits(input: { userId: number; deltaMilli: number; remark: string; adminId: number; ip?: string | undefined }): Promise<{ balance: number; ledger: LedgerRow } | undefined> {
    const credit = this.credits.get(input.userId);
    if (!credit || credit.balance + input.deltaMilli < 0) return undefined;
    const row = this.pushLedger(input.userId, input.deltaMilli, "ADMIN", randomUUID(), input.remark);
    await this.writeAudit({ adminId: input.adminId, action: "CREDIT_ADJUST", targetType: "user", targetId: String(input.userId), detail: { delta: input.deltaMilli } });
    return { balance: credit.balance, ledger: row };
  }

  async setUserStatus(userId: number, status: number, audit: Parameters<AccountsStore["setUserStatus"]>[2]): Promise<UserRow | undefined> {
    const user = this.users.get(userId);
    if (!user) return undefined;
    const updated = { ...user, status };
    this.users.set(userId, updated);
    await this.writeAudit({ ...audit, targetType: "user", targetId: String(userId) });
    return updated;
  }

  async writeAudit(input: Parameters<AccountsStore["writeAudit"]>[0]): Promise<void> {
    this.audits.push({
      id: this.nextAuditId++, adminId: input.adminId, adminUsername: this.admins.find((admin) => admin.id === input.adminId)?.username ?? null,
      action: input.action, targetType: input.targetType ?? null, targetId: input.targetId ?? null,
      detail: input.detail ?? null, ip: input.ip ?? null, createdAt: NOW.toISOString(),
    });
  }

  async listAudit(beforeId: number | undefined, limit: number): Promise<AuditRow[]> {
    return this.audits.filter((row) => beforeId === undefined || row.id < beforeId).sort((a, b) => b.id - a.id).slice(0, limit);
  }

  async listUserAudit(userId: number, limit: number): Promise<AuditRow[]> {
    return this.audits.filter((row) => row.targetId === String(userId)).slice(0, limit);
  }

  private pushLedger(userId: number, delta: number, bizType: string, bizId: string, remark: string, balanceAfter?: number): LedgerRow {
    const credit = this.credits.get(userId)!;
    credit.balance += delta;
    if (delta > 0) credit.totalEarned += delta;
    else credit.totalSpent += -delta;
    // Same rule as `appendLedger` in the SQL store: a row continues the
    // ledger's running total, never the spendable balance (which has open
    // holds subtracted from it).
    const previous = [...this.ledger].reverse().find((row) => row.userId === userId);
    const row: LedgerRow = {
      id: this.nextLedgerId++, userId, delta,
      balanceAfter: balanceAfter ?? ledgerAfter(previous?.balanceAfter, delta),
      bizType, bizId, remark, createdAt: NOW.toISOString(),
    };
    this.ledger.push(row);
    return row;
  }
}

function config(overrides: Partial<AccountsConfig> = {}): AccountsConfig {
  return {
    databaseUrl: "postgres://unused",
    jwtSecret: SECRET,
    billingToken: SERVICE_TOKEN,
    litellmBaseUrl: "https://gateway.test",
    litellmApiKey: "internal-key",
    litellmTimeoutSeconds: 600,
    huaweiClientId: "client",
    huaweiClientSecret: "secret",
    huaweiTokenEndpoint: "https://token.example.com",
    huaweiRedirectUri: "https://api.example.com/v1/auth/huawei/callback",
    webReturnUrl: "https://app.example.com/login",
    adminOrigin: "https://admin.example.com",
    webOrigins: ["http://127.0.0.1:4310"],
    adminCookieDomain: "",
    cookieSecure: true,
    accessTtlSeconds: 900,
    refreshTtlSeconds: 3600,
    ticketTtlSeconds: 60,
    adminSessionTtlSeconds: 3600,
    registerGrantCredits: 500,
    dailyRewardCredits: 0,
    checkinBonusEveryDays: 7,
    streakBonusCredits: 0,
    adminAdjustLimitCredits: 1000,
    adminMaxFailures: 5,
    adminLockSeconds: 900,
    ...overrides,
  };
}

function fakeHuawei(openid: string): typeof fetch {
  return fakeHuaweiWithBody(openid).fetchImpl;
}

function fakeHuaweiWithBody(openid: string): { fetchImpl: typeof fetch; bodies: URLSearchParams[] } {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    openid,
    display_name: "测试用户",
    iss: "https://accounts.huawei.com",
    aud: "client",
    azp: "client",
    exp: now + 3600,
    iat: now,
  })).toString("base64url");
  const bodies: URLSearchParams[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    assert.equal(String(input), "https://token.example.com");
    bodies.push(new URLSearchParams(String(init?.body ?? "")));
    return new Response(JSON.stringify({ access_token: "a", id_token: `${header}.${payload}.sig` }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

function call(app: (request: HttpRequest) => Promise<HttpResponse>, method: string, target: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<HttpResponse> {
  const url = new URL(target, "https://api.example.com");
  const body = options.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.body));
  return app({
    method,
    path: url.pathname.replace(/\/+$/u, "") || "/",
    query: url.searchParams,
    headers: { "content-type": "application/json", "user-agent": "test", ...options.headers },
    body,
    ip: "10.0.0.1",
  });
}

function payload(response: HttpResponse): Record<string, any> {
  return JSON.parse(String(response.body)) as Record<string, any>;
}

async function signInUser(app: (request: HttpRequest) => Promise<HttpResponse>, openid = "openid-1"): Promise<{ accessToken: string; refreshToken: string; isNewUser: boolean }> {
  const started = await call(app, "GET", "/v1/auth/huawei/start?returnUrl=https%3A%2F%2Fapp.example.com%2Flogin");
  assert.equal(started.status, 303);
  const authorize = new URL(String(started.headers.location));
  const state = authorize.searchParams.get("state")!;
  assert.ok(state);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorize.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/u);

  const callback = await call(app, "GET", `/v1/auth/huawei/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(callback.status, 302);
  const location = String(callback.headers.location);
  assert.match(location, /^https:\/\/app\.example\.com\/login#auth-ticket=/u);
  const fragment = new URLSearchParams(location.split("#")[1]);

  const exchanged = await call(app, "POST", "/v1/auth/ticket", { body: { ticket: fragment.get("auth-ticket"), platform: 2 } });
  assert.equal(exchanged.status, 200);
  const session = payload(exchanged);
  assert.equal(session.credit.balance, 500_000);
  assert.equal(session.credit.balanceCredits, 500);
  return { accessToken: session.accessToken, refreshToken: session.refreshToken, isNewUser: session.isNewUser };
}

async function seedAdmin(store: MemoryStore, username: string, role: number): Promise<void> {
  store.admins.push({
    id: store.admins.length + 100,
    username,
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    role,
    status: 0,
    failedCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
  });
}

async function adminLogin(app: (request: HttpRequest) => Promise<HttpResponse>, username: string): Promise<string> {
  const response = await call(app, "POST", "/v1/admin/auth/login", { body: { username, password: ADMIN_PASSWORD } });
  assert.equal(response.status, 200);
  const cookie = response.headers["set-cookie"] ?? "";
  assert.match(cookie, /sd_admin=/u);
  return cookie.split(";")[0]!;
}

test("a ticket is single use and yields a session with the signup grant", async () => {
  const store = new MemoryStore();
  const huawei = fakeHuaweiWithBody("openid-1");
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: huawei.fetchImpl });
  const { accessToken, isNewUser } = await signInUser(app);
  assert.equal(isNewUser, true);
  assert.equal(huawei.bodies[0]?.get("client_id"), "client");
  assert.ok(huawei.bodies[0]?.get("code_verifier"));

  const me = await call(app, "GET", "/v1/me", { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(me.status, 200);
  assert.equal(payload(me).credit.balanceCredits, 500);

  const started = await call(app, "GET", "/v1/auth/huawei/start?returnUrl=https%3A%2F%2Fapp.example.com%2Flogin");
  const state = new URL(String(started.headers.location)).searchParams.get("state")!;
  const callback = await call(app, "GET", `/v1/auth/huawei/callback?code=abc&state=${encodeURIComponent(state)}`);
  const ticket = new URLSearchParams(String(callback.headers.location).split("#")[1]).get("auth-ticket");
  const first = await call(app, "POST", "/v1/auth/ticket", { body: { ticket } });
  assert.equal(first.status, 200);
  const second = await call(app, "POST", "/v1/auth/ticket", { body: { ticket } });
  assert.equal(second.status, 401);
  assert.equal(payload(second).error.code, "ticket_invalid");
});

test("the signed-in user can inspect and revoke sessions, and rename within bounds", async () => {
  const store = new MemoryStore();
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  const { accessToken } = await signInUser(app);

  const me = await call(app, "GET", "/v1/me", { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(me.status, 200);
  const currentSessionId = payload(me).currentSessionId as string;

  const sessions = await call(app, "GET", "/v1/me/sessions", { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(sessions.status, 200);
  assert.equal(payload(sessions).items.length, 1);
  assert.equal(payload(sessions).items[0].current, true);
  assert.equal("refreshHash" in payload(sessions).items[0], false);
  assert.equal("refresh_hash" in payload(sessions).items[0], false);
  assert.equal("prev_refresh_hash" in payload(sessions).items[0], false);

  const currentRevoke = await call(app, "DELETE", `/v1/me/sessions/${currentSessionId}`, { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(currentRevoke.status, 200);
  const afterRevoke = await call(app, "GET", "/v1/me", { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(afterRevoke.status, 401);

  const next = await signInUser(app);
  const renamed = await call(app, "PATCH", "/v1/me", { headers: { authorization: `Bearer ${next.accessToken}` }, body: { displayName: "新昵称" } });
  assert.equal(renamed.status, 200);
  assert.equal(payload(renamed).user.displayName, "新昵称");

  const tooLong = await call(app, "PATCH", "/v1/me", { headers: { authorization: `Bearer ${next.accessToken}` }, body: { displayName: "a".repeat(25) } });
  assert.equal(tooLong.status, 400);
});

test("the account usage endpoint returns the recent calls and daily totals the page reads", async () => {
  const store = new MemoryStore();
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  const { accessToken } = await signInUser(app);
  const usage = await call(app, "GET", "/v1/me/usage", { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(usage.status, 200);
  assert.deepEqual(payload(usage), { days: [], records: [] });

  const ledger = await call(app, "GET", "/v1/credits/ledger", { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(ledger.status, 200);
  assert.equal(payload(ledger).items.length, 1);
  assert.equal(payload(ledger).items[0].bizType, "REGISTER");
});


test("the authorization start validates return origins and the callback returns there", async () => {
  const store = new MemoryStore();
  const app = createApp({ config: config({ webOrigins: ["http://127.0.0.1:*"] }), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  const start = async (returnUrl: string): Promise<string> => {
    const response = await call(app, "GET", `/v1/auth/huawei/start?returnUrl=${encodeURIComponent(returnUrl)}`);
    assert.equal(response.status, 303);
    return new URL(String(response.headers.location)).searchParams.get("state")!;
  };
  const callback = (state: string): Promise<HttpResponse> => call(app, "GET", `/v1/auth/huawei/callback?code=abc&state=${encodeURIComponent(state)}`);

  const desktop = await callback(await start("http://127.0.0.1:4313/login"));
  assert.equal(desktop.status, 302);
  assert.match(String(desktop.headers.location), /^http:\/\/127\.0\.0\.1:4313\/login#auth-ticket=/u);

  const web = await callback(await start("https://app.example.com/login"));
  assert.match(String(web.headers.location), /^https:\/\/app\.example\.com\/login#auth-ticket=/u);

  // Any port on the desktop host is fine, a different host is rejected before
  // the flow is stored.
  assert.match(String((await callback(await start("http://127.0.0.1:9/login"))).headers.location), /^http:\/\/127\.0\.0\.1:9\/login#/u);
  const stranger = await call(app, "GET", "/v1/auth/huawei/start?returnUrl=https%3A%2F%2Fevil.example.net%2Fsteal");
  assert.equal(stranger.status, 400);
  assert.equal(payload(stranger).error.code, "invalid_return_url");

  const state = await start("http://127.0.0.1:4313/login");
  const refused = await call(app, "GET", `/v1/auth/huawei/callback?error=access_denied&state=${encodeURIComponent(state)}`);
  assert.equal(refused.status, 302);
  assert.match(String(refused.headers.location), /^http:\/\/127\.0\.0\.1:4313\/login#error=access_denied$/u);
});

test("refresh rotates, and replaying the old token revokes the session", async () => {
  const store = new MemoryStore();
  let clock = NOW;
  const app = createApp({ config: config(), store, now: () => clock, fetchImpl: fakeHuawei("openid-1") });
  const { accessToken, refreshToken } = await signInUser(app);

  const rotated = await call(app, "POST", "/v1/auth/refresh", { body: { refreshToken } });
  assert.equal(rotated.status, 200);
  assert.notEqual(payload(rotated).refreshToken, refreshToken);

  // Activity must not reopen the retry window: it is anchored at the rotation.
  clock = new Date(NOW.getTime() + 20_000);
  const active = await call(app, "GET", "/v1/me", { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(active.status, 200);

  // Past the retry window, the same token is a leak signal.
  clock = new Date(NOW.getTime() + 31_000);
  const replay = await call(app, "POST", "/v1/auth/refresh", { body: { refreshToken } });
  assert.equal(replay.status, 401);
  assert.equal(payload(replay).error.code, "invalid_refresh");

  const afterReplay = await call(app, "GET", "/v1/me", { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(afterReplay.status, 401);
  assert.equal(payload(afterReplay).error.code, "session_revoked");
  assert.equal([...store.sessions.values()][0]!.revokedReason, "ROTATE_REUSE");
});

test("a lost refresh response is refused inside the window without revoking", async () => {
  const store = new MemoryStore();
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  const { refreshToken } = await signInUser(app);

  const rotated = await call(app, "POST", "/v1/auth/refresh", { body: { refreshToken } });
  assert.equal(rotated.status, 200);

  // The client retries with the only token it has. It is the predecessor now,
  // so it is refused — but the session and the successor stay usable.
  const retried = await call(app, "POST", "/v1/auth/refresh", { body: { refreshToken } });
  assert.equal(retried.status, 401);
  assert.equal(payload(retried).error.code, "refresh_retried");
  assert.equal([...store.sessions.values()][0]!.revokedAt, null);

  const successor = payload(rotated).refreshToken as string;
  const next = await call(app, "POST", "/v1/auth/refresh", { body: { refreshToken: successor } });
  assert.equal(next.status, 200);
});

test("one of two concurrent refreshes wins; the loser neither revokes nor rotates", async () => {
  const store = new MemoryStore();
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  const { refreshToken } = await signInUser(app);

  const results = await Promise.all([
    call(app, "POST", "/v1/auth/refresh", { body: { refreshToken } }),
    call(app, "POST", "/v1/auth/refresh", { body: { refreshToken } }),
  ]);
  const winner = results.find((result) => result.status === 200);
  const loser = results.find((result) => result.status !== 200);
  assert.ok(winner);
  assert.ok(loser);
  assert.equal(payload(loser).error.code, "refresh_retried");
  assert.equal([...store.sessions.values()][0]!.revokedAt, null);

  // The winner's pair keeps working; the loser never installed a second one.
  const successor = payload(winner).refreshToken as string;
  const next = await call(app, "POST", "/v1/auth/refresh", { body: { refreshToken: successor } });
  assert.equal(next.status, 200);
});

test("admin console uses password login, and writes need the operator role", async () => {
  const store = new MemoryStore();
  await seedAdmin(store, "viewer", 0);
  await seedAdmin(store, "operator", 1);
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  const { accessToken } = await signInUser(app);

  const anonymous = await call(app, "GET", "/v1/admin/users");
  assert.equal(anonymous.status, 401);

  const viewerCookie = await adminLogin(app, "viewer");
  const users = await call(app, "GET", "/v1/admin/users", { headers: { cookie: viewerCookie } });
  assert.equal(users.status, 200);
  assert.equal(payload(users).total, 1);
  assert.equal(payload(users).items[0].balance, 500_000);
  assert.equal(payload(users).items[0].openidTail, "enid-1");

  const denied = await call(app, "POST", "/v1/admin/users/1/credits/adjust", { headers: { cookie: viewerCookie }, body: { deltaCredits: 10, reason: "补偿" } });
  assert.equal(denied.status, 403);

  const operatorCookie = await adminLogin(app, "operator");
  const adjusted = await call(app, "POST", "/v1/admin/users/1/credits/adjust", { headers: { cookie: operatorCookie }, body: { deltaCredits: 10, reason: "补偿" } });
  assert.equal(adjusted.status, 200);
  assert.equal(payload(adjusted).balanceCredits, 510);

  const me = await call(app, "GET", "/v1/me", { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(payload(me).credit.balanceCredits, 510);

  const audit = await call(app, "GET", "/v1/admin/audit", { headers: { cookie: operatorCookie } });
  assert.equal(payload(audit).items[0].action, "CREDIT_ADJUST");
  assert.equal(payload(audit).items[0].adminUsername, "operator");
});

test("freezing an account stops both its access token and its refreshes", async () => {
  const store = new MemoryStore();
  await seedAdmin(store, "operator", 1);
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  const { accessToken, refreshToken } = await signInUser(app);
  const cookie = await adminLogin(app, "operator");

  const frozen = await call(app, "POST", "/v1/admin/users/1/status", { headers: { cookie }, body: { status: 2 } });
  assert.equal(frozen.status, 200);
  assert.equal(payload(frozen).user.status, 2);

  const me = await call(app, "GET", "/v1/me", { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(me.status, 403);
  const refreshed = await call(app, "POST", "/v1/auth/refresh", { body: { refreshToken } });
  assert.equal(refreshed.status, 403);
});

test("forcing a session offline invalidates that user's access token only", async () => {
  const store = new MemoryStore();
  await seedAdmin(store, "operator", 1);
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  const first = await signInUser(app);
  const second = await signInUser(app);
  const cookie = await adminLogin(app, "operator");

  const sessionId = [...store.sessions.values()][0]!.id;
  const revoked = await call(app, "POST", `/v1/admin/users/1/sessions/${sessionId}/revoke`, { headers: { cookie } });
  assert.equal(revoked.status, 200);

  const tokens = [first.accessToken, second.accessToken];
  const statuses = await Promise.all(tokens.map((token) => call(app, "GET", "/v1/me", { headers: { authorization: `Bearer ${token}` } })));
  assert.deepEqual(statuses.map((response) => response.status).sort(), [200, 401]);
});

test("a wrong admin password never creates a session", async () => {
  const store = new MemoryStore();
  await seedAdmin(store, "operator", 1);
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  const response = await call(app, "POST", "/v1/admin/auth/login", { body: { username: "operator", password: randomUUID() } });
  assert.equal(response.status, 401);
  assert.equal(payload(response).error.code, "invalid_credentials");
  assert.equal(response.headers["set-cookie"], undefined);
});

function serviceCall(app: (request: HttpRequest) => Promise<HttpResponse>, target: string, body: unknown, token = SERVICE_TOKEN): Promise<HttpResponse> {
  return call(app, "POST", target, { body, headers: { authorization: `Bearer ${token}` } });
}

function holdBody(requestId: string, model = "deepseek-v4-flash", estimatedInputChars = 1000, maxOutputTokens = 1000): Record<string, unknown> {
  return { userId: 1, requestId, model, estimatedInputChars, maxOutputTokens };
}

test("a hold freezes credits and settle refunds the part the call did not use", async () => {
  const store = new MemoryStore();
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  const { accessToken } = await signInUser(app);
  const requestId = randomUUID();

  const held = await serviceCall(app, "/internal/billing/hold", holdBody(requestId));
  assert.equal(held.status, 200);
  const hold = payload(held);
  assert.equal(hold.holdAmount, 69);
  assert.equal(hold.holdCredits, 0.069);
  assert.equal(hold.balance, 499_931);
  assert.equal(hold.frozen, 69);

  const settled = await serviceCall(app, "/internal/billing/settle", {
    userId: 1, requestId, model: "deepseek-v4-flash", inputTokens: 800, cachedTokens: 200, outputTokens: 500,
  });
  assert.equal(settled.status, 200);
  const settle = payload(settled);
  assert.equal(settle.status, "settled");
  assert.equal(settle.charged, 41);
  assert.equal(settle.chargedCredits, 0.041);
  assert.equal(settle.balance, 499_959);
  assert.equal(settle.frozen, 0);

  const ledger = await call(app, "GET", "/v1/credits/ledger", { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(payload(ledger).items[0].bizType, "LLM_USAGE");
  assert.equal(payload(ledger).items[0].bizId, requestId);
  assert.equal(payload(ledger).items[0].delta, -41);
});

test("two calls in flight keep the ledger's running balance", async () => {
  const store = new MemoryStore();
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  const { accessToken } = await signInUser(app);
  const first = randomUUID();
  const second = randomUUID();

  // Both holds are taken before either settles, so the first settle sees a
  // balance the second hold has already dipped into. The row must still
  // continue the ledger, or the account page's additive check breaks.
  assert.equal((await serviceCall(app, "/internal/billing/hold", holdBody(first))).status, 200);
  assert.equal((await serviceCall(app, "/internal/billing/hold", holdBody(second))).status, 200);
  for (const requestId of [second, first]) {
    const settled = await serviceCall(app, "/internal/billing/settle", {
      userId: 1, requestId, model: "deepseek-v4-flash", inputTokens: 800, cachedTokens: 200, outputTokens: 500,
    });
    assert.equal(settled.status, 200);
  }

  const rows = store.ledger.filter((row) => row.userId === 1);
  const history = await call(app, "GET", "/v1/credits/ledger", { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(payload(history).items.length, rows.length);
  for (let index = 1; index < rows.length; index += 1) {
    assert.equal(rows[index - 1]!.balanceAfter + rows[index]!.delta, rows[index]!.balanceAfter,
      `row ${index} does not continue row ${index - 1}`);
  }
});

test("a grant made while a hold is open keeps the ledger additive", async () => {
  const store = new MemoryStore();
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  await signInUser(app);
  const requestId = randomUUID();

  assert.equal((await serviceCall(app, "/internal/billing/hold", holdBody(requestId))).status, 200);
  // The hold has already dipped into the spendable balance; the grant's row
  // must still continue the ledger, or the pair below stops adding up.
  const adjusted = await store.adjustCredits({ userId: 1, deltaMilli: 100_000, remark: "补偿", adminId: 1 });
  assert.equal(adjusted?.ledger.balanceAfter, 600_000, "the grant continues the ledger, not the spendable balance");

  assert.equal((await serviceCall(app, "/internal/billing/settle", {
    userId: 1, requestId, model: "deepseek-v4-flash", inputTokens: 800, cachedTokens: 200, outputTokens: 500,
  })).status, 200);

  const rows = store.ledger.filter((row) => row.userId === 1);
  for (let index = 1; index < rows.length; index += 1) {
    assert.equal(rows[index - 1]!.balanceAfter + rows[index]!.delta, rows[index]!.balanceAfter,
      `row ${index} does not continue row ${index - 1}`);
  }
  assert.equal(rows.at(-1)!.balanceAfter, store.credits.get(1)!.balance,
    "once no hold is open the ledger and the spendable balance agree");
});

test("a saved nickname survives the next sign-in", async () => {
  const store = new MemoryStore();
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  const first = await signInUser(app);
  assert.equal((await call(app, "PATCH", "/v1/me", { headers: { authorization: `Bearer ${first.accessToken}` }, body: { displayName: "研究者" } })).status, 200);

  const second = await signInUser(app);
  const me = await call(app, "GET", "/v1/me", { headers: { authorization: `Bearer ${second.accessToken}` } });
  assert.equal(payload(me).user.displayName, "研究者");
});

test("a request id holds and settles once, so a retried callback cannot double charge", async () => {
  const store = new MemoryStore();
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  await signInUser(app);
  const requestId = randomUUID();

  assert.equal((await serviceCall(app, "/internal/billing/hold", holdBody(requestId))).status, 200);
  const replay = await serviceCall(app, "/internal/billing/hold", holdBody(requestId));
  assert.equal(replay.status, 200);
  assert.equal(payload(replay).holdAmount, 69);
  assert.equal(payload(replay).balance, 499_931);
  assert.equal(payload(replay).frozen, 69);

  const settle = { userId: 1, requestId, model: "deepseek-v4-flash", inputTokens: 800, cachedTokens: 200, outputTokens: 500 };
  assert.equal((await serviceCall(app, "/internal/billing/settle", settle)).status, 200);
  const again = await serviceCall(app, "/internal/billing/settle", settle);
  assert.equal(again.status, 200);
  assert.equal(payload(again).status, "already_settled");
  assert.equal(payload(again).charged, 41);
  assert.equal(payload(again).balance, 499_959);
  assert.equal(store.ledger.filter((row) => row.bizId === requestId).length, 1);
});

test("a balance that cannot cover the hold is refused before the model is called", async () => {
  const store = new MemoryStore();
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  await signInUser(app);

  // The largest allowed context on the most expensive model costs 264 credits,
  // so the balance has to be squeezed down to make the hold unaffordable.
  store.credits.get(1)!.balance = 200_000;
  const tooBig = await serviceCall(app, "/internal/billing/hold", holdBody(randomUUID(), "deepseek-v4-pro", 2_000_000, 131_072));
  assert.equal(tooBig.status, 402);
  const refusal = payload(tooBig);
  assert.equal(refusal.error.code, "CREDIT_INSUFFICIENT");
  assert.equal(refusal.error.balance, 200_000);
  assert.ok(refusal.error.need > refusal.error.balance);
  assert.equal(store.holds.size, 0);
  assert.equal(store.credits.get(1)!.frozen, 0);
});

test("release gives the frozen credits back, and the two paths cannot cross", async () => {
  const store = new MemoryStore();
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  await signInUser(app);
  const requestId = randomUUID();

  await serviceCall(app, "/internal/billing/hold", holdBody(requestId));
  const released = await serviceCall(app, "/internal/billing/release", { userId: 1, requestId });
  assert.equal(released.status, 200);
  assert.equal(payload(released).status, "released");
  assert.equal(payload(released).released, 69);
  assert.equal(payload(released).balance, 500_000);
  assert.equal(payload(released).frozen, 0);

  const settle = await serviceCall(app, "/internal/billing/settle", {
    userId: 1, requestId, model: "deepseek-v4-flash", inputTokens: 10, outputTokens: 10,
  });
  assert.equal(settle.status, 409);
  assert.equal(payload(settle).error.code, "hold_released");

  const again = await serviceCall(app, "/internal/billing/release", { userId: 1, requestId });
  assert.equal(again.status, 200);
  assert.equal(payload(again).status, "already_released");
  assert.equal(payload(again).balance, 500_000);

  const settledRequest = randomUUID();
  await serviceCall(app, "/internal/billing/hold", holdBody(settledRequest));
  await serviceCall(app, "/internal/billing/settle", {
    userId: 1, requestId: settledRequest, model: "deepseek-v4-flash", inputTokens: 10, outputTokens: 10,
  });
  const late = await serviceCall(app, "/internal/billing/release", { userId: 1, requestId: settledRequest });
  assert.equal(late.status, 409);
  assert.equal(payload(late).error.code, "hold_settled");
});

test("the billing routes only answer to the service token, and only when one is configured", async () => {
  const store = new MemoryStore();
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  await signInUser(app);
  const body = holdBody(randomUUID());

  const anonymous = await call(app, "POST", "/internal/billing/hold", { body });
  assert.equal(anonymous.status, 401);
  assert.equal(payload(anonymous).error.code, "invalid_service_token");

  const wrong = await serviceCall(app, "/internal/billing/hold", body, "not-the-token");
  assert.equal(wrong.status, 401);
  assert.equal(payload(wrong).error.code, "invalid_service_token");

  const unknown = await serviceCall(app, "/internal/billing/hold", holdBody(randomUUID(), "no-such-model"));
  assert.equal(unknown.status, 400);
  assert.equal(payload(unknown).error.code, "unknown_model");

  const disabled = createApp({ config: config({ billingToken: "" }), store, now: () => NOW, fetchImpl: fakeHuawei("openid-1") });
  const refused = await call(disabled, "POST", "/internal/billing/hold", { body });
  assert.equal(refused.status, 503);
  assert.equal(payload(refused).error.code, "billing_disabled");
});

interface GatewayCall {
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/** Routes Huawei OAuth to the usual fake and records every model-gateway call. */
function fakeGateway(reply: () => Response): { fetchImpl: typeof fetch; calls: GatewayCall[] } {
  const huawei = fakeHuawei("openid-1");
  const calls: GatewayCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://gateway.test")) return huawei(input, init);
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ url, authorization: headers?.authorization, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return reply();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function readStream(response: HttpResponse): Promise<string> {
  assert.ok(response.stream, "response has no stream");
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of response.stream) text += decoder.decode(chunk);
  return text;
}

const CHAT = { model: "deepseek-v4-flash", messages: [{ role: "user", content: "你好" }], max_tokens: 100 };

test("the proxy settles a plain reply on the usage the gateway reported", async () => {
  const store = new MemoryStore();
  const gateway = fakeGateway(() => new Response(JSON.stringify({
    id: "cmpl-1",
    choices: [{ message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: gateway.fetchImpl });
  const { accessToken } = await signInUser(app);

  const reply = await call(app, "POST", "/v1/chat/completions", { body: CHAT, headers: { authorization: `Bearer ${accessToken}`, "x-request-id": "11111111-1111-4111-8111-111111111111" } });
  assert.equal(reply.status, 200);
  assert.equal(payload(reply).usage.completion_tokens, 50);

  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0]!.url, "https://gateway.test/v1/chat/completions");
  assert.equal(gateway.calls[0]!.authorization, "Bearer internal-key");

  // 100 input + 50 output at 25/50 milli per 1k is 5 milli, i.e. 0.005 credits.
  const credit = store.credits.get(1)!;
  assert.equal(credit.frozen, 0);
  assert.equal(credit.balance, 499_995);
  assert.equal(store.ledger.at(-1)!.bizType, "LLM_USAGE");
  assert.equal(store.ledger.at(-1)!.delta, -5);
});

test("a streamed reply passes through chunk by chunk and still settles", async () => {
  const store = new MemoryStore();
  const gateway = fakeGateway(() => sseResponse([
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8,"total_tokens":128}}\n\n',
    "data: [DONE]\n\n",
  ]));
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: gateway.fetchImpl });
  const { accessToken } = await signInUser(app);

  const reply = await call(app, "POST", "/v1/chat/completions", { body: { ...CHAT, stream: true }, headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(reply.status, 200);
  const text = await readStream(reply);
  assert.match(text, /"content":"你"/u);
  assert.match(text, /data: \[DONE\]/u);

  // The gateway must be asked for usage, otherwise the hold can only be refunded.
  assert.equal(gateway.calls[0]!.body.stream, true);
  assert.deepEqual(gateway.calls[0]!.body.stream_options, { include_usage: true });

  const credit = store.credits.get(1)!;
  assert.equal(credit.frozen, 0);
  assert.equal(credit.balance, 499_996);
  assert.equal(store.ledger.at(-1)!.bizType, "LLM_USAGE");
});

test("the proxy refuses an empty balance before any gateway call", async () => {
  const store = new MemoryStore();
  const gateway = fakeGateway(() => new Response("{}", { status: 200 }));
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: gateway.fetchImpl });
  const { accessToken } = await signInUser(app);
  store.credits.get(1)!.balance = 0;

  const reply = await call(app, "POST", "/v1/chat/completions", { body: CHAT, headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(reply.status, 402);
  assert.equal(payload(reply).error.code, "CREDIT_INSUFFICIENT");
  assert.equal(gateway.calls.length, 0);
  assert.equal(store.holds.size, 0);
});

test("the proxy needs a session, a priced model and a configured gateway", async () => {
  const store = new MemoryStore();
  const gateway = fakeGateway(() => new Response("{}", { status: 200 }));
  const app = createApp({ config: config(), store, now: () => NOW, fetchImpl: gateway.fetchImpl });
  const { accessToken } = await signInUser(app);

  const anonymous = await call(app, "POST", "/v1/chat/completions", { body: CHAT });
  assert.equal(anonymous.status, 401);

  const unpriced = await call(app, "POST", "/v1/chat/completions", { body: { ...CHAT, model: "no-such-model" }, headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(unpriced.status, 400);
  assert.equal(payload(unpriced).error.code, "unknown_model");

  const disabled = createApp({ config: config({ litellmBaseUrl: "" }), store, now: () => NOW, fetchImpl: gateway.fetchImpl });
  const refused = await call(disabled, "POST", "/v1/chat/completions", { body: CHAT, headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(refused.status, 503);
  assert.equal(payload(refused).error.code, "llm_proxy_disabled");
  assert.equal(gateway.calls.length, 0);
});

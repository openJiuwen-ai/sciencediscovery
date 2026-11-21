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
 * The account service's data access.
 *
 * The interface is the contract the HTTP layer codes against, and the only
 * implementation that ships talks PostgreSQL. Keeping it explicit (rather than
 * spreading SQL through handlers) makes two rules easy to see and to test:
 * every balance change writes a ledger row in the same transaction, and every
 * admin write lands an audit row before the transaction commits.
 *
 * Money is stored in milli-credits: one displayed credit is 1000 units, so a
 * token-priced call never has to round.
 */

import { randomUUID } from "node:crypto";

import type { Queryable } from "./db.js";
import type { ModelPrice } from "./pricing.js";

/**
 * Daily rewards are counted in China time, so "每天" matches the calendar the
 * user sees even though timestamps are stored in UTC.
 */
const REWARD_TIMEZONE = "Asia/Shanghai";

export interface UserRow {
  id: number;
  openid: string;
  displayName: string | null;
  avatarUrl: string | null;
  email: string | null;
  /** 0 normal, 1 restricted, 2 frozen, 3 deleting. */
  status: number;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface CreditRow {
  userId: number;
  balance: number;
  frozen: number;
  totalEarned: number;
  totalSpent: number;
  updatedAt: string;
}

export interface SessionRow {
  id: string;
  userId: number;
  /** 1 Windows desktop, 2 Linux web. */
  platform: number;
  deviceLabel: string | null;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  /** The current refresh digest; a rotation compares against it (CAS). */
  refreshHash?: Buffer;
  /** When the previous digest was installed; the retry window starts here. */
  prevRotatedAt?: string | null;
}

export interface LedgerRow {
  id: number;
  userId: number;
  delta: number;
  balanceAfter: number;
  bizType: string;
  bizId: string;
  remark: string | null;
  createdAt: string;
}

export interface AdminRow {
  id: number;
  username: string;
  passwordHash: string;
  role: number;
  status: number;
  failedCount: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
}

export interface AdminSessionRow {
  id: string;
  adminId: number;
  username: string;
  role: number;
  expiresAt: string;
}

/** A pending HUAWEI authorization; the verifier never leaves the service. */
export interface AuthFlowRow {
  state: string;
  codeVerifier: string;
  returnUrl: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface UserListRow extends UserRow {
  balance: number;
  totalEarned: number;
  totalSpent: number;
  onlineSessions: number;
  lastSeenAt: string | null;
}

export interface UsageDayRow {
  day: string;
  requests: number;
  creditsUsed: number;
  inputTokens: number;
  outputTokens: number;
}

/** One model call, as the account owner may inspect it in their own usage page. */
export interface UsageRecordRow {
  id: number;
  requestId: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  creditsUsed: number;
  latencyMs: number | null;
  createdAt: string;
}

export interface OverviewRow {
  totalUsers: number;
  newUsersToday: number;
  activeToday: number;
  spentTodayMilli: number;
  onlineSessions: number;
  frozenUsers: number;
}

export interface AuditRow {
  id: number;
  adminId: number;
  adminUsername: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: unknown;
  ip: string | null;
  createdAt: string;
}

export interface SignInInput {
  openid: string;
  displayName?: string | undefined;
  avatarUrl?: string | undefined;
  email?: string | undefined;
  grantMilliCredits: number;
  /** Daily reward programme; omitted means sign-ins pay nothing extra. */
  dailyReward?: DailyRewardProgram | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/** The sign-in reward programme, in milli-credits so callers never round. */
export interface DailyRewardProgram {
  /** Paid on the first sign-in of each natural day, without a time window. */
  milliCredits: number;
  /** Number of accumulated check-ins between consecutive bonus grants. */
  cycleDays: number;
  /** Paid on every accumulated check-in milestone. */
  bonusMilliCredits: number;
}

export interface SignInResult {
  user: UserRow;
  credit: CreditRow;
  isNewUser: boolean;
  /** 1-based day since registration, for callers that care about tenure. */
  rewardDay: number;
  /** Everything this sign-in added to the balance, in milli-credits. */
  grantedMilli: number;
}

export interface SessionInput {
  userId: number;
  refreshHash: Buffer;
  platform: number;
  deviceLabel?: string | undefined;
  deviceId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
  expiresAt: Date;
}

export interface UserFilter {
  q?: string | undefined;
  status?: number | undefined;
  online?: boolean | undefined;
  onlineSince: Date;
  sort: "balance" | "spent" | "recent" | "id";
  order: "asc" | "desc";
  limit: number;
  offset: number;
}

export interface AuditInput {
  adminId: number;
  action: string;
  targetType?: string | undefined;
  targetId?: string | undefined;
  detail?: unknown;
  ip?: string | undefined;
}

export interface HoldInput {
  userId: number;
  requestId: string;
  holdMilli: number;
}

export interface HoldResult {
  /** `closed` means this request id was already settled or released. */
  status: "held" | "insufficient" | "no_account" | "closed";
  balance: number;
  frozen: number;
  holdAmount: number;
}

export interface SettleInput {
  userId: number;
  requestId: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** Milli-credits the call used, already priced by `pricing.ts`. */
  chargedMilli: number;
  channel: number;
  latencyMs?: number | undefined;
}

export interface SettleResult {
  status: "settled" | "already_settled" | "released" | "missing";
  balance: number;
  frozen: number;
  holdAmount: number;
  charged: number;
}

export interface ReleaseResult {
  status: "released" | "already_released" | "settled" | "missing";
  balance: number;
  frozen: number;
  holdAmount: number;
}

export interface AccountsStore {
  signIn(input: SignInInput): Promise<SignInResult>;
  getUser(userId: number): Promise<UserRow | undefined>;
  findUserByOpenid(openid: string): Promise<UserRow | undefined>;
  getCredit(userId: number): Promise<CreditRow | undefined>;
  updateProfile(userId: number, patch: { displayName?: string | undefined; email?: string | undefined }): Promise<UserRow | undefined>;
  listLedger(userId: number, beforeId: number | undefined, limit: number): Promise<LedgerRow[]>;

  createTicket(jti: string, openid: string, expiresAt: Date): Promise<void>;
  consumeTicket(jti: string, now: Date): Promise<string | undefined>;

  createAuthFlow(input: { state: string; codeVerifier: string; returnUrl: string; expiresAt: Date }): Promise<void>;
  consumeAuthFlow(state: string, now: Date): Promise<AuthFlowRow | undefined>;

  createSession(input: SessionInput): Promise<SessionRow>;
  findSessionByRefreshHash(hash: Buffer): Promise<SessionRow | undefined>;
  findSessionByPrevRefreshHash(hash: Buffer): Promise<SessionRow | undefined>;
  replaceSessionRefresh(sessionId: string, expectedHash: Buffer, nextHash: Buffer, now: Date): Promise<boolean>;
  getSession(sessionId: string): Promise<SessionRow | undefined>;
  touchSession(sessionId: string, now: Date): Promise<void>;
  revokeSession(sessionId: string, reason: string, now: Date): Promise<boolean>;
  listSessions(userId: number, limit: number): Promise<SessionRow[]>;
  countOnlineSessions(userId: number, since: Date): Promise<number>;

  recordLoginEvent(input: { userId?: number | undefined; sessionId?: string | undefined; event: string; result?: number; ip?: string | undefined; userAgent?: string | undefined }): Promise<void>;

  findAdmin(username: string): Promise<AdminRow | undefined>;
  findAdminById(adminId: number): Promise<AdminRow | undefined>;
  recordAdminFailure(adminId: number, lockedUntil: Date | undefined): Promise<number>;
  resetAdminFailures(adminId: number, loginAt: Date): Promise<void>;
  createAdminSession(input: { adminId: number; tokenHash: Buffer; ip?: string | undefined; expiresAt: Date }): Promise<string>;
  findAdminSession(tokenHash: Buffer): Promise<AdminSessionRow | undefined>;
  touchAdminSession(sessionId: string, now: Date): Promise<void>;
  revokeAdminSession(sessionId: string, now: Date): Promise<void>;

  overview(dayStart: Date, onlineSince: Date): Promise<OverviewRow>;
  listUsers(filter: UserFilter): Promise<{ rows: UserListRow[]; total: number }>;
  listUsageDaily(userId: number, since: Date): Promise<UsageDayRow[]>;
  listUsageRecent(userId: number, since: Date, limit: number): Promise<UsageRecordRow[]>;
  getModelPrice(model: string): Promise<ModelPrice | undefined>;
  holdCredits(input: HoldInput): Promise<HoldResult>;
  settleCredits(input: SettleInput): Promise<SettleResult>;
  releaseHold(input: { userId: number; requestId: string }): Promise<ReleaseResult>;
  adjustCredits(input: { userId: number; deltaMilli: number; remark: string; adminId: number; ip?: string | undefined }): Promise<{ balance: number; ledger: LedgerRow } | undefined>;
  setUserStatus(userId: number, status: number, audit: AuditInput): Promise<UserRow | undefined>;
  writeAudit(input: AuditInput): Promise<void>;
  listAudit(beforeId: number | undefined, limit: number): Promise<AuditRow[]>;
  listUserAudit(userId: number, limit: number): Promise<AuditRow[]>;
}

interface UserRaw {
  id: number;
  openid: string;
  display_name: string | null;
  avatar_url: string | null;
  email: string | null;
  status: number;
  created_at: Date;
  last_login_at: Date | null;
}

interface CreditRaw {
  user_id: number;
  balance: number;
  frozen: number;
  total_earned: number;
  total_spent: number;
  updated_at: Date;
}

interface SessionRaw {
  id: string;
  user_id: number;
  platform: number;
  device_label: string | null;
  device_id: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
  refresh_hash: Buffer;
  prev_refresh_hash: Buffer | null;
  prev_rotated_at: Date | null;
}

interface LedgerRaw {
  id: number;
  user_id: number;
  delta: number;
  balance_after: number;
  biz_type: string;
  biz_id: string;
  remark: string | null;
  created_at: Date;
}

export function toUser(raw: UserRaw): UserRow {
  return {
    id: raw.id,
    openid: raw.openid,
    displayName: raw.display_name,
    avatarUrl: raw.avatar_url,
    email: raw.email,
    status: raw.status,
    createdAt: raw.created_at.toISOString(),
    lastLoginAt: raw.last_login_at?.toISOString() ?? null,
  };
}

function toCredit(raw: CreditRaw): CreditRow {
  return {
    userId: raw.user_id,
    balance: raw.balance,
    frozen: raw.frozen,
    totalEarned: raw.total_earned,
    totalSpent: raw.total_spent,
    updatedAt: raw.updated_at.toISOString(),
  };
}

function toSession(raw: SessionRaw): SessionRow {
  return {
    id: raw.id,
    userId: raw.user_id,
    platform: raw.platform,
    deviceLabel: raw.device_label,
    deviceId: raw.device_id,
    ip: raw.ip,
    userAgent: raw.user_agent,
    createdAt: raw.created_at.toISOString(),
    lastSeenAt: raw.last_seen_at.toISOString(),
    expiresAt: raw.expires_at.toISOString(),
    revokedAt: raw.revoked_at?.toISOString() ?? null,
    revokedReason: raw.revoked_reason,
    refreshHash: raw.refresh_hash,
    prevRotatedAt: raw.prev_rotated_at?.toISOString() ?? null,
  };
}

function toLedger(raw: LedgerRaw): LedgerRow {
  return {
    id: raw.id,
    userId: raw.user_id,
    delta: raw.delta,
    balanceAfter: raw.balance_after,
    bizType: raw.biz_type,
    bizId: raw.biz_id,
    remark: raw.remark,
    createdAt: raw.created_at.toISOString(),
  };
}

async function insertAudit(db: Queryable, input: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO admin_audit (admin_id, action, target_type, target_id, detail, ip)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [input.adminId, input.action, input.targetType ?? null, input.targetId ?? null, input.detail === undefined ? null : JSON.stringify(input.detail), input.ip ?? null],
  );
}

/**
 * Rolls the hold transaction back when the balance cannot cover it, so the row
 * inserted a moment earlier disappears with the failed debit.
 */
class HoldAborted extends Error {
  constructor(readonly result: HoldResult) {
    super(result.status);
  }
}

export class PostgresStore implements AccountsStore {
  constructor(
    private readonly db: Queryable & { transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> },
  ) {}

  async signIn(input: SignInInput): Promise<SignInResult> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.query<UserRaw>(`SELECT * FROM users WHERE openid = $1`, [input.openid]);
      let user = existing[0];
      let isNewUser = false;
      if (!user) {
        const inserted = await tx.query<UserRaw>(
          `INSERT INTO users (openid, display_name, avatar_url, email)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (openid) DO NOTHING
           RETURNING *`,
          [input.openid, input.displayName ?? null, input.avatarUrl ?? null, input.email ?? null],
        );
        user = inserted[0];
        isNewUser = user !== undefined;
        if (!user) {
          const raced = await tx.query<UserRaw>(`SELECT * FROM users WHERE openid = $1`, [input.openid]);
          user = raced[0];
        }
      } else {
        await tx.query(
          `UPDATE users
              SET display_name = COALESCE($2, display_name),
                  avatar_url   = COALESCE($3, avatar_url),
                  email        = COALESCE($4, email)
            WHERE id = $1`,
          [user.id, input.displayName ?? null, input.avatarUrl ?? null, input.email ?? null],
        );
      }
      if (!user) throw new Error("user row vanished during sign-in");

      await tx.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
      await tx.query(`INSERT INTO credit_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [user.id]);

      let grantedMilli = 0;
      if (isNewUser && input.grantMilliCredits > 0) {
        // The ledger's (biz_type, biz_id) unique index is what makes the grant
        // exactly-once even if two callbacks race on the same brand-new user.
        const granted = await tx.query<{ id: number }>(
          `INSERT INTO credit_ledger (user_id, delta, balance_after, biz_type, biz_id, remark)
           VALUES ($1, $2, $2, 'REGISTER', $3, '注册赠送')
           ON CONFLICT (biz_type, biz_id) DO NOTHING
           RETURNING id`,
          [user.id, input.grantMilliCredits, String(user.id)],
        );
        if (granted.length > 0) {
          await tx.query(
            `UPDATE credit_accounts
                SET balance = balance + $2, total_earned = total_earned + $2, updated_at = now()
              WHERE user_id = $1`,
            [user.id, input.grantMilliCredits],
          );
          grantedMilli += input.grantMilliCredits;
        }
      }

      let rewardDay = 0;
      const program = input.dailyReward;
      if (program && program.milliCredits > 0) {
        // The daily reward has no end date. `day` is only the user's tenure and
        // is kept for callers; the idempotency key is the actual China calendar
        // date, so a missed day cannot be claimed by signing in later.
        const dayRows = await tx.query<{ day: number; date: string }>(
          `SELECT (((now() AT TIME ZONE $2::text)::date - (created_at AT TIME ZONE $2::text)::date) + 1)::int AS day,
                  to_char((now() AT TIME ZONE $2::text)::date, 'YYYY-MM-DD') AS date
             FROM users WHERE id = $1`,
          [user.id, REWARD_TIMEZONE],
        );
        const day = dayRows[0]?.day ?? 0;
        const checkinDate = dayRows[0]?.date ?? "";
        if (day >= 1 && checkinDate) {
          rewardDay = day;
          // One CHECKIN row per user per day: signing in twice cannot pay twice,
          // and a missed day simply has no row to claim later.
          const paid = await tx.query<{ id: number }>(
            `INSERT INTO credit_ledger (user_id, delta, balance_after, biz_type, biz_id, remark)
             VALUES ($1, $2, (SELECT balance FROM credit_accounts WHERE user_id = $1) + $2, 'CHECKIN', $3, $4)
             ON CONFLICT (biz_type, biz_id) DO NOTHING
             RETURNING id`,
            [user.id, program.milliCredits, `${user.id}:${checkinDate}`, `每日签到 · ${checkinDate}`],
          );
          if (paid.length > 0) {
            await tx.query(
              `UPDATE credit_accounts
                  SET balance = balance + $2, total_earned = total_earned + $2, updated_at = now()
                WHERE user_id = $1`,
              [user.id, program.milliCredits],
            );
            grantedMilli += program.milliCredits;

            if (program.bonusMilliCredits > 0 && program.cycleDays > 0) {
              const claimed = await tx.query<{ count: number }>(
                `SELECT count(*)::int AS count
                   FROM credit_ledger
                  WHERE user_id = $1
                    AND biz_type = 'CHECKIN'
                    AND biz_id ~ '^[0-9]+:[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
                [user.id],
              );
              const count = claimed[0]?.count ?? 0;
              const cycle = Math.floor(count / program.cycleDays);
              if (cycle >= 1) {
                const bonus = await tx.query<{ id: number }>(
                  `INSERT INTO credit_ledger (user_id, delta, balance_after, biz_type, biz_id, remark)
                   VALUES ($1, $2, (SELECT balance FROM credit_accounts WHERE user_id = $1) + $2, 'BONUS', $3, $4)
                   ON CONFLICT (biz_type, biz_id) DO NOTHING
                   RETURNING id`,
                  [user.id, program.bonusMilliCredits, `${user.id}:cycle-${cycle}`, `累计签到 ${cycle * program.cycleDays} 天奖励`],
                );
                if (bonus.length > 0) {
                  await tx.query(
                    `UPDATE credit_accounts
                        SET balance = balance + $2, total_earned = total_earned + $2, updated_at = now()
                      WHERE user_id = $1`,
                    [user.id, program.bonusMilliCredits],
                  );
                  grantedMilli += program.bonusMilliCredits;
                }
              }
            }
          }
        }
      }

      await tx.query(
        `INSERT INTO login_events (user_id, event, result, ip, user_agent) VALUES ($1, 'SIGN_IN', 0, $2, $3)`,
        [user.id, input.ip ?? null, input.userAgent ?? null],
      );

      const refreshed = await tx.query<UserRaw>(`SELECT * FROM users WHERE id = $1`, [user.id]);
      const credit = await tx.query<CreditRaw>(`SELECT * FROM credit_accounts WHERE user_id = $1`, [user.id]);
      return { user: toUser(refreshed[0]!), credit: toCredit(credit[0]!), isNewUser, rewardDay, grantedMilli };
    });
  }

  async getUser(userId: number): Promise<UserRow | undefined> {
    const rows = await this.db.query<UserRaw>(`SELECT * FROM users WHERE id = $1`, [userId]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  async findUserByOpenid(openid: string): Promise<UserRow | undefined> {
    const rows = await this.db.query<UserRaw>(`SELECT * FROM users WHERE openid = $1`, [openid]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  async getCredit(userId: number): Promise<CreditRow | undefined> {
    const rows = await this.db.query<CreditRaw>(`SELECT * FROM credit_accounts WHERE user_id = $1`, [userId]);
    return rows[0] ? toCredit(rows[0]) : undefined;
  }

  async updateProfile(userId: number, patch: { displayName?: string | undefined; email?: string | undefined }): Promise<UserRow | undefined> {
    const rows = await this.db.query<UserRaw>(
      `UPDATE users SET display_name = COALESCE($2, display_name), email = COALESCE($3, email) WHERE id = $1 RETURNING *`,
      [userId, patch.displayName ?? null, patch.email ?? null],
    );
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  async listLedger(userId: number, beforeId: number | undefined, limit: number): Promise<LedgerRow[]> {
    const rows = await this.db.query<LedgerRaw>(
      `SELECT * FROM credit_ledger WHERE user_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint) ORDER BY id DESC LIMIT $3`,
      [userId, beforeId ?? null, limit],
    );
    return rows.map(toLedger);
  }

  async createTicket(jti: string, openid: string, expiresAt: Date): Promise<void> {
    await this.db.query(`INSERT INTO auth_tickets (jti, openid, expires_at) VALUES ($1, $2, $3)`, [jti, openid, expiresAt]);
  }

  async consumeTicket(jti: string, now: Date): Promise<string | undefined> {
    const rows = await this.db.query<{ openid: string }>(
      `UPDATE auth_tickets SET used_at = $2 WHERE jti = $1 AND used_at IS NULL AND expires_at > $2 RETURNING openid`,
      [jti, now],
    );
    return rows[0]?.openid;
  }

  async createAuthFlow(input: { state: string; codeVerifier: string; returnUrl: string; expiresAt: Date }): Promise<void> {
    await this.db.query(
      `INSERT INTO auth_flows (state, code_verifier, return_url, expires_at) VALUES ($1, $2, $3, $4)`,
      [input.state, input.codeVerifier, input.returnUrl, input.expiresAt],
    );
  }

  async consumeAuthFlow(state: string, now: Date): Promise<AuthFlowRow | undefined> {
    const rows = await this.db.query<{ state: string; code_verifier: string; return_url: string; expires_at: Date; used_at: Date | null }>(
      `UPDATE auth_flows SET used_at = $2 WHERE state = $1 AND used_at IS NULL AND expires_at > $2 RETURNING *`,
      [state, now],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      state: row.state,
      codeVerifier: row.code_verifier,
      returnUrl: row.return_url,
      expiresAt: row.expires_at.toISOString(),
      usedAt: row.used_at?.toISOString() ?? null,
    };
  }

  async createSession(input: SessionInput): Promise<SessionRow> {
    const rows = await this.db.query<SessionRaw>(
      `INSERT INTO sessions (id, user_id, refresh_hash, platform, device_label, device_id, ip, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [randomUUID(), input.userId, input.refreshHash, input.platform, input.deviceLabel ?? null, input.deviceId ?? null, input.ip ?? null, input.userAgent ?? null, input.expiresAt],
    );
    return toSession(rows[0]!);
  }

  async findSessionByRefreshHash(hash: Buffer): Promise<SessionRow | undefined> {
    const rows = await this.db.query<SessionRaw>(`SELECT * FROM sessions WHERE refresh_hash = $1`, [hash]);
    return rows[0] ? toSession(rows[0]) : undefined;
  }

  async findSessionByPrevRefreshHash(hash: Buffer): Promise<SessionRow | undefined> {
    const rows = await this.db.query<SessionRaw>(`SELECT * FROM sessions WHERE prev_refresh_hash = $1`, [hash]);
    return rows[0] ? toSession(rows[0]) : undefined;
  }

  /** Compare-and-swap: two callers holding the same token cannot both rotate,
   *  so the loser re-reads instead of pushing the winner's token into `prev`. */
  async replaceSessionRefresh(sessionId: string, expectedHash: Buffer, nextHash: Buffer, now: Date): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE sessions
          SET prev_refresh_hash = refresh_hash, prev_rotated_at = $3,
              refresh_hash = $2, last_seen_at = $3
        WHERE id = $1 AND refresh_hash = $4 AND revoked_at IS NULL
        RETURNING id`,
      [sessionId, nextHash, now, expectedHash],
    );
    return rows.length > 0;
  }

  async getSession(sessionId: string): Promise<SessionRow | undefined> {
    const rows = await this.db.query<SessionRaw>(`SELECT * FROM sessions WHERE id = $1`, [sessionId]);
    return rows[0] ? toSession(rows[0]) : undefined;
  }

  async touchSession(sessionId: string, now: Date): Promise<void> {
    await this.db.query(`UPDATE sessions SET last_seen_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [sessionId, now]);
  }

  async revokeSession(sessionId: string, reason: string, now: Date): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE sessions SET revoked_at = $2, revoked_reason = $3 WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
      [sessionId, now, reason],
    );
    return rows.length > 0;
  }

  async listSessions(userId: number, limit: number): Promise<SessionRow[]> {
    const rows = await this.db.query<SessionRaw>(`SELECT * FROM sessions WHERE user_id = $1 ORDER BY last_seen_at DESC LIMIT $2`, [userId, limit]);
    return rows.map(toSession);
  }

  async countOnlineSessions(userId: number, since: Date): Promise<number> {
    const rows = await this.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND last_seen_at >= $2`,
      [userId, since],
    );
    return rows[0]?.count ?? 0;
  }

  async recordLoginEvent(input: { userId?: number | undefined; sessionId?: string | undefined; event: string; result?: number; ip?: string | undefined; userAgent?: string | undefined }): Promise<void> {
    await this.db.query(
      `INSERT INTO login_events (user_id, session_id, event, result, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.userId ?? null, input.sessionId ?? null, input.event, input.result ?? 0, input.ip ?? null, input.userAgent ?? null],
    );
  }

  async findAdmin(username: string): Promise<AdminRow | undefined> {
    const rows = await this.db.query<{
      id: number; username: string; password_hash: string; role: number; status: number;
      failed_count: number; locked_until: Date | null; last_login_at: Date | null;
    }>(`SELECT * FROM admin_users WHERE username = $1`, [username]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
      status: row.status,
      failedCount: row.failed_count,
      lockedUntil: row.locked_until?.toISOString() ?? null,
      lastLoginAt: row.last_login_at?.toISOString() ?? null,
    };
  }

  async findAdminById(adminId: number): Promise<AdminRow | undefined> {
    const rows = await this.db.query<{
      id: number; username: string; password_hash: string; role: number; status: number;
      failed_count: number; locked_until: Date | null; last_login_at: Date | null;
    }>(`SELECT * FROM admin_users WHERE id = $1`, [adminId]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
      status: row.status,
      failedCount: row.failed_count,
      lockedUntil: row.locked_until?.toISOString() ?? null,
      lastLoginAt: row.last_login_at?.toISOString() ?? null,
    };
  }

  async recordAdminFailure(adminId: number, lockedUntil: Date | undefined): Promise<number> {
    const rows = await this.db.query<{ failed_count: number }>(
      `UPDATE admin_users SET failed_count = failed_count + 1, locked_until = $2 WHERE id = $1 RETURNING failed_count`,
      [adminId, lockedUntil ?? null],
    );
    return rows[0]?.failed_count ?? 0;
  }

  async resetAdminFailures(adminId: number, loginAt: Date): Promise<void> {
    await this.db.query(`UPDATE admin_users SET failed_count = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1`, [adminId, loginAt]);
  }

  async createAdminSession(input: { adminId: number; tokenHash: Buffer; ip?: string | undefined; expiresAt: Date }): Promise<string> {
    const id = randomUUID();
    await this.db.query(`INSERT INTO admin_sessions (id, admin_id, token_hash, ip, expires_at) VALUES ($1, $2, $3, $4, $5)`, [id, input.adminId, input.tokenHash, input.ip ?? null, input.expiresAt]);
    return id;
  }

  async findAdminSession(tokenHash: Buffer): Promise<AdminSessionRow | undefined> {
    const rows = await this.db.query<{ id: string; admin_id: number; username: string; role: number; expires_at: Date }>(
      `SELECT s.id, s.admin_id, s.expires_at, a.username, a.role
         FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.status = 0`,
      [tokenHash],
    );
    const row = rows[0];
    return row ? { id: row.id, adminId: row.admin_id, username: row.username, role: row.role, expiresAt: row.expires_at.toISOString() } : undefined;
  }

  async touchAdminSession(sessionId: string, now: Date): Promise<void> {
    await this.db.query(`UPDATE admin_sessions SET last_seen_at = $2 WHERE id = $1`, [sessionId, now]);
  }

  async revokeAdminSession(sessionId: string, now: Date): Promise<void> {
    await this.db.query(`UPDATE admin_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [sessionId, now]);
  }

  async overview(dayStart: Date, onlineSince: Date): Promise<OverviewRow> {
    const rows = await this.db.query<{
      total_users: number; new_users_today: number; active_today: number; spent_today: number; online_sessions: number; frozen_users: number;
    }>(
      `SELECT
         (SELECT count(*) FROM users)::int AS total_users,
         (SELECT count(*) FROM users WHERE created_at >= $1)::int AS new_users_today,
         (SELECT count(DISTINCT user_id) FROM sessions WHERE last_seen_at >= $1 AND revoked_at IS NULL)::int AS active_today,
         (SELECT COALESCE(-sum(delta), 0) FROM credit_ledger WHERE delta < 0 AND created_at >= $1)::bigint AS spent_today,
         (SELECT count(*) FROM sessions WHERE revoked_at IS NULL AND last_seen_at >= $2)::int AS online_sessions,
         (SELECT count(*) FROM users WHERE status = 2)::int AS frozen_users`,
      [dayStart, onlineSince],
    );
    const row = rows[0]!;
    return {
      totalUsers: row.total_users,
      newUsersToday: row.new_users_today,
      activeToday: row.active_today,
      spentTodayMilli: row.spent_today,
      onlineSessions: row.online_sessions,
      frozenUsers: row.frozen_users,
    };
  }

  async listUsers(filter: UserFilter): Promise<{ rows: UserListRow[]; total: number }> {
    // 占位符起始位置随查询不同：统计查询从 $1 开始，列表查询保留 $1 给 onlineSince。
    // 这样不会把未被引用的参数传给 PostgreSQL（否则报 bind message supplies N parameters）。
    const buildWhere = (startIndex: number): { where: string; values: unknown[] } => {
      const clauses: string[] = [];
      const whereValues: unknown[] = [];
      let index = startIndex;
      if (filter.q) {
        const placeholder = `$${index}`;
        whereValues.push(`%${filter.q}%`);
        clauses.push(`(u.display_name ILIKE ${placeholder} OR u.openid ILIKE ${placeholder} OR u.email ILIKE ${placeholder})`);
        index += 1;
      }
      if (filter.status !== undefined) {
        whereValues.push(filter.status);
        clauses.push(`u.status = $${index}`);
      }
      if (filter.online === true) {
        clauses.push(`EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.last_seen_at >= $1)`);
      } else if (filter.online === false) {
        clauses.push(`NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.last_seen_at >= $1)`);
      }
      return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", values: whereValues };
    };
    const orderColumn = filter.sort === "balance" ? "c.balance" : filter.sort === "spent" ? "c.total_spent" : filter.sort === "recent" ? "u.last_login_at" : "u.id";
    const direction = filter.order === "asc" ? "ASC" : "DESC";

    const countWhere = buildWhere(filter.online === undefined ? 1 : 2);
    const countValues = filter.online === undefined ? countWhere.values : [filter.onlineSince, ...countWhere.values];
    const totalRows = await this.db.query<{ count: number }>(`SELECT count(*)::int AS count FROM users u ${countWhere.where}`, countValues);

    const rowWhere = buildWhere(2);
    const values: unknown[] = [filter.onlineSince, ...rowWhere.values, filter.limit, filter.offset];
    const where = rowWhere.where;
    const rows = await this.db.query<UserRaw & { balance: number; total_earned: number; total_spent: number; online_sessions: number; last_seen_at: Date | null }>(
      `SELECT u.*,
              COALESCE(c.balance, 0) AS balance,
              COALESCE(c.total_earned, 0) AS total_earned,
              COALESCE(c.total_spent, 0) AS total_spent,
              (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.last_seen_at >= $1)::int AS online_sessions,
              (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
         FROM users u LEFT JOIN credit_accounts c ON c.user_id = u.id
         ${where}
        ORDER BY ${orderColumn} ${direction} NULLS LAST, u.id ${direction}
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return {
      total: totalRows[0]?.count ?? 0,
      rows: rows.map((row) => ({
        ...toUser(row),
        balance: row.balance,
        totalEarned: row.total_earned,
        totalSpent: row.total_spent,
        onlineSessions: row.online_sessions,
        lastSeenAt: row.last_seen_at?.toISOString() ?? null,
      })),
    };
  }

  async listUsageDaily(userId: number, since: Date): Promise<UsageDayRow[]> {
    const rows = await this.db.query<{ day: string; requests: number; credits_used: number; input_tokens: number; output_tokens: number }>(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
              count(*)::int AS requests,
              COALESCE(sum(credits_used), 0)::bigint AS credits_used,
              COALESCE(sum(input_tokens), 0)::bigint AS input_tokens,
              COALESCE(sum(output_tokens), 0)::bigint AS output_tokens
         FROM llm_usage
        WHERE user_id = $1 AND created_at >= $2
        GROUP BY 1 ORDER BY 1`,
      [userId, since],
    );
    return rows.map((row) => ({ day: row.day, requests: row.requests, creditsUsed: row.credits_used, inputTokens: row.input_tokens, outputTokens: row.output_tokens }));
  }

  async listUsageRecent(userId: number, since: Date, limit: number): Promise<UsageRecordRow[]> {
    const rows = await this.db.query<{
      id: number; request_id: string; model: string; input_tokens: number | null; cached_tokens: number | null;
      output_tokens: number | null; credits_used: number | null; latency_ms: number | null; created_at: Date;
    }>(
      `SELECT id, request_id, model, input_tokens, cached_tokens, output_tokens, credits_used, latency_ms, created_at
         FROM llm_usage
        WHERE user_id = $1 AND created_at >= $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [userId, since, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      requestId: row.request_id,
      model: row.model,
      inputTokens: row.input_tokens ?? 0,
      cachedTokens: row.cached_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      creditsUsed: row.credits_used ?? 0,
      latencyMs: row.latency_ms,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async adjustCredits(input: { userId: number; deltaMilli: number; remark: string; adminId: number; ip?: string | undefined }): Promise<{ balance: number; ledger: LedgerRow } | undefined> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query<{ balance: number }>(`SELECT balance FROM credit_accounts WHERE user_id = $1 FOR UPDATE`, [input.userId]);
      if (!current[0]) return undefined;
      const balanceAfter = current[0].balance + input.deltaMilli;
      if (balanceAfter < 0) return undefined;

      const inserted = await tx.query<LedgerRaw>(
        `INSERT INTO credit_ledger (user_id, delta, balance_after, biz_type, biz_id, remark)
         VALUES ($1, $2, $3, 'ADMIN', $4, $5) RETURNING *`,
        [input.userId, input.deltaMilli, balanceAfter, randomUUID(), input.remark],
      );
      await tx.query(
        `UPDATE credit_accounts
            SET balance = $2,
                total_earned = total_earned + GREATEST($3::bigint, 0),
                total_spent  = total_spent  + GREATEST(-$3::bigint, 0),
                updated_at = now()
          WHERE user_id = $1`,
        [input.userId, balanceAfter, input.deltaMilli],
      );
      await insertAudit(tx, {
        adminId: input.adminId,
        action: "CREDIT_ADJUST",
        targetType: "user",
        targetId: String(input.userId),
        detail: { delta: input.deltaMilli, balanceBefore: current[0].balance, balanceAfter, remark: input.remark },
        ip: input.ip,
      });
      return { balance: balanceAfter, ledger: toLedger(inserted[0]!) };
    });
  }

  async getModelPrice(model: string): Promise<ModelPrice | undefined> {
    const rows = await this.db.query<{ model: string; input_milli_per_1k: number; cached_input_milli_per_1k: number; output_milli_per_1k: number }>(
      `SELECT model, input_milli_per_1k, cached_input_milli_per_1k, output_milli_per_1k
         FROM model_prices WHERE model = $1 AND enabled`,
      [model],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      model: row.model,
      inputMilliPer1k: row.input_milli_per_1k,
      cachedInputMilliPer1k: row.cached_input_milli_per_1k,
      outputMilliPer1k: row.output_milli_per_1k,
    };
  }

  async holdCredits(input: HoldInput): Promise<HoldResult> {
    try {
      return await this.db.transaction(async (tx) => {
        // Insert first: the primary key on request_id is what makes a retried
        // hold idempotent instead of freezing the same request twice.
        const inserted = await tx.query<{ request_id: string }>(
          `INSERT INTO credit_holds (request_id, user_id, hold_amount)
           VALUES ($1, $2, $3)
           ON CONFLICT (request_id) DO NOTHING
           RETURNING request_id`,
          [input.requestId, input.userId, input.holdMilli],
        );

        if (!inserted[0]) {
          const existing = await tx.query<{ user_id: number; hold_amount: number; status: number }>(
            `SELECT user_id, hold_amount, status FROM credit_holds WHERE request_id = $1`,
            [input.requestId],
          );
          const credit = await tx.query<{ balance: number; frozen: number }>(`SELECT balance, frozen FROM credit_accounts WHERE user_id = $1`, [input.userId]);
          const row = existing[0];
          const sameOpenHold = row !== undefined && row.user_id === input.userId && row.status === 0;
          return {
            status: sameOpenHold ? "held" : "closed",
            balance: credit[0]?.balance ?? 0,
            frozen: credit[0]?.frozen ?? 0,
            holdAmount: row?.hold_amount ?? input.holdMilli,
          };
        }

        const debited = await tx.query<{ balance: number; frozen: number }>(
          `UPDATE credit_accounts
              SET balance = balance - $2, frozen = frozen + $2, updated_at = now()
            WHERE user_id = $1 AND balance >= $2
            RETURNING balance, frozen`,
          [input.userId, input.holdMilli],
        );
        if (!debited[0]) {
          const credit = await tx.query<{ balance: number; frozen: number }>(`SELECT balance, frozen FROM credit_accounts WHERE user_id = $1`, [input.userId]);
          if (!credit[0]) throw new HoldAborted({ status: "no_account", balance: 0, frozen: 0, holdAmount: input.holdMilli });
          throw new HoldAborted({ status: "insufficient", balance: credit[0].balance, frozen: credit[0].frozen, holdAmount: input.holdMilli });
        }
        return { status: "held", balance: debited[0].balance, frozen: debited[0].frozen, holdAmount: input.holdMilli };
      });
    } catch (error) {
      if (error instanceof HoldAborted) return error.result;
      throw error;
    }
  }

  async settleCredits(input: SettleInput): Promise<SettleResult> {
    return this.db.transaction(async (tx) => {
      const held = await tx.query<{ hold_amount: number; status: number; settled_amount: number | null }>(
        `SELECT hold_amount, status, settled_amount FROM credit_holds
          WHERE request_id = $1 AND user_id = $2 FOR UPDATE`,
        [input.requestId, input.userId],
      );
      const credit = await tx.query<{ balance: number; frozen: number }>(`SELECT balance, frozen FROM credit_accounts WHERE user_id = $1`, [input.userId]);
      const balance = credit[0]?.balance ?? 0;
      const frozen = credit[0]?.frozen ?? 0;
      const hold = held[0];
      if (!hold) return { status: "missing", balance, frozen, holdAmount: 0, charged: 0 };
      if (hold.status === 2) return { status: "released", balance, frozen, holdAmount: hold.hold_amount, charged: 0 };
      if (hold.status === 1) return { status: "already_settled", balance, frozen, holdAmount: hold.hold_amount, charged: hold.settled_amount ?? hold.hold_amount };

      // The estimate can miss (cache hit rates vary); the platform absorbs any
      // overrun rather than letting the balance constraint reject the settle.
      const charged = Math.min(input.chargedMilli, hold.hold_amount);
      await tx.query(
        `UPDATE credit_holds SET status = 1, settled_amount = $3, closed_at = now()
          WHERE request_id = $1 AND user_id = $2`,
        [input.requestId, input.userId, charged],
      );
      const settled = await tx.query<{ balance: number; frozen: number }>(
        `UPDATE credit_accounts
            SET frozen = frozen - $2,
                balance = balance + ($2 - $3),
                total_spent = total_spent + $3,
                updated_at = now()
          WHERE user_id = $1
          RETURNING balance, frozen`,
        [input.userId, hold.hold_amount, charged],
      );
      const balanceAfter = settled[0]!.balance;
      await tx.query(
        `INSERT INTO credit_ledger (user_id, delta, balance_after, biz_type, biz_id, remark)
         VALUES ($1, $2, $3, 'LLM_USAGE', $4, $5)
         ON CONFLICT (biz_type, biz_id) DO NOTHING`,
        [input.userId, -charged, balanceAfter, input.requestId, `${input.model} 调用`],
      );
      await tx.query(
        `INSERT INTO llm_usage (user_id, request_id, channel, model, input_tokens, cached_tokens, output_tokens, credits_used, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (request_id) DO NOTHING`,
        [input.userId, input.requestId, input.channel, input.model, input.inputTokens, input.cachedTokens, input.outputTokens, charged, input.latencyMs ?? 0],
      );
      return { status: "settled", balance: balanceAfter, frozen: settled[0]!.frozen, holdAmount: hold.hold_amount, charged };
    });
  }

  async releaseHold(input: { userId: number; requestId: string }): Promise<ReleaseResult> {
    return this.db.transaction(async (tx) => {
      const held = await tx.query<{ hold_amount: number; status: number }>(
        `SELECT hold_amount, status FROM credit_holds
          WHERE request_id = $1 AND user_id = $2 FOR UPDATE`,
        [input.requestId, input.userId],
      );
      const credit = await tx.query<{ balance: number; frozen: number }>(`SELECT balance, frozen FROM credit_accounts WHERE user_id = $1`, [input.userId]);
      const balance = credit[0]?.balance ?? 0;
      const frozen = credit[0]?.frozen ?? 0;
      const hold = held[0];
      if (!hold) return { status: "missing", balance, frozen, holdAmount: 0 };
      if (hold.status === 1) return { status: "settled", balance, frozen, holdAmount: hold.hold_amount };
      if (hold.status === 2) return { status: "already_released", balance, frozen, holdAmount: hold.hold_amount };

      await tx.query(`UPDATE credit_holds SET status = 2, closed_at = now() WHERE request_id = $1 AND user_id = $2`, [input.requestId, input.userId]);
      const refunded = await tx.query<{ balance: number; frozen: number }>(
        `UPDATE credit_accounts
            SET frozen = frozen - $2, balance = balance + $2, updated_at = now()
          WHERE user_id = $1 AND frozen >= $2
          RETURNING balance, frozen`,
        [input.userId, hold.hold_amount],
      );
      return { status: "released", balance: refunded[0]!.balance, frozen: refunded[0]!.frozen, holdAmount: hold.hold_amount };
    });
  }

  async setUserStatus(userId: number, status: number, audit: AuditInput): Promise<UserRow | undefined> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<UserRaw>(`UPDATE users SET status = $2 WHERE id = $1 RETURNING *`, [userId, status]);
      if (!rows[0]) return undefined;
      await insertAudit(tx, { ...audit, targetType: "user", targetId: String(userId), detail: { status } });
      return toUser(rows[0]);
    });
  }

  async writeAudit(input: AuditInput): Promise<void> {
    await insertAudit(this.db, input);
  }

  async listAudit(beforeId: number | undefined, limit: number): Promise<AuditRow[]> {
    return this.readAudit("", [beforeId ?? null, limit]);
  }

  async listUserAudit(userId: number, limit: number): Promise<AuditRow[]> {
    return this.readAudit("AND a.target_type = 'user' AND a.target_id = $3", [null, limit, String(userId)]);
  }

  private async readAudit(filter: string, values: unknown[]): Promise<AuditRow[]> {
    const rows = await this.db.query<{
      id: number; admin_id: number; username: string | null; action: string; target_type: string | null;
      target_id: string | null; detail: unknown; ip: string | null; created_at: Date;
    }>(
      `SELECT a.id, a.admin_id, u.username, a.action, a.target_type, a.target_id, a.detail, a.ip, a.created_at
         FROM admin_audit a LEFT JOIN admin_users u ON u.id = a.admin_id
        WHERE ($1::bigint IS NULL OR a.id < $1::bigint) ${filter}
        ORDER BY a.id DESC LIMIT $2`,
      values,
    );
    return rows.map((row) => ({
      id: row.id,
      adminId: row.admin_id,
      adminUsername: row.username,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      detail: row.detail,
      ip: row.ip,
      createdAt: row.created_at.toISOString(),
    }));
  }
}

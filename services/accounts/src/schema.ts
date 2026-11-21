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
 * Idempotent schema.
 *
 * Every statement is `IF NOT EXISTS`, so applying it to an empty database and
 * applying it again to the same database both succeed. Column comments carry the
 * enumerations the code depends on, since PostgreSQL has no portable enum
 * migration story.
 *
 * Two additions over the design tables are marked below; both exist to make a
 * stated rule enforceable rather than advisory:
 *   - `sessions.prev_refresh_hash` makes "reusing a rotated refresh token
 *     revokes the session" detectable at all.
 *   - administrator authentication is password-only; the legacy TOTP column is
 *     dropped when an older database is opened.
 */

import type { Queryable } from "./db.js";

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    openid        VARCHAR(64)  NOT NULL UNIQUE,
    display_name  VARCHAR(64),
    avatar_url    VARCHAR(512),
    email         VARCHAR(254),
    status        SMALLINT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS credit_accounts (
    user_id      BIGINT PRIMARY KEY REFERENCES users(id),
    balance      BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    frozen       BIGINT NOT NULL DEFAULT 0 CHECK (frozen  >= 0),
    total_earned BIGINT NOT NULL DEFAULT 0,
    total_spent  BIGINT NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS credit_ledger (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL,
    delta         BIGINT NOT NULL,
    balance_after BIGINT NOT NULL,
    biz_type      VARCHAR(24) NOT NULL,
    biz_id        VARCHAR(64) NOT NULL,
    remark        VARCHAR(128),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (biz_type, biz_id)
  )`,
  `CREATE INDEX IF NOT EXISTS credit_ledger_user ON credit_ledger (user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS credit_holds (
    request_id     UUID PRIMARY KEY,
    user_id        BIGINT NOT NULL,
    hold_amount    BIGINT NOT NULL,
    settled_amount BIGINT,
    status         SMALLINT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at      TIMESTAMPTZ
  )`,
  "ALTER TABLE credit_holds ADD COLUMN IF NOT EXISTS settled_amount BIGINT",
  `CREATE INDEX IF NOT EXISTS credit_holds_user_open ON credit_holds (user_id) WHERE status = 0`,
  `CREATE TABLE IF NOT EXISTS model_prices (
    model                    VARCHAR(64) PRIMARY KEY,
    input_milli_per_1k       BIGINT NOT NULL,
    cached_input_milli_per_1k BIGINT NOT NULL,
    output_milli_per_1k      BIGINT NOT NULL,
    enabled                  BOOLEAN NOT NULL DEFAULT true,
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (input_milli_per_1k >= 0 AND cached_input_milli_per_1k >= 0 AND output_milli_per_1k >= 0)
  )`,
  // Prices live in the database so a change is an UPDATE, not a redeploy. They
  // are stored in milli-credits per 1k tokens: 1 displayed credit = 1000 milli
  // = 0.08 CNY. The values below are the peak-time list price (¥2 / ¥8 per
  // million input / output); cached input is a tenth of input, rounded to a
  // milli-credit.
  `INSERT INTO model_prices (model, input_milli_per_1k, cached_input_milli_per_1k, output_milli_per_1k) VALUES
    ('deepseek-v4-flash',   25,  3,   50),
    ('deepseek-v4.1-flash', 25,  3,  100),
    ('deepseek-v4.1-flash-1017', 25, 3, 100),
    ('deepseek-v4-pro',     150, 15,  300),
    ('glm-5.1',             75,  8,   300),
    ('glm-5.2',             100, 10,  350),
    ('kimi-k2.6',           75,  8,   350),
    ('glm-5.3',             125, 13,  400)
   ON CONFLICT (model) DO UPDATE SET
     input_milli_per_1k = EXCLUDED.input_milli_per_1k,
     cached_input_milli_per_1k = EXCLUDED.cached_input_milli_per_1k,
     output_milli_per_1k = EXCLUDED.output_milli_per_1k`,
  `CREATE TABLE IF NOT EXISTS llm_usage (
    id             BIGSERIAL PRIMARY KEY,
    user_id        BIGINT NOT NULL,
    request_id     UUID NOT NULL,
    channel        SMALLINT NOT NULL,
    model          VARCHAR(64) NOT NULL,
    input_tokens   INT,
    cached_tokens  INT,
    output_tokens  INT,
    credits_used   BIGINT,
    cost_micro_cny BIGINT,
    latency_ms     INT,
    status         SMALLINT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS llm_usage_user_time ON llm_usage (user_id, created_at DESC)`,
  // A settle retry must not double-write usage; the unique request id is what
  // makes `ON CONFLICT DO NOTHING` a real guarantee rather than a hope.
  `CREATE UNIQUE INDEX IF NOT EXISTS llm_usage_request ON llm_usage (request_id)`,
  `CREATE TABLE IF NOT EXISTS checkins (
    user_id      BIGINT NOT NULL,
    checkin_date DATE NOT NULL,
    streak       SMALLINT NOT NULL,
    credits      BIGINT NOT NULL,
    PRIMARY KEY (user_id, checkin_date)
  )`,
  `CREATE TABLE IF NOT EXISTS auth_tickets (
    jti        UUID PRIMARY KEY,
    openid     VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS auth_flows (
    state         VARCHAR(128) PRIMARY KEY,
    code_verifier VARCHAR(128) NOT NULL,
    return_url    VARCHAR(1024) NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    used_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS auth_flows_expiry ON auth_flows (expires_at)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id               UUID PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES users(id),
    refresh_hash     BYTEA NOT NULL UNIQUE,
    prev_refresh_hash BYTEA,
    prev_rotated_at  TIMESTAMPTZ,
    platform         SMALLINT NOT NULL,
    device_label     VARCHAR(128),
    device_id        VARCHAR(64),
    ip               VARCHAR(45),
    user_agent       VARCHAR(512),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ NOT NULL,
    revoked_at       TIMESTAMPTZ,
    revoked_reason   VARCHAR(32)
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user_active ON sessions (user_id, last_seen_at DESC) WHERE revoked_at IS NULL`,
  `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS prev_rotated_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS login_events (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT,
    session_id UUID,
    event      VARCHAR(16) NOT NULL,
    result     SMALLINT NOT NULL DEFAULT 0,
    ip         VARCHAR(45),
    user_agent VARCHAR(512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS login_events_user ON login_events (user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS admin_users (
    id            BIGSERIAL PRIMARY KEY,
    username      VARCHAR(64) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          SMALLINT NOT NULL DEFAULT 0,
    status        SMALLINT NOT NULL DEFAULT 0,
    failed_count  SMALLINT NOT NULL DEFAULT 0,
    locked_until  TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE admin_users DROP COLUMN IF EXISTS totp_secret`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (
    id           UUID PRIMARY KEY,
    admin_id     BIGINT NOT NULL REFERENCES admin_users(id),
    token_hash   BYTEA NOT NULL UNIQUE,
    ip           VARCHAR(45),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS admin_audit (
    id          BIGSERIAL PRIMARY KEY,
    admin_id    BIGINT NOT NULL,
    action      VARCHAR(48) NOT NULL,
    target_type VARCHAR(24),
    target_id   VARCHAR(64),
    detail      JSONB,
    ip          VARCHAR(45),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS admin_audit_time ON admin_audit (created_at DESC)`,
];

export const SCHEMA_COLUMN_COMMENTS: readonly string[] = [
  "COMMENT ON COLUMN users.status IS '0 normal, 1 restricted, 2 frozen, 3 deleting'",
  "COMMENT ON COLUMN sessions.platform IS '1 Windows desktop, 2 Linux web'",
  "COMMENT ON COLUMN sessions.prev_refresh_hash IS 'previous rotate target; a match means the token was replayed'",
  "COMMENT ON COLUMN sessions.prev_rotated_at IS 'when prev_refresh_hash was installed; the retry window is anchored here, not on last_seen_at'",
  "COMMENT ON COLUMN login_events.event IS 'SIGN_IN, REFRESH, SIGN_OUT, REVOKED, REJECTED'",
  "COMMENT ON COLUMN admin_users.role IS '0 read-only, 1 operator, 2 owner'",
  "COMMENT ON COLUMN credit_ledger.biz_type IS 'REGISTER, CHECKIN, BONUS, LLM_USAGE, ADMIN, REFUND'",
  "COMMENT ON COLUMN credit_holds.status IS '0 open, 1 settled, 2 released'",
  "COMMENT ON COLUMN credit_holds.settled_amount IS 'milli-credits actually charged when the hold was settled'",
  "COMMENT ON COLUMN model_prices.input_milli_per_1k IS 'milli-credits per 1000 input tokens; 1000 milli = 1 credit'",
];

/**
 * Supabase publishes the `public` schema through PostgREST to the `anon` and
 * `authenticated` roles. The clients never receive a Supabase key, so this is
 * defence in depth rather than a live hole: revoking the grants makes "the Data
 * API cannot read the credit ledger" structural instead of a promise. Plain
 * PostgreSQL has no such roles, hence best-effort.
 */
export const SCHEMA_HARDENING: readonly string[] = [
  "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated",
  "REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated",
];

/** Applies the schema; safe to run on every deploy and repeatedly. */
export async function applySchema(db: Queryable): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) await db.query(statement);
  for (const statement of SCHEMA_COLUMN_COMMENTS) await db.query(statement).catch(() => undefined);
  for (const statement of SCHEMA_HARDENING) await db.query(statement).catch(() => undefined);
}

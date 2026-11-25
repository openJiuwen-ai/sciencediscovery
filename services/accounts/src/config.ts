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

import { MILLI_PER_CREDIT } from "./pricing.js";

/**
 * Deployment settings for the account service.
 *
 * Everything the service needs comes from environment variables so the same
 * build runs unchanged as a FunctionGraph HTTP function or as a local process.
 * Secrets never have defaults: a missing one fails at startup rather than
 * silently downgrading the deployment.
 */

export interface AccountsConfig {
  databaseUrl: string;
  jwtSecret: string;
  huaweiClientId: string;
  huaweiClientSecret: string;
  huaweiTokenEndpoint: string;
  /**
   * Exact redirect URI registered with HUAWEI ID. The token exchange must send
   * the same string the browser used at authorize time, and the callback only
   * carries `code` and `state`, so it cannot be recovered from the request.
   */
  huaweiRedirectUri: string;
  /** Where the browser returns after the callback, e.g. https://app.example.com/login. */
  webReturnUrl: string;
  /** Exact origin allowed to send admin credentials, e.g. https://admin.example.com. */
  adminOrigin: string;
  /**
   * Extra browser origins allowed to call the user routes without credentials,
   * e.g. the desktop client's local UI origin http://127.0.0.1:4310. Bearer
   * tokens are not sent automatically, so this grants no ambient authority.
   */
  webOrigins: string[];
  /** Domain attribute of the admin cookie; empty keeps it host-only. */
  adminCookieDomain: string;
  /**
   * Shared secret the LLM proxy presents on `/internal/billing/*`. Empty
   * disables those routes, so a deployment that has not wired the proxy yet
   * cannot be billed by accident.
   */
  billingToken: string;
  /**
   * Model gateway the proxy forwards `/v1/chat/completions` to. Empty disables
   * the proxy, so a deployment without a gateway cannot leak unmetered calls.
   */
  litellmBaseUrl: string;
  /** Credential the gateway expects; only ever sent on the internal hop. */
  litellmApiKey: string;
  /** Whole-request cap for one upstream call, including a streamed reply. */
  litellmTimeoutSeconds: number;
  cookieSecure: boolean;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  ticketTtlSeconds: number;
  adminSessionTtlSeconds: number;
  /** Credits granted once per account on first sign-in, in whole credits. */
  registerGrantCredits: number;
  /** Credits granted by each daily sign-in reward, in whole credits. */
  dailyRewardCredits: number;
  /** Number of accumulated check-ins between consecutive bonus grants. */
  checkinBonusEveryDays: number;
  /** Extra credits granted on each accumulated-check-in milestone. */
  streakBonusCredits: number;
  /** Largest single manual adjustment, in whole credits. */
  adminAdjustLimitCredits: number;
  /** Password failures before the admin account locks. */
  adminMaxFailures: number;
  adminLockSeconds: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Parses `60`, `90s`, `15m`, `8h`, `30d` into seconds. */
export function parseDuration(raw: string | undefined, fallbackSeconds: number): number {
  const value = (raw ?? "").trim();
  if (!value) return fallbackSeconds;
  const match = /^(\d+)([smhd])?$/u.exec(value);
  if (!match) throw new ConfigError(`invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  return amount * multiplier;
}

function readNonNegativeInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, scale = 1): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw.trim()) || !Number.isSafeInteger(value * scale)) {
    throw new ConfigError(`${name} must be a non-negative integer within the supported range`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AccountsConfig {
  const required = ["DATABASE_URL", "JWT_SECRET", "HUAWEI_CLIENT_ID", "WEB_RETURN_URL", "ADMIN_ORIGIN"];
  const missing = required.filter((name) => !(env[name] ?? "").trim());
  if (missing.length > 0) throw new ConfigError(`missing ${missing.join(", ")}`);

  const jwtSecret = (env.JWT_SECRET ?? "").trim();
  if (Buffer.byteLength(jwtSecret, "utf8") < 32) throw new ConfigError("JWT_SECRET must be at least 32 bytes");

  const bonusPeriodName = env.CHECKIN_BONUS_EVERY_DAYS !== undefined
    ? "CHECKIN_BONUS_EVERY_DAYS" : "DAILY_REWARD_DAYS";

  return {
    databaseUrl: (env.DATABASE_URL ?? "").trim(),
    jwtSecret,
    huaweiClientId: (env.HUAWEI_CLIENT_ID ?? "").trim(),
    huaweiClientSecret: (env.HUAWEI_CLIENT_SECRET ?? "").trim(),
    huaweiTokenEndpoint: (env.HUAWEI_TOKEN_ENDPOINT ?? "").trim() || "https://oauth-login.cloud.huawei.com/oauth2/v3/token",
    huaweiRedirectUri: (env.HUAWEI_REDIRECT_URI ?? "").trim(),
    webReturnUrl: (env.WEB_RETURN_URL ?? "").trim(),
    adminOrigin: (env.ADMIN_ORIGIN ?? "").trim().replace(/\/+$/u, ""),
    webOrigins: (env.WEB_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/u, ""))
      .filter(Boolean),
    adminCookieDomain: (env.ADMIN_COOKIE_DOMAIN ?? "").trim(),
    billingToken: (env.BILLING_TOKEN ?? "").trim(),
    litellmBaseUrl: ((env.LITELLM_BASE_URL ?? "").trim()).replace(/\/+$/u, ""),
    // The local compose file already names the gateway secret LITELLM_MASTER_KEY;
    // accepting LITELLM_API_KEY too keeps the dedicated-key deployment working.
    litellmApiKey: ((env.LITELLM_API_KEY ?? "").trim() || (env.LITELLM_MASTER_KEY ?? "").trim()),
    litellmTimeoutSeconds: parseDuration(env.LITELLM_TIMEOUT, 600),
    cookieSecure: (env.COOKIE_SECURE ?? "true").trim() !== "false",
    accessTtlSeconds: parseDuration(env.ACCESS_TTL, 900),
    refreshTtlSeconds: parseDuration(env.REFRESH_TTL, 30 * 86400),
    ticketTtlSeconds: parseDuration(env.TICKET_TTL, 60),
    adminSessionTtlSeconds: parseDuration(env.ADMIN_SESSION_TTL, 8 * 3600),
    // 1 credit is 0.08 CNY. Daily rewards are long-lived; every 7th
    // accumulated check-in also pays the streak bonus.
    registerGrantCredits: Number(env.REGISTER_GRANT_CREDITS ?? 500),
    dailyRewardCredits: readNonNegativeInteger(env, "DAILY_REWARD_CREDITS", 100, MILLI_PER_CREDIT),
    checkinBonusEveryDays: readNonNegativeInteger(env, bonusPeriodName, 7),
    streakBonusCredits: readNonNegativeInteger(env, "STREAK_BONUS_CREDITS", 50, MILLI_PER_CREDIT),
    adminAdjustLimitCredits: Number(env.ADMIN_ADJUST_LIMIT_CREDITS ?? 100000),
    adminMaxFailures: Number(env.ADMIN_MAX_FAILURES ?? 5),
    adminLockSeconds: parseDuration(env.ADMIN_LOCK, 900),
  };
}

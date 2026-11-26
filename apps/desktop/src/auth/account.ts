/**
 * HUAWEI account access for the new desktop/web workbench.
 *
 * The account service owns identity and credits; this module only supplies the
 * build-time endpoint and the product name shown when HUAWEI shares no name.
 */

import {
  AccountApiError,
  accountSessionToUserSession,
  describeDevice,
  exchangeTicket as exchangeSharedTicket,
  fetchAccountMe as fetchSharedAccountMe,
  huaweiSignInUrl as sharedHuaweiSignInUrl,
  buildEnv,
  refreshAccountSession as refreshSharedAccountSession,
  revokeAccountSession as revokeSharedAccountSession,
} from "@sciencediscovery/account-session";
import type {
  AccountClientOptions,
  AccountCredit,
  AccountDevice,
  AccountMe,
  AccountSession,
  AccountUser,
} from "@sciencediscovery/account-session";

import type { UserSession } from "./session.js";

export type { AccountCredit, AccountDevice, AccountMe, AccountSession, AccountUser };
export { AccountApiError, accountSessionToUserSession, describeDevice };

export const DEFAULT_ACCOUNT_NAME = "华为账号用户";

/** Base URL of the account service; empty means "same origin as this page". */
export function accountsBaseUrl(): string {
  return buildEnv("VITE_ACCOUNTS_API").trim().replace(/\/+$/u, "");
}

/**
 * True when this build names an account service.
 *
 * An empty base is the documented "same origin" opt-out, but this app is
 * served by the local API, which has no `/v1` account routes: the sign-in
 * navigation would be answered with `index.html` and the app would reload
 * silently. The entry points read this instead of navigating, so the
 * configuration gap is visible rather than a bounce back to the workspace.
 */
export function accountsConfigured(): boolean {
  return accountsBaseUrl() !== "";
}

function options(): AccountClientOptions {
  return { baseUrl: accountsBaseUrl() };
}

export function huaweiSignInUrl(returnUrl: string): string {
  return sharedHuaweiSignInUrl(returnUrl, options());
}

export function exchangeTicket(ticket: string, device: AccountDevice): Promise<AccountSession> {
  return exchangeSharedTicket(ticket, device, options());
}

export function refreshAccountSession(refreshToken: string): Promise<AccountSession> {
  return refreshSharedAccountSession(refreshToken, options());
}

export function fetchAccountMe(accessToken: string): Promise<AccountMe> {
  return fetchSharedAccountMe(accessToken, options());
}

export function revokeAccountSession(accessToken: string): Promise<void> {
  return revokeSharedAccountSession(accessToken, options());
}

/** Profile fields a signed-in person may change; email stays HUAWEI-owned. */
export interface AccountProfilePatch {
  displayName: string;
}

export async function updateAccountProfile(
  accessToken: string,
  patch: AccountProfilePatch,
): Promise<AccountUser> {
  const response = await fetch(`${accountsBaseUrl()}/v1/me`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = (await response.json().catch(() => undefined)) as
    | { user?: AccountUser; error?: { code?: unknown; message?: unknown } }
    | undefined;
  if (!response.ok) {
    const message = typeof body?.error?.message === "string" ? body.error.message : `account service returned ${response.status}`;
    const code = typeof body?.error?.code === "string" ? body.error.code : undefined;
    throw new AccountApiError(message, response.status, code);
  }
  if (!body?.user) throw new AccountApiError("account service returned no user", response.status);
  return body.user;
}

export interface AccountSessionRow {
  id: string;
  platform: number;
  platformLabel: string;
  deviceLabel: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /** True when the server saw this session inside its online window. */
  online: boolean;
  current: boolean;
}

export interface AccountLedgerRow {
  id: number;
  delta: number;
  deltaCredits: number;
  balanceAfter: number;
  balanceAfterCredits: number;
  bizType: string;
  bizId: string;
  remark: string | null;
  createdAt: string;
}

export interface AccountUsageDay {
  day: string;
  requests: number;
  creditsUsed: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AccountUsageRecord {
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

async function getAccountJson<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`${accountsBaseUrl()}${path}`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new AccountApiError(`account service returned ${response.status}`, response.status);
  return (await response.json()) as T;
}

export async function listAccountSessions(accessToken: string): Promise<{ currentSessionId: string; items: AccountSessionRow[] }> {
  return getAccountJson("/v1/me/sessions", accessToken);
}

export async function revokeAccountDevice(accessToken: string, sessionId: string): Promise<void> {
  const response = await fetch(`${accountsBaseUrl()}/v1/me/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new AccountApiError(`account service returned ${response.status}`, response.status);
}

/** Newest-first ledger pages. The cursor is the last row's id, so a page is a
 *  stable window even while new entries are written. */
export async function listAccountLedger(
  accessToken: string,
  limit = 20,
  beforeId?: number,
): Promise<{ items: AccountLedgerRow[]; nextBeforeId: number | null }> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (beforeId !== undefined) query.set("beforeId", String(beforeId));
  return getAccountJson(`/v1/credits/ledger?${query.toString()}`, accessToken);
}

export async function fetchAccountUsage(accessToken: string): Promise<{ days: AccountUsageDay[]; records: AccountUsageRecord[] }> {
  return getAccountJson("/v1/me/usage", accessToken);
}

export type { UserSession };

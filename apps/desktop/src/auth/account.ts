/**
 * HUAWEI account access for the new desktop/web workbench.
 *
 * The account service owns identity and credits; this module only supplies the
 * build-time endpoint and the product name shown when HUAWEI shares no name.
 */

import {
  AccountApiError,
  accountSessionToUserSession,
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
  AccountMe,
  AccountSession,
  AccountUser,
} from "@sciencediscovery/account-session";

import type { UserSession } from "./session.js";
import { TEXT } from "../text.js";

export type { AccountCredit, AccountMe, AccountSession, AccountUser };
export { AccountApiError, accountSessionToUserSession };

/**
 * The product name shown when HUAWEI shares no display name for the profile.
 *
 * Read at call time on purpose: a module-level constant would freeze whichever
 * language happened to be active when this module first loaded, so an English
 * UI would keep showing the Chinese name (#1398).
 */
export function defaultAccountName(): string {
  return TEXT.account.defaultName;
}

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

export function exchangeTicket(ticket: string): Promise<AccountSession> {
  return exchangeSharedTicket(ticket, options());
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

/** The most ledger rows this client reads or shows. A busy account's spending
 *  history can be long, and the UI is a reading surface, not an export: the
 *  database keeps the same ceiling per kind, so this is the whole history the
 *  page ever asks for. */
export const MAX_LEDGER_ROWS = 1000;

/** One ledger window: newest-first rows plus the next cursor, if any. */
interface LedgerWindow {
  items: AccountLedgerRow[];
  nextBeforeId: number | null;
}

/** The whole ledger in one read, so paging happens on this device.
 *
 *  A service that predates `all=1` ignores the flag and returns its default
 *  page with a cursor. Following it keeps a client released before the service
 *  from showing a single page; the ceiling still bounds the work. */
export async function listAccountLedgerAll(accessToken: string): Promise<LedgerWindow> {
  const first: LedgerWindow = await getAccountJson<LedgerWindow>(
    "/v1/credits/ledger?all=1",
    accessToken,
  );
  if (first.nextBeforeId === null) return first;
  const items = [...first.items];
  let beforeId: number | null = first.nextBeforeId;
  while (beforeId !== null && items.length < MAX_LEDGER_ROWS) {
    const page: LedgerWindow = await getAccountJson<LedgerWindow>(
      `/v1/credits/ledger?limit=100&beforeId=${beforeId}`,
      accessToken,
    );
    if (page.items.length === 0) break;
    items.push(...page.items);
    if (page.nextBeforeId === beforeId) break;
    beforeId = page.nextBeforeId;
  }
  return { items: items.slice(0, MAX_LEDGER_ROWS), nextBeforeId: null };
}

export async function fetchAccountUsage(accessToken: string): Promise<{ days: AccountUsageDay[]; records: AccountUsageRecord[] }> {
  return getAccountJson("/v1/me/usage", accessToken);
}

export type { UserSession };

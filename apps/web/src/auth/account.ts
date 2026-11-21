/**
 * The old web client's view of the shared HUAWEI account layer.
 *
 * The implementation lives in `@sciencediscovery/account-session`; this module
 * only supplies the build-time base URL and re-exports the names the login page
 * and the credits provider already use.
 */

import {
  AccountApiError,
  accountSessionToUserSession,
  describeDevice,
  exchangeTicket as exchangeSharedTicket,
  fetchAccountMe as fetchSharedAccountMe,
  buildEnv,
  huaweiSignInUrl as sharedHuaweiSignInUrl,
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

/** Base URL of the account service; empty means "same origin as this page". */
export function accountsBaseUrl(): string {
  return buildEnv("VITE_ACCOUNTS_API").trim().replace(/\/+$/u, "");
}

function options(): AccountClientOptions {
  return { baseUrl: accountsBaseUrl() };
}

/** Starts the server-owned HUAWEI authorization. */
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

export type { UserSession };

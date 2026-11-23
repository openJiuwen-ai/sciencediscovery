/**
 * HUAWEI account sign-in shared by both front ends.
 *
 * The account service owns identity and credits. This package only keeps the
 * browser-side copy of the session, exchanges the single-use ticket, rotates
 * the refresh token, and builds the server-owned PKCE sign-in URL.
 */

export interface AccountUser {
  id: number;
  openid: string;
  openidTail: string;
  displayName: string | null;
  avatarUrl: string | null;
  email: string | null;
  /** 0 normal, 1 restricted, 2 frozen, 3 deleting. */
  status: number;
  createdAt: string;
  lastLoginAt: string | null;
}

/** Balances arrive in milli-credits; the `*Credits` fields are whole credits. */
export interface AccountCredit {
  balance: number;
  balanceCredits: number;
  frozen: number;
  frozenCredits: number;
  totalEarned: number;
  totalEarnedCredits: number;
  totalSpent: number;
  totalSpentCredits: number;
  updatedAt: string | null;
}

export interface AccountSession {
  accessToken: string;
  accessExpiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string;
  /** True only when this very sign-in created the account. */
  isNewUser: boolean;
  user: AccountUser;
  credit: AccountCredit;
}

export interface AccountMe {
  user: AccountUser;
  credit: AccountCredit;
  /** Daily check-ins counted by the service, so the seven-day strip does not
   *  have to count only the newest ledger page. Absent on older services. */
  checkins?: {
    total: number;
    /** The China-local date of the newest check-in, `YYYY-MM-DD`. */
    lastDate: string | null;
  } | undefined;
  onlineSessions: number;
  activeSessions: number;
  currentSessionId: string;
}

export interface AccountDevice {
  /** 1 Windows desktop, 2 Linux web. */
  platform: 1 | 2;
  deviceLabel: string;
  deviceId: string;
}

/** `status === 0` means the request never reached the service. */
export class AccountApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AccountApiError";
  }

  /** The token, session or account will not work again — signing out is the only recovery. */
  get denied(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export const SESSION_STORAGE_KEY = "sciencediscovery-session";

/**
 * Reads a Vite build variable. `import.meta.env` is injected by Vite but is
 * absent when node:test imports these modules directly, so a bare property
 * access there would throw before any test body runs.
 */
export function buildEnv(name: string): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.[name] ?? "";
}

/** Refresh a little early so a request never races the expiry. */
const REFRESH_SKEW_MS = 60_000;
const DEVICE_STORAGE_KEY = "sciencediscovery-device-id";
const REFRESH_LOCK_NAME = "sciencediscovery-account-session-refresh";

export interface ReadableStorage {
  getItem(key: string): string | null;
  removeItem?(key: string): void;
  setItem(key: string, value: string): void;
}

export interface UserSession {
  /** Server-side `users.id`. */
  userId: number;
  /** HUAWEI ID `openid`: stable per app, reveals nothing about the person. */
  openId: string;
  displayName: string;
  /** Optional; collected only to send release notes and event notices. */
  email?: string;
  avatarUrl?: string;
  /** Bearer token for `/v1/me` and the other account routes. */
  accessToken: string;
  /** Rotates on every refresh; a replayed one ends the session server-side. */
  refreshToken: string;
  /** ISO timestamp after which the access token is rejected. */
  accessExpiresAt: string;
  /** Balance in whole credits, as the server last reported it. */
  balanceCredits: number;
  /** ISO timestamp of account creation. */
  createdAt: string;
  /** True when the sign-in that produced this record created the account. */
  isNewUser: boolean;
}

export interface AccountClientOptions {
  /** Base URL of the account service; empty means "same origin". */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function normalizedBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/u, "");
}

/** Electron's preload bridge, when this page runs inside the desktop shell. */
interface ShellAccountStorage {
  getItem(key: string): string | null;
  removeItem?(key: string): void;
  setItem(key: string, value: string): void;
}

function browserStorage(): ReadableStorage | undefined {
  // The desktop shell keeps the session behind its preload boundary (the main
  // process stores it with `safeStorage`), so a long-lived refresh token never
  // lands in renderer `localStorage`. A plain browser has no bridge and keeps
  // using its own storage.
  const shell = (globalThis as { sdShell?: { accountSessionStorage?: ShellAccountStorage } }).sdShell;
  if (shell?.accountSessionStorage) return shell.accountSessionStorage;
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseSession(raw: string | null): UserSession | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<UserSession>;
  const userId = record.userId;
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0) return undefined;
  if (!isNonEmptyString(record.openId)) return undefined;
  if (!isNonEmptyString(record.displayName)) return undefined;
  if (!isNonEmptyString(record.accessToken)) return undefined;
  if (!isNonEmptyString(record.refreshToken)) return undefined;
  if (!isNonEmptyString(record.accessExpiresAt) || !Number.isFinite(Date.parse(record.accessExpiresAt))) return undefined;
  if (typeof record.balanceCredits !== "number" || !Number.isFinite(record.balanceCredits)) return undefined;
  if (!isNonEmptyString(record.createdAt)) return undefined;
  return {
    userId,
    openId: record.openId,
    displayName: record.displayName,
    // Omitted rather than set to `undefined`: a round-tripped record must not
    // grow keys the caller never stored.
    ...(isNonEmptyString(record.email) ? { email: record.email } : {}),
    ...(isNonEmptyString(record.avatarUrl) ? { avatarUrl: record.avatarUrl } : {}),
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    accessExpiresAt: record.accessExpiresAt,
    balanceCredits: record.balanceCredits,
    createdAt: record.createdAt,
    isNewUser: record.isNewUser === true,
  };
}

export function readSession(storage: ReadableStorage | undefined = browserStorage()): UserSession | undefined {
  try {
    return parseSession(storage?.getItem(SESSION_STORAGE_KEY) ?? null);
  } catch {
    return undefined;
  }
}

export function saveSession(session: UserSession, storage: ReadableStorage | undefined = browserStorage()): void {
  try {
    storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // A storage that refuses the write keeps the in-memory session for this
    // page view; the next visit signs in again.
  }
}

export function clearSession(storage: ReadableStorage | undefined = browserStorage()): void {
  try {
    storage?.removeItem?.(SESSION_STORAGE_KEY);
  } catch {
    // Nothing to clean up when the storage is already unreachable.
  }
}

/** True when the access token is expired or about to be. */
export function sessionNeedsRefresh(session: UserSession, nowMs: number = Date.now()): boolean {
  const expiresAt = Date.parse(session.accessExpiresAt);
  // An unreadable expiry fails closed: refresh rather than trust the token.
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt - REFRESH_SKEW_MS <= nowMs;
}

/** Milliseconds until a session should be refreshed, at least zero. */
export function sessionRefreshDelayMs(session: UserSession, nowMs: number = Date.now()): number {
  const expiresAt = Date.parse(session.accessExpiresAt);
  if (!Number.isFinite(expiresAt)) return 0;
  return Math.max(0, expiresAt - REFRESH_SKEW_MS - nowMs);
}

function clientFetch(options: AccountClientOptions): typeof fetch {
  return options.fetchImpl ?? fetch;
}

async function request<T>(
  path: string,
  init: RequestInit,
  options: AccountClientOptions,
): Promise<T> {
  let response: Response;
  try {
    response = await clientFetch(options)(`${normalizedBase(options.baseUrl ?? "")}${path}`, init);
  } catch {
    throw new AccountApiError(`account service is unreachable: ${path}`, 0, "network_error");
  }
  if (response.ok) return (await response.json()) as T;

  const body = (await response.json().catch(() => undefined)) as
    | { error?: { code?: unknown; message?: unknown } }
    | undefined;
  const code = typeof body?.error?.code === "string" ? body.error.code : undefined;
  const message = typeof body?.error?.message === "string"
    ? body.error.message
    : `account service returned ${response.status}`;
  throw new AccountApiError(message, response.status, code);
}

function jsonRequest(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * Starts the server-owned HUAWEI authorization. The account service generates
 * the PKCE verifier, stores it against `state`, and redirects to HUAWEI, so the
 * browser never has to reconstruct a callback secret.
 */
export function huaweiSignInUrl(returnUrl: string, options: AccountClientOptions = {}): string {
  return `${normalizedBase(options.baseUrl ?? "")}/v1/auth/huawei/start?${new URLSearchParams({ returnUrl }).toString()}`;
}

/** Exchanges the single-use ticket from the HUAWEI callback for a real session. */
export async function exchangeTicket(
  ticket: string,
  device: AccountDevice,
  options: AccountClientOptions = {},
): Promise<AccountSession> {
  const session = await request<Omit<AccountSession, "isNewUser"> & { isNewUser?: boolean }>(
    "/v1/auth/ticket",
    jsonRequest({ ticket, platform: device.platform, deviceLabel: device.deviceLabel, deviceId: device.deviceId }),
    options,
  );
  return { ...session, isNewUser: session.isNewUser === true };
}

/**
 * Rotates the refresh token. Every call invalidates the previous one, so the
 * caller must persist the returned session before doing anything else.
 */
export async function refreshAccountSession(
  refreshToken: string,
  options: AccountClientOptions = {},
): Promise<AccountSession> {
  const session = await request<Omit<AccountSession, "isNewUser">>(
    "/v1/auth/refresh",
    jsonRequest({ refreshToken }),
    options,
  );
  return { ...session, isNewUser: false };
}

/**
 * Converts a server session into the record the client stores. The previous
 * record is kept for display-name fallback so background refreshes never lose
 * the user's local name when HUAWEI shares no profile name.
 */
export function accountSessionToUserSession(
  account: AccountSession,
  previous?: UserSession,
  fallbackDisplayName = "ScienceDiscovery",
  nowMs: number = Date.now(),
): UserSession {
  return {
    userId: account.user.id,
    openId: account.user.openid,
    displayName: account.user.displayName?.trim() || previous?.displayName || fallbackDisplayName,
    email: account.user.email?.trim() || undefined,
    avatarUrl: account.user.avatarUrl ?? undefined,
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    accessExpiresAt: new Date(nowMs + account.accessExpiresIn * 1000).toISOString(),
    balanceCredits: account.credit.balanceCredits,
    createdAt: account.user.createdAt,
    isNewUser: account.isNewUser,
  };
}

/** Reads the server-side profile and balance; `platform`-independent. */
export async function fetchAccountMe(
  accessToken: string,
  options: AccountClientOptions = {},
): Promise<AccountMe> {
  return request<AccountMe>("/v1/me", { headers: { authorization: `Bearer ${accessToken}` } }, options);
}

/** Revokes the session server-side. Best effort: local state is cleared either way. */
export async function revokeAccountSession(
  accessToken: string,
  options: AccountClientOptions = {},
): Promise<void> {
  await request<{ ok: boolean }>(
    "/v1/auth/logout",
    { method: "POST", headers: { authorization: `Bearer ${accessToken}` } },
    options,
  );
}

/** Stable per-installation id so the admin console can tell two machines apart. */
function deviceId(): string {
  try {
    const saved = globalThis.localStorage?.getItem(DEVICE_STORAGE_KEY);
    if (saved) return saved;
    const created = globalThis.crypto?.randomUUID?.() ?? `device-${Math.random().toString(36).slice(2)}`;
    globalThis.localStorage?.setItem(DEVICE_STORAGE_KEY, created);
    return created;
  } catch {
    return "unknown-device";
  }
}

/** The desktop app runs inside Electron; everything else is the Linux web build. */
export function describeDevice(): AccountDevice {
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const desktop = /Electron/i.test(userAgent);
  return {
    platform: desktop ? 1 : 2,
    deviceLabel: `${desktop ? "Windows 桌面" : "Linux Web"} · ${userAgent.slice(0, 64) || "unknown"}`,
    deviceId: deviceId(),
  };
}

let refreshPromise: Promise<UserSession | undefined> | undefined;

function withRefreshLock(
  work: () => Promise<UserSession | undefined>,
): Promise<UserSession | undefined> {
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    const locks = (navigator as Navigator & {
      locks?: {
        request(
          name: string,
          callback: () => Promise<UserSession | undefined>,
        ): Promise<UserSession | undefined>;
      };
    }).locks;
    if (locks) return locks.request(REFRESH_LOCK_NAME, work);
  }
  if (!refreshPromise) {
    refreshPromise = work().finally(() => {
      refreshPromise = undefined;
    });
  }
  return refreshPromise;
}

/**
 * Refreshes the stored session when it is due. Passing the current session
 * avoids reading stale local state while another tab has already rotated it.
 */
export async function ensureFreshAccountSession(
  current?: UserSession,
  options: AccountClientOptions = {},
): Promise<UserSession | undefined> {
  const candidate = current ?? readSession();
  if (!candidate) return undefined;
  if (!sessionNeedsRefresh(candidate)) return candidate;

  return withRefreshLock(async () => {
    const latest = readSession();
    if (!latest) return undefined;
    if (!sessionNeedsRefresh(latest)) return latest;
    const account = await refreshAccountSession(latest.refreshToken, options);
    const next = accountSessionToUserSession(account, latest);
    saveSession(next);
    return next;
  });
}

/** The old web client's re-export of the shared account session record. */

export {
  SESSION_STORAGE_KEY,
  clearSession,
  parseSession,
  readSession,
  saveSession,
  sessionNeedsRefresh,
  sessionRefreshDelayMs,
} from "@sciencediscovery/account-session";
export type { ReadableStorage, UserSession } from "@sciencediscovery/account-session";

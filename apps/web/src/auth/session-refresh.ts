/** The old web client's re-export of the shared background refresh. */

import { buildEnv, ensureFreshAccountSession as ensureSharedFreshAccountSession } from "@sciencediscovery/account-session";

import type { UserSession } from "./session.js";

export function ensureFreshAccountSession(current?: UserSession): Promise<UserSession | undefined> {
  return ensureSharedFreshAccountSession(current, { baseUrl: buildEnv("VITE_ACCOUNTS_API") });
}

/** The new workbench's background account refresh. */

import { ensureFreshAccountSession as ensureSharedFreshAccountSession } from "@sciencediscovery/account-session";

import { accountsBaseUrl } from "./account.js";
import type { UserSession } from "./session.js";

export function ensureFreshAccountSession(current?: UserSession): Promise<UserSession | undefined> {
  return ensureSharedFreshAccountSession(current, { baseUrl: accountsBaseUrl() });
}

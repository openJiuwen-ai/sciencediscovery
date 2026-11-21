/**
 * The local control-plane credential.
 *
 * A signed-in HUAWEI account is the user's identity; the local bearer token is
 * an implementation detail of this machine's API. The shell therefore trades
 * the account access token for the local token through a loopback-only route,
 * so a person never has to copy a startup credential into the UI.
 */

import { TOKEN_STORAGE_KEY, readRenamedStorageItem, type ReadableStorage } from "./state/storage.js";

interface LocalTokenResponse {
  token?: unknown;
}

/** Read `#token=` when a development launch still supplies one. */
export function loadLocalAccessToken(
  storage: ReadableStorage,
  location: Pick<Location, "href">,
  history: Pick<History, "replaceState" | "state">,
): string {
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get("token")?.trim();
  if (fragment.has("token")) {
    if (token) {
      try {
        storage.setItem(TOKEN_STORAGE_KEY, token);
      } catch {
        // A storage that rejects writes still gets the token for this session.
      }
    }
    fragment.delete("token");
    url.hash = fragment.toString();
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }
  return token || readRenamedStorageItem(storage, TOKEN_STORAGE_KEY) || "";
}

/**
 * Ask this machine's API for its internal token after HUAWEI ID sign-in.
 *
 * The account token is the proof this is a signed-in session. The route is
 * refused for non-loopback callers, so this cannot be used to read the token
 * from another machine.
 */
export async function acquireLocalAccessToken(accountAccessToken: string): Promise<string> {
  const response = await fetch("/api/bootstrap/local-token", {
    method: "POST",
    headers: { authorization: `Bearer ${accountAccessToken}` },
  });
  if (!response.ok) throw new Error(`local service did not issue a credential (${response.status})`);
  const body = (await response.json()) as LocalTokenResponse;
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) throw new Error("local service returned an empty credential");
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // The in-memory token is enough for this page view.
  }
  return token;
}

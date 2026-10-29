// First-run race: the startup health gate watches the control API (4410)
// while the UI origin (4310 adapter)
// boots several seconds LATER on cold machines — the first loadURL then died
// with ERR_CONNECTION_REFUSED and the window sat on the dead error page until
// a manual reload ("step 3 felt disconnected from steps 1-2"). The health
// endpoint and the ui origin are different services: healthy != loadable.
// Pure decision helpers for the bounded auto-retry wired into main.ts's
// did-fail-load handler.

// Follow-up: the retry recovered the dead page
// but still showed a few BLANK seconds (the error page sitting there between
// loadUi and the adapter binding). The fix is to not load until the ui origin
// itself answers — the loading page stays on screen until the SPA is actually
// loadable, so the handoff is seamless; the retry loop stays as the backstop.

export const ERR_CONNECTION_REFUSED = -102;

/** Max loadURL retries before giving up (~50s worst case with the backoff). */
export const UI_LOAD_RETRY_LIMIT = 20;

/**
 * 1s for the first two attempts, then 2s — the adapter typically binds within
 * ~10s of the control API on a cold machine, so this stays invisible.
 */
export function uiLoadRetryDelayMs(retry: number): number {
  return retry <= 2 ? 1000 : 2000;
}

/**
 * Only retry main-frame connection refusals of the CURRENT ui origin. The
 * trailing slash keeps a sibling port from prefix-matching (4310 vs 14310),
 * and file:// pages (wizard / loading / token fallback) never match.
 */
export function shouldRetryUiLoad(
  code: number,
  url: string,
  isMainFrame: boolean,
  uiOrigin: string,
): boolean {
  return isMainFrame && code === ERR_CONNECTION_REFUSED && url.startsWith(`${uiOrigin}/`);
}

/**
 * Wait until the ui origin answers ANY http response — a bound listener is
 * what makes the SPA loadable (a bare TCP refusal rejects before a status
 * exists, so "fetch resolved" is exactly the signal we need; 404/401 count).
 * `fetchImpl`/`sleep`/`now` are injectable so the retry semantics stay
 * testable without wall-clock waits.
 */
export async function waitForUiOrigin(
  ui: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      await fetchImpl(`${ui}/`, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      // Listener not bound yet (or the probe timed out) — try again.
    }
    if (now() >= deadline) return false;
    await sleep(350);
  }
}

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

/**
 * HUAWEI sign-in through the system browser.
 *
 * In the Electron shell the sign-in page must open in the user's default
 * browser, not in a window the app owns. The shell exposes a one-shot loopback
 * callback (`window.sdShell.accountSignIn`): the renderer asks it for a
 * callback URL, builds the account-service sign-in URL with that URL as
 * `returnUrl`, and has the shell open it. The single-use ticket comes back as
 * a bridge event, and the caller exchanges it exactly as it did for a
 * same-window callback.
 *
 * A plain browser (the web build, the SPA's own dev server, Playwright) has no
 * bridge, so `browserSignInAvailable()` is false and callers keep the existing
 * in-page navigation. That also keeps the fragment-based callback path — and
 * its tests — working unchanged.
 */

export interface BrowserSignInResult {
  ticket?: string;
  error?: string;
}

/**
 * How long a system-browser round-trip may stay open before the app gives up.
 *
 * Five minutes is the usual window for interactive sign-in: Microsoft Entra's
 * default interactive auth timeout is 5 minutes per step, the same guideline
 * Okta and Auth0 document for browser redirect flows, and RFC 8628's device
 * grant leaves `expires_in` to the server with 5–30 minutes as the common
 * range. Anything longer reads as a frozen page; anything shorter cuts off a
 * user who is typing a password or completing MFA. The reader can also cancel
 * at any moment, so this is the ceiling, not the expected wait.
 */
export const SIGN_IN_DEADLINE_MS = 5 * 60 * 1000;

export interface BrowserSignInFlow {
  /** Resolves with the ticket or error; `null` when the flow was cancelled. */
  result: Promise<BrowserSignInResult | null>;
  /** Give up: stop listening and tell the shell to close its callback server. */
  cancel: () => void;
}

interface AccountSignInBridge {
  begin: () => Promise<{ callbackUrl: string }>;
  open: (url: string) => Promise<void>;
  cancel: () => Promise<void>;
  onResult: (callback: (result: BrowserSignInResult) => void) => () => void;
}

function bridge(): AccountSignInBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as typeof window & { sdShell?: { accountSignIn?: AccountSignInBridge } })
    .sdShell?.accountSignIn;
}

/** True when the system-browser flow can be used (the Electron shell). */
export function browserSignInAvailable(): boolean {
  return Boolean(bridge());
}

/**
 * Open the account service in the system browser and wait for its callback.
 *
 * `buildSignInUrl` turns the shell's loopback callback URL into the account
 * service's `/v1/auth/huawei/start` URL. The returned flow must be consumed
 * once: the ticket is single-use.
 */
export function startBrowserSignIn(
  buildSignInUrl: (callbackUrl: string) => string,
): BrowserSignInFlow {
  const accountSignIn = bridge();
  if (!accountSignIn) {
    return { result: Promise.resolve(null), cancel: () => {} };
  }

  let unsubscribe: (() => void) | undefined;
  let finished = false;
  let settle: (value: BrowserSignInResult | null) => void = () => {};
  const result = new Promise<BrowserSignInResult | null>((resolve) => { settle = resolve; });

  let deadline: ReturnType<typeof setTimeout> | undefined;

  const finish = (value: BrowserSignInResult | null): void => {
    if (finished) return;
    finished = true;
    if (deadline !== undefined) {
      clearTimeout(deadline);
      deadline = undefined;
    }
    unsubscribe?.();
    unsubscribe = undefined;
    settle(value);
  };

  // The reader can close the browser tab or walk away: without a deadline the
  // page would spin forever, because no callback ever arrives to settle it.
  deadline = setTimeout(() => {
    if (finished) return;
    // Tell the shell to release its loopback server; a late callback must not
    // land on a flow this app has already abandoned.
    void accountSignIn.cancel().catch(() => undefined);
    finish({ error: "timeout" });
  }, SIGN_IN_DEADLINE_MS);
  (deadline as { unref?: () => void }).unref?.();

  // Subscribe before opening the browser: the callback can arrive before
  // `open` resolves on a fast sign-in.
  unsubscribe = accountSignIn.onResult((value) => finish(value));
  /** Tell the shell to release a server this flow no longer wants. Needed
   *  separately from `cancel()`: `begin()` may resolve after the reader has
   *  already given up, and that server would otherwise stay listening. */
  const abandon = (): void => { void accountSignIn.cancel().catch(() => undefined); };
  void (async () => {
    try {
      const { callbackUrl } = await accountSignIn.begin();
      if (finished) {
        // Cancelled while the shell was still starting its callback server:
        // the server it has just created belongs to no flow, so close it.
        abandon();
        return;
      }
      await accountSignIn.open(buildSignInUrl(callbackUrl));
    } catch (error) {
      abandon();
      finish({ error: error instanceof Error ? error.message : String(error) });
    }
  })();

  return {
    result,
    cancel: () => {
      if (finished) return;
      // finish() releases the deadline and the subscription; the shell server
      // is stopped explicitly so a late callback cannot land on a flow this
      // page has already abandoned.
      finish(null);
      void accountSignIn.cancel().catch(() => undefined);
    },
  };
}

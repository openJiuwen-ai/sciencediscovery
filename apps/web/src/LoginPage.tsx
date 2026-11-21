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
 * Full-screen sign-in for the browser and desktop clients.
 *
 * The button leaves for the HUAWEI ID page, where the phone number and the SMS
 * code are handled entirely by HUAWEI. HUAWEI then calls the account service,
 * which verifies the code and sends the browser back to `/login#auth-ticket=…`.
 * The account service owns `state` and the PKCE verifier, consumes them on the
 * callback, and returns a single-use ticket. This component exchanges that
 * ticket for a session and shows the balance the server reports. No profile
 * form is shown — the display name and email come
 * from the HUAWEI ID profile, and a generic label is used when the profile
 * shares neither.
 */

import { useEffect, useRef, useState } from "react";

import { buildEnv } from "@sciencediscovery/account-session";

import {
  AccountApiError,
  accountSessionToUserSession,
  describeDevice,
  exchangeTicket,
  fetchAccountMe,
  huaweiSignInUrl,
  refreshAccountSession,
  revokeAccountSession,
} from "./auth/account.js";
import { readAuthTicket, readAuthorizeFailure } from "./auth/huawei.js";
import { clearSession, readSession, saveSession, sessionNeedsRefresh, type UserSession } from "./auth/session.js";
import { useLocale } from "./i18n/index.js";

const configuredCredits = Number(buildEnv("VITE_REGISTER_GRANT_CREDITS"));

/**
 * Credits granted the moment an account is created, for the marketing copy.
 * The server owns the real grant (`REGISTER_GRANT_CREDITS`); this mirrors the
 * same default and follows the same environment override so the promise on the
 * sign-in screen cannot drift from the ledger.
 */
export const REGISTRATION_CREDITS = Number.isFinite(configuredCredits) && configuredCredits > 0 ? configuredCredits : 500;

type Step = "idle" | "redirecting" | "verifying" | "done" | "error";

export interface LoginPageProps {
  /** Called when the user leaves the sign-in screen for the workspace. */
  onAuthenticated?: (session: UserSession) => void;
}

const CHECK = "M3 8.5 6.5 12 13 4.5";

export function LoginPage({ onAuthenticated }: LoginPageProps) {
  const { t } = useLocale();
  const [session, setSession] = useState<UserSession | undefined>(() => readSession());
  const [step, setStep] = useState<Step>(() => (readSession() ? "verifying" : "idle"));
  // Settling consumes the ticket and rotates the refresh token, so it must run
  // exactly once per mount. React StrictMode replays effects in development;
  // without this guard the replay finds the ticket already consumed and leaves
  // the page stuck on "verifying".
  const settlementStarted = useRef(false);

  useEffect(() => {
    if (settlementStarted.current) return;
    settlementStarted.current = true;

    function commit(next: UserSession): void {
      saveSession(next);
      setSession(next);
      setStep("done");
    }

    async function settle(): Promise<void> {
      const callback = readAuthTicket(window.location.hash);
      if (callback) {
        // Drop the ticket from the address bar before any await: a reload, a
        // shared link or a second effect run must not replay it.
        window.history.replaceState(null, "", window.location.pathname);
        // The account service consumed the server-side `state` before issuing
        // this ticket, so the ticket itself is the callback proof. No browser
        // `state` is compared here: HUAWEI returns the service state directly.
        setStep("verifying");
        try {
          const account = await exchangeTicket(callback.ticket, describeDevice());
          commit(accountSessionToUserSession(account, undefined, t("login.defaultName")));
        } catch {
          setStep("error");
        }
        return;
      }

      if (readAuthorizeFailure(window.location.hash)) {
        window.history.replaceState(null, "", window.location.pathname);
        setStep("error");
        return;
      }

      const current = readSession();
      if (!current) return;
      // The stored record is a cache: rotate the refresh token if it is due,
      // then ask the server what the balance is now.
      setStep("verifying");
      try {
        const fresh = sessionNeedsRefresh(current)
          ? accountSessionToUserSession(await refreshAccountSession(current.refreshToken), current, t("login.defaultName"))
          : current;
        if (fresh !== current) saveSession(fresh);
        const me = await fetchAccountMe(fresh.accessToken);
        commit({
          ...fresh,
          displayName: me.user.displayName?.trim() || fresh.displayName,
          email: me.user.email?.trim() || undefined,
          avatarUrl: me.user.avatarUrl ?? undefined,
          balanceCredits: me.credit.balanceCredits,
          isNewUser: false,
        });
      } catch (error) {
        if (error instanceof AccountApiError && error.denied) {
          clearSession();
          setSession(undefined);
          setStep("idle");
          return;
        }
        // Offline: keep the cached record so a network blip does not sign out.
        setStep("done");
      }
    }

    void settle();
  }, [t]);

  function startSignIn(): void {
    // The account service generates and stores the PKCE verifier, validates the
    // return origin, and redirects to HUAWEI. The browser only names the page
    // that should receive the ticket, which also covers desktop loopback UIs.
    setStep("redirecting");
    window.location.assign(huaweiSignInUrl(`${window.location.origin}/login`));
  }

  function signOut(): void {
    const current = session;
    clearSession();
    setSession(undefined);
    setStep("idle");
    if (current) void revokeAccountSession(current.accessToken).catch(() => undefined);
  }

  return (
    <div className="login-page">
      <section className="login-brand" aria-hidden="true">
        <div className="login-brand-inner">
          <span className="login-brand-mark">
            <svg fill="none" height="22" viewBox="0 0 22 22" width="22">
              <circle cx="11" cy="11" r="9.2" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="11" cy="11" r="3.4" fill="currentColor" />
            </svg>
          </span>
          <p className="login-brand-name">ScienceDiscovery</p>
          <h1 className="login-brand-title">{t("login.brandTitle")}</h1>
          <p className="login-brand-tagline">{t("login.brandTagline")}</p>
          <ul className="login-benefits">
            <li><span className="login-check" aria-hidden="true"><svg fill="none" viewBox="0 0 16 16"><path d={CHECK} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg></span>{t("login.benefit.credits", { credits: REGISTRATION_CREDITS })}</li>
            <li><span className="login-check" aria-hidden="true"><svg fill="none" viewBox="0 0 16 16"><path d={CHECK} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg></span>{t("login.benefit.noCard")}</li>
            <li><span className="login-check" aria-hidden="true"><svg fill="none" viewBox="0 0 16 16"><path d={CHECK} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg></span>{t("login.benefit.byok")}</li>
          </ul>
          <p className="login-brand-footnote">{t("login.brandFootnote")}</p>
        </div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          {step === "done" && session ? (
            <div className="login-done">
              <span className="login-done-mark" aria-hidden="true">
                <svg fill="none" viewBox="0 0 24 24"><path d="M4.5 12.5 9.5 17.5 19.5 6.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
              </span>
              <h2>{t("login.doneTitle")}</h2>
              <p className="login-lead">
                {session.isNewUser
                  ? t("login.doneBody", { name: session.displayName, credits: session.balanceCredits })
                  : t("login.doneBodyReturning", { name: session.displayName, credits: session.balanceCredits })}
              </p>
              <button className="primary-button login-wide" onClick={() => onAuthenticated?.(session)} type="button">
                {t("login.enter")}
              </button>
              <button className="login-link-button" onClick={signOut} type="button">{t("login.signOut")}</button>
            </div>
          ) : step === "redirecting" || step === "verifying" ? (
            <div className="login-busy">
              <span className="login-spinner" aria-hidden="true" />
              <p className="login-lead">{t(step === "redirecting" ? "login.redirecting" : "login.verifying")}</p>
            </div>
          ) : step === "error" ? (
            <div className="login-form">
              <h2>{t("login.errorTitle")}</h2>
              <p className="login-lead">{t("login.errorBody")}</p>
              <button className="primary-button login-wide" onClick={() => setStep("idle")} type="button">
                {t("login.retry")}
              </button>
            </div>
          ) : (
            <div className="login-form">
              <p className="login-eyebrow">{t("login.eyebrow")}</p>
              <h2>{t("login.title")}</h2>
              <p className="login-lead">{t("login.subtitle")}</p>

              <button className="login-huawei-button login-wide" onClick={startSignIn} type="button">
                <span className="login-huawei-mark" aria-hidden="true">ID</span>{t("login.huaweiButton")}
              </button>

              <p className="login-consent">{t("login.consent")}</p>

              <div className="login-divider"><span>{t("login.or")}</span></div>
              <a className="login-link-button" href="/settings/connection">{t("login.localToken")}</a>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

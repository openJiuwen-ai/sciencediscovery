/**
 * HUAWEI ID sign-in for the desktop workbench.
 *
 * The account service owns the PKCE verifier and `state`, consumes them on the
 * callback, and returns a single-use ticket. This page exchanges that ticket
 * for a session, stores it, and hands the shell over once the user continues.
 */

import { useEffect, useRef, useState } from "react";

import type { ApiClient } from "../api/client.js";
import type { ModelProvider, ModelProviderPreset } from "../api/types.js";
import {
  AccountApiError,
  DEFAULT_ACCOUNT_NAME,
  accountSessionToUserSession,
  type AccountSession,
  describeDevice,
  exchangeTicket,
  fetchAccountMe,
  huaweiSignInUrl,
  refreshAccountSession,
  revokeAccountSession,
} from "../auth/account.js";
import { clearSession, readSession, saveSession, sessionNeedsRefresh, type UserSession } from "../auth/session.js";
import { acquireLocalAccessToken } from "../local-access-token.js";
import { TEXT } from "../text.js";
import { ModelForm } from "./ModelForm.js";

type Step = "idle" | "redirecting" | "verifying" | "done" | "error";

interface Props {
  /** Called once the account is signed in and its local service credential is issued. */
  onAuthenticated: (session: UserSession, localToken: string) => void;
  /** The entry gate also offers the bring-your-own-model path; signed-in users
   *  who open this page again (to sign in later) keep only the HUAWEI option. */
  offerModelSetup?: boolean;
  client?: ApiClient;
  /** The model exists and was tested: the workspace can open without an account. */
  onModelConfigured?: () => void;
  onProvidersChanged?: () => void;
  presets?: ModelProviderPreset[];
  providers?: ModelProvider[];
}

/** Read `#auth-ticket=…`, the one-time ticket the account service issued. */
function readAuthTicket(hash: string): string | undefined {
  return new URLSearchParams(hash.replace(/^#/, "")).get("auth-ticket") ?? undefined;
}

function readAuthorizeFailure(hash: string): boolean {
  return Boolean(new URLSearchParams(hash.replace(/^#/, "")).get("error"));
}

/** True when the address carries the account service's callback. The ticket is
 *  consumed on the next render, so this is read once, before it is stripped —
 *  a signed-out workspace that keeps its local token would otherwise walk
 *  straight past the callback and stay signed out after a successful login. */
export function hasAuthCallback(hash: string): boolean {
  return readAuthTicket(hash) !== undefined || readAuthorizeFailure(hash);
}

/** Exchange the callback's ticket for an account session and this machine's
 *  credential, storing both. Returns undefined when the address carries no
 *  ticket (an error callback, or no callback at all). The fragment is stripped
 *  first, so a reload cannot spend the single-use ticket twice. Used by the
 *  sign-in page and by the account panel, which settles the same callback
 *  without leaving the panel. */
export async function settleAuthCallback(
  hash: string,
): Promise<{ session: UserSession; localToken: string } | undefined> {
  const ticket = readAuthTicket(hash);
  if (!ticket) return undefined;
  window.history.replaceState(null, "", window.location.pathname);
  const account = await exchangeTicket(ticket, describeDevice());
  const next = accountSessionToUserSession(account, readSession(), DEFAULT_ACCOUNT_NAME);
  const localToken = await acquireLocalAccessToken(account.accessToken);
  saveSession(next);
  return { session: next, localToken };
}

export function LoginPage({
  onAuthenticated,
  offerModelSetup = false,
  client,
  onModelConfigured,
  onProvidersChanged,
  presets = [],
  providers = [],
}: Props) {
  const [session, setSession] = useState<UserSession | undefined>(() => readSession());
  const [step, setStep] = useState<Step>(() => (readSession() ? "verifying" : "idle"));
  const [choice, setChoice] = useState<"account" | "model">("account");
  const [localToken, setLocalToken] = useState("");
  // Settling consumes the ticket and rotates the refresh token, so it must run
  // exactly once per mount.
  const settlementStarted = useRef(false);

  useEffect(() => {
    if (settlementStarted.current) return;
    settlementStarted.current = true;

    const commit = async (account: AccountSession): Promise<void> => {
      const next = accountSessionToUserSession(account, session, DEFAULT_ACCOUNT_NAME);
      // The local bearer token belongs to this machine, not to the person. Ask
      // this loopback API for it after sign-in rather than making the user copy
      // a startup credential into the UI.
      const local = await acquireLocalAccessToken(account.accessToken);
      saveSession(next);
      setSession(next);
      setLocalToken(local);
      setStep("done");
    };

    async function settle(): Promise<void> {
      const ticket = readAuthTicket(window.location.hash);
      if (ticket) {
        setStep("verifying");
        try {
          const settled = await settleAuthCallback(window.location.hash);
          if (settled) {
            setSession(settled.session);
            setLocalToken(settled.localToken);
            setStep("done");
          }
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
      setStep("verifying");
      try {
        const fresh = sessionNeedsRefresh(current)
          ? accountSessionToUserSession(await refreshAccountSession(current.refreshToken), current, DEFAULT_ACCOUNT_NAME)
          : current;
        const me = await fetchAccountMe(fresh.accessToken);
        await commit({
          accessToken: fresh.accessToken,
          accessExpiresIn: Math.max(0, Math.floor((Date.parse(fresh.accessExpiresAt) - Date.now()) / 1000)),
          refreshToken: fresh.refreshToken,
          // The stored record does not carry the refresh expiry; the account
          // service has already validated it, and the conversion uses only the
          // access expiry when rebuilding the local record.
          refreshExpiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
          isNewUser: false,
          user: {
            id: fresh.userId,
            openid: fresh.openId,
            openidTail: me.user.openidTail,
            displayName: me.user.displayName?.trim() || fresh.displayName,
            avatarUrl: me.user.avatarUrl ?? fresh.avatarUrl ?? null,
            email: me.user.email?.trim() || fresh.email || null,
            status: me.user.status,
            createdAt: fresh.createdAt,
            lastLoginAt: me.user.lastLoginAt,
          },
          credit: me.credit,
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
  }, []);

  function startSignIn(): void {
    setStep("redirecting");
    // This workbench has no `/login` route: the sign-in page is what `/`
    // renders while the local service credential is missing. Returning to the
    // root keeps the fragment on the page that exchanges the ticket.
    window.location.assign(huaweiSignInUrl(`${window.location.origin}/`));
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
      <main className="login-pane">
        <header className="login-brand">
          <span className="login-brand-mark" aria-hidden="true" />
          <span className="login-brand-name">{TEXT.appName}</span>
        </header>

        <div className="login-scroll">
          <div className="login-content">
            {offerModelSetup ? (
              <div aria-label={TEXT.login.choiceLabel} className="login-tabs" role="tablist">
                <button
                  aria-selected={choice === "account"}
                  className={`login-tab${choice === "account" ? " is-active" : ""}`}
                  onClick={() => setChoice("account")}
                  role="tab"
                  type="button"
                >
                  {TEXT.login.accountTab}
                </button>
                <button
                  aria-selected={choice === "model"}
                  className={`login-tab${choice === "model" ? " is-active" : ""}`}
                  onClick={() => setChoice("model")}
                  role="tab"
                  type="button"
                >
                  {TEXT.login.modelTab}
                </button>
              </div>
            ) : null}

            {choice === "model" && offerModelSetup ? (
              <section>
                <h1>{TEXT.login.modelTitle}</h1>
                <p className="login-lead">{TEXT.login.modelSub}</p>
                {client ? (
                  <div className="login-model-form">
                    <ModelForm
                      client={client}
                      onConfigured={() => onModelConfigured?.()}
                      onProvidersChanged={() => onProvidersChanged?.()}
                      presets={presets}
                      providers={providers}
                      revealSubmitOnSuccess
                      submitLabel={TEXT.login.modelEnter}
                      testLabel={TEXT.wizard.testAndContinue}
                    />
                  </div>
                ) : null}
              </section>
            ) : step === "done" && session ? (
              <section className="login-done">
                <span className="login-done-mark" aria-hidden="true">✓</span>
                <h1>{TEXT.login.doneTitle}</h1>
                <p className="login-lead">
                  {session.isNewUser
                    ? TEXT.login.doneBody(session.displayName, session.balanceCredits)
                    : TEXT.login.doneBodyReturning(session.displayName, session.balanceCredits)}
                </p>
                <div className="login-actions">
                  <button
                    className="primary-button login-wide"
                    onClick={() => onAuthenticated(session, localToken)}
                    type="button"
                  >
                    {TEXT.login.enter}
                  </button>
                  <button className="login-link-button" onClick={signOut} type="button">{TEXT.login.signOut}</button>
                </div>
              </section>
            ) : step === "redirecting" || step === "verifying" ? (
              <section>
                <h1>{TEXT.login.title}</h1>
                <div className="login-status">
                  <span className="login-spinner" aria-hidden="true" />
                  <p className="login-lead">
                    {step === "redirecting" ? TEXT.login.redirecting : TEXT.login.verifying}
                  </p>
                </div>
              </section>
            ) : step === "error" ? (
              <section>
                <h1>{TEXT.login.errorTitle}</h1>
                <p className="login-lead">{TEXT.login.errorBody}</p>
                <div className="login-actions">
                  <button className="primary-button login-wide" onClick={() => setStep("idle")} type="button">
                    {TEXT.login.retry}
                  </button>
                </div>
              </section>
            ) : (
              <section>
                <h1>{TEXT.login.title}</h1>
                <p className="login-lead">{TEXT.login.subtitle}</p>
                <div className="login-actions">
                  <button className="login-huawei-button login-wide" onClick={startSignIn} type="button">
                    <span className="login-huawei-mark" aria-hidden="true">ID</span>{TEXT.login.huaweiButton}
                  </button>
                  <p className="login-consent">{TEXT.login.consent}</p>
                </div>
              </section>
            )}
          </div>
        </div>
      </main>

      <aside className="login-art" aria-hidden="true">
        <div className="login-art-copy">
          <h2>{TEXT.login.brandTitle}</h2>
        </div>
      </aside>
    </div>
  );
}

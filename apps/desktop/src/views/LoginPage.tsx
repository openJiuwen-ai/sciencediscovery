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
  accountsConfigured,
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
/** Which way in the entry gate is showing. The account page is step one and
 *  can be skipped; the model page it leads to cannot. */
type Entry = "account" | "model";

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
  const [entry, setEntry] = useState<Entry>("account");
  const [localToken, setLocalToken] = useState("");
  // Baked at build time, so this never changes while the page is mounted.
  const accountServiceConfigured = accountsConfigured();
  // Settling consumes the ticket and rotates the refresh token, so it must run
  // exactly once per mount.
  const settlementStarted = useRef(false);
  /** The latest callback, read when the sign-in settles: the effect that
   *  exchanges the ticket runs once, while the parent's handler closes over the
   *  boot state of that first render. */
  const onAuthenticatedRef = useRef(onAuthenticated);
  onAuthenticatedRef.current = onAuthenticated;
  /** A sign-in that has settled enters the workspace by itself; this keeps a
   *  second render (or StrictMode's double effect) from calling in twice. */
  const entered = useRef(false);

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

  // A settled sign-in is the whole of step one: the workspace opens as soon as
  // the session and this machine's credential are both in hand, so there is no
  // second "enter" press between a successful sign-in and the workbench.
  useEffect(() => {
    if (step !== "done" || session === undefined || localToken === "" || entered.current) return;
    entered.current = true;
    onAuthenticatedRef.current(session, localToken);
  }, [localToken, session, step]);

  /** The cached-session path can settle without a local credential (the loopback
   *  service was down). Re-run the whole settle rather than only the credential:
   *  the stored access token may need the refresh this page would otherwise skip. */
  function retrySettle(): void {
    window.location.reload();
  }

  /** Leave the recovery panel instead of being stuck on it. The server session
   *  is revoked like the workspace's sign-out; a failure only leaves it to
   *  expire, which is why it is best-effort. */
  function leaveAccount(): void {
    const current = session;
    clearSession();
    setSession(undefined);
    setLocalToken("");
    setStep("idle");
    setEntry("account");
    if (current) void revokeAccountSession(current.accessToken).catch(() => undefined);
  }

  function startSignIn(): void {
    // An empty base cannot start a server-owned sign-in: the navigation would be
    // answered by this app's own static host. The entry renders the "not
    // configured" notice instead, so this is only the guard behind it.
    if (!accountServiceConfigured) return;
    setStep("redirecting");
    // This workbench has no `/login` route: the sign-in page is what `/`
    // renders while the local service credential is missing. Returning to the
    // root keeps the fragment on the page that exchanges the ticket.
    window.location.assign(huaweiSignInUrl(`${window.location.origin}/`));
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
            {entry === "model" && offerModelSetup ? (
              <section>
                <h1>{TEXT.login.modelTitle}</h1>
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
                      trailingAction={
                        <button
                          className="secondary-button"
                          onClick={() => {
                            setStep("idle");
                            setEntry("account");
                          }}
                          type="button"
                        >
                          {TEXT.wizard.back}
                        </button>
                      }
                    />
                  </div>
                ) : null}
              </section>
            ) : step === "done" && session && localToken === "" ? (
              <section>
                <h1>{TEXT.login.title}</h1>
                <p className="login-lead">{TEXT.login.localTokenMissing}</p>
                <div className="login-actions">
                  <button className="primary-button login-wide" onClick={retrySettle} type="button">
                    {TEXT.login.retry}
                  </button>
                  <button className="secondary-button login-wide" onClick={leaveAccount} type="button">
                    {TEXT.account.signOut}
                  </button>
                </div>
              </section>
            ) : step === "done" && session ? (
              <section>
                <h1>{TEXT.login.title}</h1>
                <div className="login-status">
                  <span className="login-spinner" aria-hidden="true" />
                  <p className="login-lead">{TEXT.login.entering}</p>
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
              <section className="login-entry">
                <h1>{TEXT.login.title}</h1>
                <p className="login-lead is-ink">{TEXT.login.subtitle}</p>
                <div className="login-actions login-entry-actions">
                  <button
                    className="login-huawei-button login-entry-primary"
                    disabled={!accountServiceConfigured}
                    onClick={startSignIn}
                    type="button"
                  >
                    <span className="login-huawei-mark" aria-hidden="true">ID</span>{TEXT.login.huaweiButton}
                  </button>
                  {offerModelSetup ? (
                    <button className="login-skip-button" onClick={() => setEntry("model")} type="button">
                      {TEXT.login.skipToModel}
                    </button>
                  ) : null}
                </div>
                {accountServiceConfigured ? null : (
                  // The build carries no account-service base URL, so the button
                  // above cannot reach a sign-in page. Say so here: navigating
                  // anyway is answered by this app's own static host, which reads
                  // as "nothing happened" and lands back on the workspace.
                  <p className="login-notice" role="status">{TEXT.login.accountServiceMissing}</p>
                )}
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

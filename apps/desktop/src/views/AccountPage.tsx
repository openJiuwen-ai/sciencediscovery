/**
 * Account overview for the signed-in HUAWEI ID.
 *
 * Everything here is derived from the account service: credits are the ledger's
 * balance, usage comes from settled model calls, and devices are live sessions.
 * The page never computes a second balance, and it never shows money.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AccountApiError,
  fetchAccountMe,
  fetchAccountUsage,
  huaweiSignInUrl,
  listAccountLedger,
  listAccountSessions,
  revokeAccountDevice,
  updateAccountProfile,
  type AccountLedgerRow,
  type AccountSessionRow,
  type AccountUsageRecord,
} from "../auth/account.js";
import type { UserSession } from "../auth/session.js";
import { TEXT } from "../text.js";
import { SidebarToggle } from "./SidebarToggle.js";

type Filter = "all" | "earned" | "spent";

interface Props {
  account: UserSession;
  onAccountChange: (account: UserSession) => void;
  onSignOut: () => void;
  /** The sidebar's fold control, so this page shares the shell's navigation. */
  onToggleSidebar?: () => void;
  sidebarOpen?: boolean;
}

const WEEK_DAYS = 7;
const DAY_MS = 86_400_000;
const PAGE_SIZES = [10, 30, 50, 100] as const;
/** The ledger endpoint's own ceiling; one request fills several UI pages. */
const LEDGER_CHUNK = 100;
/** Guard against a page number that would walk an unreasonably long ledger. */
const MAX_CHUNK_ROUNDS = 20;

function matchesFilter(row: AccountLedgerRow, filter: Filter): boolean {
  return filter === "all" || (filter === "earned" ? row.delta > 0 : row.delta < 0);
}

function chinaDay(offset = 0, now = Date.now()): string {
  return new Date(now + offset * DAY_MS).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("zh-CN");
}

/** Credits settle per milli-credit, so a charge can be 0.35 and a balance
 *  598.891; flooring would turn that into -1 and 598 on the audit page. */
function formatCredits(value: number): string {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
}

function formatTokens(value: number): string {
  return value >= 10_000 ? `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)}万` : formatNumber(value);
}

/** The ledger's day keys and the server's reward day are both China-local;
 *  comparing against the UTC date of `createdAt` misreads 00:00–08:00. */
function chinaDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

function bizLabel(type: string): string {
  const labels: Record<string, string> = {
    REGISTER: "注册赠送",
    CHECKIN: "每日签到",
    BONUS: "累计签到奖励",
    LLM_USAGE: "模型调用",
    ADMIN: "人工调整",
    REFUND: "退还",
  };
  return labels[type] ?? type;
}

export function AccountPage({
  account,
  onAccountChange,
  onSignOut,
  onToggleSidebar,
  sidebarOpen = true,
}: Props) {
  const [ledger, setLedger] = useState<AccountLedgerRow[]>([]);
  const [ledgerEnd, setLedgerEnd] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const [jump, setJump] = useState("");
  const [sessions, setSessions] = useState<AccountSessionRow[]>([]);
  const [records, setRecords] = useState<AccountUsageRecord[]>([]);
  const [totalEarned, setTotalEarned] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [openRecord, setOpenRecord] = useState<number>();
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(account.displayName);
  const [nameError, setNameError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // The merged record is built from the latest account, but the read itself
  // only depends on the token: depending on the object would make every
  // `onAccountChange` trigger another round of requests.
  const accountRef = useRef(account);
  accountRef.current = account;
  const accessToken = account.accessToken;

  // The ledger is cursor-paginated: the newest-first chunk can be extended as
  // the reader walks to later pages, and the cursor stops at the oldest entry.
  const cursorRef = useRef<number | null>(null);
  const endRef = useRef(false);
  const loadingRef = useRef(false);
  /** The first page is fetched by `load` together with the other account data;
   *  a cursor read starting at the same time would fetch that page again and
   *  append a duplicate copy of the newest rows. */
  const reloadingRef = useRef(false);
  const rowsRef = useRef<AccountLedgerRow[]>([]);
  rowsRef.current = ledger;
  const filterRef = useRef<Filter>(filter);
  filterRef.current = filter;

  const fetchLedgerChunk = useCallback(async (): Promise<AccountLedgerRow[]> => {
    if (loadingRef.current || reloadingRef.current) return [];
    loadingRef.current = true;
    try {
      const chunk = await listAccountLedger(accessToken, LEDGER_CHUNK, cursorRef.current ?? undefined);
      cursorRef.current = chunk.nextBeforeId;
      endRef.current = chunk.nextBeforeId === null;
      setLedgerEnd(endRef.current);
      setLedger((previous) => [...previous, ...chunk.items]);
      return chunk.items;
    } finally {
      loadingRef.current = false;
    }
  }, [accessToken]);

  /** Walk the cursor until the wanted window is covered (or the ledger ends).
   *  Starting from the live rows keeps a jump consistent with what is shown. */
  const ensureRows = useCallback(async (needed: number) => {
    let rows = rowsRef.current;
    for (let round = 0; round < MAX_CHUNK_ROUNDS; round += 1) {
      if (rows.filter((row) => matchesFilter(row, filterRef.current)).length > needed || endRef.current) return;
      // Another pass is already extending the list; it will re-trigger this one.
      if (loadingRef.current) return;
      const chunk = await fetchLedgerChunk();
      if (chunk.length === 0) return;
      rows = [...rows, ...chunk];
    }
  }, [fetchLedgerChunk]);

  const load = useCallback(async () => {
    setError("");
    // A reload starts from the newest entry again. The flag keeps the cursor
    // reader quiet until this first page has landed.
    reloadingRef.current = true;
    cursorRef.current = null;
    endRef.current = false;
    setLedgerEnd(false);
    setLedger([]);
    try {
      const [me, ledgerPage, sessionPage, usage] = await Promise.all([
        fetchAccountMe(accessToken),
        listAccountLedger(accessToken, LEDGER_CHUNK),
        listAccountSessions(accessToken),
        fetchAccountUsage(accessToken),
      ]);
      const current = accountRef.current;
      onAccountChange({
        ...current,
        avatarUrl: me.user.avatarUrl ?? undefined,
        balanceCredits: me.credit.balanceCredits,
        displayName: me.user.displayName?.trim() || current.displayName,
        email: me.user.email?.trim() || undefined,
      });
      cursorRef.current = ledgerPage.nextBeforeId;
      endRef.current = ledgerPage.nextBeforeId === null;
      setLedgerEnd(endRef.current);
      setLedger(ledgerPage.items);
      setSessions(sessionPage.items);
      setRecords(usage.records);
      setTotalEarned(Math.floor(me.credit.totalEarnedCredits));
    } catch (reason) {
      if (reason instanceof AccountApiError && reason.denied) onSignOut();
      else setError(reason instanceof Error ? reason.message : TEXT.account.loadFailed);
    } finally {
      reloadingRef.current = false;
    }
  }, [accessToken, onAccountChange, onSignOut]);

  useEffect(() => {
    void load();
  }, [load]);

  const balance = account.balanceCredits;
  const tokenEstimate = balance * 40_000;
  const today = chinaDay();
  const checkedInToday = ledger.some((row) => row.bizType === "CHECKIN" && chinaDate(row.createdAt) === today);
  // Seven slots name the reward each accumulated day pays. Day one is the
  // registration grant plus the first daily reward; the seventh adds 50.
  const cycle = ledger.filter((row) => row.bizType === "CHECKIN").length % WEEK_DAYS;
  const remaining = cycle === 0 ? WEEK_DAYS : WEEK_DAYS - cycle;

  const filteredAll = useMemo(
    () => ledger.filter((row) => matchesFilter(row, filter)),
    [filter, ledger],
  );

  // `pageCount` stays unknown until the cursor reaches the oldest entry, so the
  // pager shows just the current page until the end is known.
  const pageCount = ledgerEnd ? Math.max(1, Math.ceil(filteredAll.length / pageSize)) : undefined;
  const pageRows = filteredAll.slice((page - 1) * pageSize, page * pageSize);
  const hasNext = filteredAll.length > page * pageSize || !ledgerEnd;

  // Fetch ahead whenever the window asks for rows not yet loaded.
  useEffect(() => {
    void ensureRows(page * pageSize + 1);
  }, [ensureRows, filter, ledger.length, page, pageSize]);

  // A filter change starts a new list, and a shorter ledger pulls the reader
  // back to a page that exists.
  useEffect(() => {
    setPage(1);
  }, [filter]);
  useEffect(() => {
    if (pageCount !== undefined && page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const goToPage = (target: number) => {
    const next = Math.max(1, Math.floor(target));
    setPage(pageCount === undefined ? next : Math.min(next, pageCount));
  };
  const jumpToPage = () => {
    const target = Number(jump);
    if (Number.isFinite(target) && target >= 1) goToPage(target);
    setJump("");
  };

  // The page shows one spend figure, and it is the one the user can check:
  // everything granted minus what is still available. Summing the loaded
  // ledger rows would stop at the page size and disagree with itself.
  const totalSpent = Math.max(0, totalEarned - balance);

  async function saveName(): Promise<void> {
    const next = name.trim();
    if (next.length < 1 || next.length > 24) {
      setNameError(TEXT.account.nameInvalid);
      return;
    }
    setBusy(true);
    setNameError("");
    try {
      const user = await updateAccountProfile(accessToken, { displayName: next });
      onAccountChange({ ...accountRef.current, displayName: user.displayName?.trim() || next });
      setName(next);
      setEditingName(false);
    } catch (reason) {
      setNameError(reason instanceof Error ? reason.message : TEXT.account.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(session: AccountSessionRow): Promise<void> {
    if (session.current) return;
    setBusy(true);
    try {
      await revokeAccountDevice(account.accessToken, session.id);
      setSessions((items) => items.filter((item) => item.id !== session.id));
      setNotice(TEXT.account.deviceRevoked);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : TEXT.account.deviceRevokeFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`account-page${sidebarOpen ? "" : " is-sidebar-collapsed"}`}>
      {sidebarOpen || !onToggleSidebar ? null : (
        <div className="account-topbar">
          <SidebarToggle onClick={onToggleSidebar} open={false} />
        </div>
      )}

      <div className="account-scroll">
        <header className="account-hero">
          <div className="account-hero-person">
            <span aria-hidden="true" className="account-hero-avatar">
              {account.avatarUrl ? <img alt="" src={account.avatarUrl} /> : account.displayName.trim().slice(0, 1).toUpperCase()}
            </span>
            <p className="account-eyebrow">{TEXT.account.eyebrow}</p>
          </div>
          <div className="account-hero-name">
            {editingName ? (
              <div className="account-name-editor">
                <input
                  autoFocus
                  className="field-input account-name-input"
                  maxLength={24}
                  onChange={(event) => { setName(event.target.value); setNameError(""); }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveName();
                    if (event.key === "Escape") {
                      setEditingName(false);
                      setName(account.displayName);
                      setNameError("");
                    }
                  }}
                  value={name}
                />
                <button
                  className="account-save"
                  disabled={busy || name.trim() === account.displayName || name.trim().length < 1}
                  onClick={() => void saveName()}
                  type="button"
                >
                  {TEXT.account.saveShort}
                </button>
              </div>
            ) : (
              <div className="account-name-view">
                <h1>{account.displayName}</h1>
                <button
                  aria-label={TEXT.account.editName}
                  className="account-name-edit"
                  onClick={() => {
                    setName(account.displayName);
                    setNameError("");
                    setEditingName(true);
                  }}
                  title={TEXT.account.editName}
                  type="button"
                >
                  <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="15">
                    <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
                  </svg>
                </button>
              </div>
            )}
            {nameError ? <small className="account-field-error">{nameError}</small> : null}
          </div>
        </header>

        {error ? <p className="account-error" role="alert">{error}</p> : null}
        {notice ? <p className="account-notice" role="status">{notice}</p> : null}

        <section className="account-metrics">
          <div className="account-metric is-primary">
            <span>{TEXT.account.available}</span>
            <strong>{formatCredits(balance)}</strong>
            <small>{TEXT.account.creditsUnit}</small>
          </div>
          <div className="account-metric">
            <span>{TEXT.account.tokenEstimate}</span>
            <strong>{formatTokens(tokenEstimate)}</strong>
            <small>{TEXT.account.tokensUnit}</small>
          </div>
          <div className="account-metric">
            <span>{TEXT.account.earned}</span>
            <strong>{formatCredits(totalEarned)}</strong>
          </div>
          <div className="account-metric">
            <span>{TEXT.account.spent}</span>
            <strong>{formatCredits(totalSpent)}</strong>
          </div>
        </section>

        <section className="account-section">
          <div className="account-section-head">
            <h2>{TEXT.account.rewardTitle}</h2>
            <span>{checkedInToday ? TEXT.account.rewardToday : TEXT.account.rewardPending}</span>
          </div>
          <div className="account-reward-days">
            {Array.from({ length: WEEK_DAYS }, (_, index) => (
              <div className={`account-reward-day${index < cycle ? " is-done" : ""}${index === cycle ? " is-today" : ""}`} key={index}>
                <span>{TEXT.account.day(index + 1)}</span>
                <strong>{index === 0 ? 600 : index === 6 ? "+50" : 100}</strong>
              </div>
            ))}
          </div>
          <p className="account-hint">{TEXT.account.rewardHint(remaining)}</p>
        </section>

        <section className="account-section">
          <div className="account-section-head">
            <h2>{TEXT.account.ledgerTitle}</h2>
            <div className="account-filter" role="group" aria-label={TEXT.account.ledgerTitle}>
              {(["all", "earned", "spent"] as const).map((item) => (
                <button aria-pressed={filter === item} className={filter === item ? "active" : ""} key={item} onClick={() => setFilter(item)} type="button">
                  {TEXT.account.filter[item]}
                </button>
              ))}
            </div>
          </div>
          <div className="account-ledger">
            {filteredAll.length === 0 ? <p className="account-empty">{TEXT.account.ledgerEmpty}</p> : null}
            {pageRows.map((row) => {
              const usage = records.find((record) => record.createdAt === row.createdAt && record.creditsUsed === -row.delta);
              return (
                <div className="account-ledger-group" key={row.id}>
                  <button
                    className="account-ledger-row"
                    disabled={!usage}
                    onClick={() => setOpenRecord((current) => current === row.id ? undefined : row.id)}
                    type="button"
                  >
                    <span className="account-ledger-type">{bizLabel(row.bizType)}<small>{formatTime(row.createdAt)}</small></span>
                    <span className={`account-ledger-delta${row.delta > 0 ? " is-plus" : ""}`}>{row.delta > 0 ? "+" : ""}{formatCredits(row.deltaCredits)}</span>
                    <span className="account-ledger-balance">{TEXT.account.afterBalance(formatCredits(row.balanceAfterCredits))}</span>
                  </button>
                  {usage && openRecord === row.id ? (
                    <div className="account-ledger-detail">
                      <span>{TEXT.account.model} <strong>{usage.model}</strong></span>
                      <span>{TEXT.account.input} {formatNumber(usage.inputTokens)}</span>
                      <span>{TEXT.account.cached} {formatNumber(usage.cachedTokens)}</span>
                      <span>{TEXT.account.output} {formatNumber(usage.outputTokens)}</span>
                      <span>{TEXT.account.latency} {usage.latencyMs === null ? "—" : `${usage.latencyMs} ms`}</span>
                      <span>{TEXT.account.tokensTotal} {formatNumber(usage.inputTokens + usage.outputTokens)}</span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="account-pager">
            <label className="account-page-size">
              {TEXT.account.perPage}
              <select
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
                value={pageSize}
              >
                {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
              {TEXT.account.perPageUnit}
            </label>
            <span className="account-page-status">
              {pageCount === undefined ? TEXT.account.pageCurrent(page) : TEXT.account.pageOf(page, pageCount)}
            </span>
            <div className="account-page-nav">
              <button disabled={page <= 1} onClick={() => goToPage(page - 1)} type="button">{TEXT.account.prevPage}</button>
              <button disabled={!hasNext} onClick={() => goToPage(page + 1)} type="button">{TEXT.account.nextPage}</button>
              <label className="account-page-jump">
                {TEXT.account.jumpTo}
                <input
                  min={1}
                  onChange={(event) => setJump(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") jumpToPage();
                  }}
                  type="number"
                  value={jump}
                />
                {TEXT.account.jumpUnit}
                <button onClick={jumpToPage} type="button">{TEXT.account.jump}</button>
              </label>
            </div>
          </div>
        </section>

        <section className="account-section">
          <div className="account-section-head"><h2>{TEXT.account.devicesTitle}</h2></div>
          <div className="account-devices">
            {sessions.filter((session) => !session.revokedAt && (session.current || session.online)).map((session) => (
              <div className="account-device" key={session.id}>
                <span className="account-device-name">
                  {session.platformLabel}
                  {session.current ? <em>{TEXT.account.currentDevice}</em> : null}
                </span>
                <span className="account-device-meta">{TEXT.account.signedInAt(formatTime(session.createdAt))}</span>
                {session.current
                  ? null
                  : <button className="account-secondary" disabled={busy} onClick={() => void revoke(session)} type="button">{TEXT.account.revokeDevice}</button>}
              </div>
            ))}
          </div>
        </section>

        <footer className="account-footer">
          <button className="account-signout" onClick={onSignOut} type="button">{TEXT.account.signOut}</button>
        </footer>
      </div>
    </div>
  );
}

/**
 * The account surface while nobody is signed in: a grey avatar and the one
 * action that changes that. The workspace stays behind it — a custom-model
 * workspace keeps working without an account, and signing in can wait.
 */
export function SignedOutAccount({ pending = false }: { pending?: boolean }) {
  return (
    <div className="account-page">
      <div className="account-scroll">
        <div className="account-signedout">
          <span className="account-hero-avatar is-guest" aria-hidden="true">
            <svg
              fill="none"
              height="28"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.6"
              viewBox="0 0 24 24"
              width="28"
            >
              <circle cx="12" cy="8" r="3.4" />
              <path d="M5.5 19.2c.9-3 3.4-4.7 6.5-4.7s5.6 1.7 6.5 4.7" />
            </svg>
          </span>
          {pending ? (
            // The HUAWEI callback is being exchanged: this panel is where the
            // sign-in started, so it is also where the wait belongs.
            <p className="account-signin-pending">
              <span className="login-spinner" aria-hidden="true" />
              {TEXT.login.verifying}
            </p>
          ) : (
            <button
              className="login-huawei-button account-signin"
              // `?account=1` is how the panel survives the full-page redirect:
              // the shell reads it back and reopens these details after signing in.
              onClick={() => window.location.assign(huaweiSignInUrl(`${window.location.origin}/?account=1`))}
              type="button"
            >
              <span className="login-huawei-mark" aria-hidden="true">ID</span>{TEXT.login.huaweiButton}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

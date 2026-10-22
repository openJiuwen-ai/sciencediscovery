// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@sciencediscovery/schema";
import type { ApiClient } from "../api.js";
import { BranchIcon, EllipsisIcon } from "../icons.js";
import { useLocale } from "../i18n/index.js";
import { useAnchoredPopover } from "./ManagementControls.js";

export const messageAnchorId = (messageId: string) => `chat-message-${messageId}`;

export function ForkMessageButton({ client, sessionId, messageId, disabled, onCreated }: {
  client: ApiClient; sessionId: string; messageId: string; disabled?: boolean;
  onCreated: (sessionIds: string[], entrySessionId: string) => Promise<void>;
}) {
  const { t } = useLocale();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const mounted = useRef(true);
  const requestRef = useRef<string | undefined>(undefined);
  const { triggerRef, popoverRef, style } = useAnchoredPopover(open);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (open && style.visibility === "visible") popoverRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, style.visibility, popoverRef]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !popoverRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
      if (event.key === "Tab") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open, popoverRef, triggerRef]);

  const fork = async () => {
    if (running.current || disabled) return;
    running.current = true; setBusy(true); setError(undefined); setOpen(false);
    const key = `conversation-branch:${sessionId}:${messageId}`;
    const forget = () => { requestRef.current = undefined; try { localStorage.removeItem(key); } catch { /* Storage may be unavailable. */ } };
    try {
      try { requestRef.current ??= localStorage.getItem(key) ?? undefined; } catch { /* Keep retry identity in memory. */ }
      const requestId = requestRef.current ??= crypto.randomUUID();
      try { localStorage.setItem(key, requestId); } catch { /* The in-memory key still prevents duplicates. */ }
      let operation = await client.createConversationBranch(sessionId, messageId, requestId);
      while (operation.state === "copying" && mounted.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        if (!mounted.current) return;
        operation = await client.getResearchContinuation(sessionId, operation.id);
      }
      if (!mounted.current) return;
      if (operation.state === "failed") { forget(); throw new Error(operation.error || t("branch.failed")); }
      if (!operation.entrySessionId || !operation.sessionIds?.length) throw new Error(t("branch.failed"));
      await onCreated(operation.sessionIds, operation.entrySessionId);
      forget();
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : t("branch.failed"));
    } finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  return <span className="message-fork-action" aria-busy={busy}>
    <button className="icon-button message-more-button" type="button" ref={triggerRef}
      aria-label={t("branch.more")} title={t("branch.more")} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      disabled={busy} onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}><EllipsisIcon size={16} /></button>
    {busy ? <span className="message-branch-status" role="status">{t("branch.creating")}</span> : null}
    {error ? <span className="message-branch-error" role="alert">{error} <button type="button" className="text-button" disabled={disabled} onClick={() => void fork()}>{t("branch.retry")}</button></span> : null}
    {open ? createPortal(<div id={menuId} role="menu" ref={popoverRef} style={style} className="resource-menu-popover message-branch-menu">
      <button type="button" role="menuitem" disabled={disabled} title={disabled ? t("branch.wait") : undefined} onClick={() => { triggerRef.current?.focus(); void fork(); }}><BranchIcon size={15} />{t("branch.fork")}</button>
      {disabled ? <small>{t("branch.wait")}</small> : null}
    </div>, document.body) : null}
  </span>;
}

export function ConversationBranchBoundary({ branch, onReturn }: {
  branch: NonNullable<Session["conversationBranch"]>; onReturn: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const returning = useRef(false);
  return <div className="conversation-branch-boundary">
    <div className="conversation-branch-divider"><span aria-hidden="true" /><button type="button" disabled={busy}
      onClick={() => {
        if (returning.current) return;
        returning.current = true; setBusy(true); setError(undefined);
        void onReturn().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t("branch.sourceUnavailable")))
          .finally(() => { returning.current = false; setBusy(false); });
      }}><BranchIcon size={15} />{t("branch.return")}</button><span aria-hidden="true" /></div>
    {error ? <p className="message-branch-error" role="alert">{error}</p> : null}
    {branch.omissions.length ? <details className="conversation-branch-scope"><summary>{t("branch.scope")}</summary><ul>{branch.omissions.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
  </div>;
}

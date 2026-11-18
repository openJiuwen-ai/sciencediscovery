// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TurnUsageData } from "../app/use-turn-usage.js";
import { useLanguage } from "../app/use-language.js";
import { TEXT } from "../text.js";
import { leavesMenu } from "./RowMenu.js";
import { modelLabel } from "./provider-name.js";

function reported(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function tokens(value: number | null | undefined, compact = false) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? TEXT.conversation.usage.unreported
    : `${new Intl.NumberFormat("en-US", compact ? { notation: "compact", maximumFractionDigits: 1 } : {}).format(value)} tok`;
}

export function TurnUsageDetails({ data }: { data: TurnUsageData }) {
  const text = TEXT.conversation.usage;
  const fields = [
    [text.input, data.bucket.inputTokens], [text.output, data.bucket.outputTokens],
    [text.cacheRead, data.bucket.cacheReadTokens], [text.cacheWrite, data.bucket.cacheWriteTokens],
    ...(data.bucket.reasoningTokens == null ? [] : [[text.reasoning, data.bucket.reasoningTokens] as const]),
  ] as const;
  return <>
    {data.models.length ? <div className="turn-usage-models"><span>{text.models}</span><span>{[...new Set(data.models.map(modelLabel))].join(" / ")}</span></div> : null}
    <dl>{fields.map(([label, value]) => reported(value) ? <div key={label}><dt>{label}</dt><dd>{tokens(value)}</dd></div> : null)}</dl>
    {data.incomplete ? <p>{text.incomplete}</p> : null}
  </>;
}

export function TurnUsage({ data, loading, failed, onRefresh }: {
  data?: TurnUsageData; loading: boolean; failed: boolean; onRefresh: () => void;
}) {
  useLanguage();
  const text = TEXT.conversation.usage;
  const [anchor, setAnchor] = useState<HTMLButtonElement>();
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => setAnchor(undefined), []);
  useEffect(() => {
    if (!anchor) return;
    const dismiss = (event: Event) => { if (leavesMenu(event.target, panel.current, anchor)) close(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { close(); anchor.focus(); }
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", close);
    };
  }, [anchor, close]);
  useLayoutEffect(() => {
    if (!anchor || !panel.current) return;
    const trigger = anchor.getBoundingClientRect();
    const box = panel.current.getBoundingClientRect();
    panel.current.style.left = `${Math.max(8, Math.min(trigger.left, window.innerWidth - box.width - 8))}px`;
    panel.current.style.top = `${Math.max(8, trigger.top - box.height - 8 >= 8
      ? trigger.top - box.height - 8 : Math.min(trigger.bottom + 8, window.innerHeight - box.height - 8))}px`;
  }, [anchor, data, failed, loading]);
  if (!data && !failed && !loading) return null;
  const details = anchor ? <div className="turn-usage-panel" id={id} ref={panel} role="dialog" aria-label={text.heading}>
    <div className="turn-usage-heading"><strong>{text.heading}</strong>{reported(data?.bucket.totalTokens) ? <strong>{tokens(data.bucket.totalTokens)}</strong> : null}</div>
    {data ? <TurnUsageDetails data={data} /> : null}
    {loading ? <p role="status">{text.loading}</p> : null}
    {failed ? <div className="turn-usage-error" role="alert"><span>{text.failed}</span>
      <button type="button" disabled={loading} onClick={onRefresh}>{text.retry}</button></div> : null}
  </div> : null;
  return <>
    <button className="answer-tool turn-usage-trigger" type="button" aria-expanded={Boolean(anchor)} aria-controls={anchor ? id : undefined}
      aria-haspopup="dialog" aria-label={text.heading} onClick={event => setAnchor(anchor ? undefined : event.currentTarget)}>
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" />
      </svg>
      <span>{text.label}{reported(data?.bucket.totalTokens) ? ` ${tokens(data.bucket.totalTokens, true)}` : ""}</span>
    </button>
    {details ? createPortal(details, document.body) : null}
  </>;
}

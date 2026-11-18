// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * One durable export record, drawn the same way wherever history is shown: the
 * row the export dialog keeps under 已保存的会话包 and the 设置 › 导出记录 list
 * (#1154).
 *
 * The row never holds a filesystem path — the shell keeps it — so everything it
 * offers is token-bound: 打开文件位置 asks the shell to reveal the token, and a
 * row whose file is gone says so and can only be removed.
 */

import { formatBytes } from "../app/format-bytes.js";
import type { ExportHistoryRow } from "../app/export-bridge.js";
import { TEXT } from "../text.js";
import "../styles/export-history.css";

/** Local time for a saved export, or the raw stamp when it cannot be parsed. */
export function exportSavedAt(savedAt: string, locale: string): string {
  const at = Date.parse(savedAt);
  if (Number.isNaN(at)) return savedAt;
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(at));
}

export function ExportHistoryList({
  locale,
  onForget,
  onReveal,
  rows,
}: {
  locale: string;
  onForget: (row: ExportHistoryRow) => void;
  onReveal: (row: ExportHistoryRow) => void;
  rows: ExportHistoryRow[];
}) {
  const t = TEXT.exportHistory;
  return (
    <ul className="export-history">
      {rows.map((row) => (
        <li className={row.exists ? "export-history-row" : "export-history-row is-missing"} key={row.id}>
          <span aria-hidden="true" className="export-history-glyph"><svg fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" viewBox="0 0 24 24" width="16"><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v5h4" /></svg></span>
          <span className="export-history-main">
            <span className="export-history-name" title={row.filename}>{row.filename}</span>
            <span className="export-history-meta">
              <span>{formatBytes(row.bytes)}</span>
              <span aria-hidden="true">·</span>
              <span>{exportSavedAt(row.savedAt, locale)}</span>
              {row.sessionTitle ? <><span aria-hidden="true">·</span><span className="export-history-session" title={row.sessionTitle}>{row.sessionTitle}</span></> : null}
            </span>
            <span className="export-history-destination" title={row.directory}>{row.directory}</span>
          </span>
          <span className="export-history-actions">
            {row.exists ? (
              <button aria-label={t.reveal} className="export-history-icon" onClick={() => onReveal(row)} title={t.reveal} type="button">
                <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="15">
                  <path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <path d="M9 13h6M12 10.5v5" />
                </svg>
              </button>
            ) : (
              <span className="is-warning">{t.missing}</span>
            )}
            <button aria-label={t.forget} className="export-history-icon" onClick={() => onForget(row)} title={t.forget} type="button">
              <svg aria-hidden="true" fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="15">
                <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
                <path d="M10 11v6M14 11v6" />
              </svg>
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

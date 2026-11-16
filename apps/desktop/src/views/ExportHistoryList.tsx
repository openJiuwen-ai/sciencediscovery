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

import type { ExportHistoryRow } from "../app/export-bridge.js";
import { TEXT } from "../text.js";
import "../styles/export-history.css";

/** Human size for a package: bytes under 1 KB, then KB/MB with one decimal. */
export function exportSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

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
          <span className="export-history-name" title={row.filename}>{row.filename}</span>
          <span className="export-history-meta">
            <span>{exportSize(row.bytes)}</span>
            <span aria-hidden="true">·</span>
            <span>{exportSavedAt(row.savedAt, locale)}</span>
            {row.sessionTitle ? <><span aria-hidden="true">·</span><span className="export-history-session" title={row.sessionTitle}>{row.sessionTitle}</span></> : null}
          </span>
          <span className="export-history-destination" title={row.directory}>{row.directory}</span>
          <span className="export-history-actions">
            {row.exists ? (
              <button onClick={() => onReveal(row)} type="button">{t.reveal}</button>
            ) : (
              <span className="is-warning">{t.missing}</span>
            )}
            <button onClick={() => onForget(row)} type="button">{t.forget}</button>
          </span>
        </li>
      ))}
    </ul>
  );
}

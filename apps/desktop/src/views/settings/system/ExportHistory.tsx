// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * 设置 › 导出记录: every study package this machine has saved, across projects
 * and sessions, with the two things the row can still do — reveal the file and
 * forget the record (#1154).
 *
 * The list is the shell's: in a browser there is no token to reveal and no file
 * the product wrote, so the pane says so instead of inventing a second,
 * differently-behaving history in localStorage.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project } from "../../../api/types.js";
import { exportHistoryBridge, type ExportHistoryRow } from "../../../app/export-bridge.js";
import { TEXT } from "../../../text.js";
import { ExportHistoryList } from "../../ExportHistoryList.js";
import "../../../styles/export-history.css";

export function ExportHistorySettings({ projects }: { projects: Project[] }) {
  const t = TEXT.exportHistory;
  const bridge = exportHistoryBridge();
  const [rows, setRows] = useState<ExportHistoryRow[]>([]);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("all");
  const [notice, setNotice] = useState<string | undefined>();

  const load = useCallback(async () => {
    if (!bridge) return;
    try {
      setRows(await bridge.list());
    } catch {
      setRows([]);
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (project !== "all" && row.projectId !== project) return false;
      if (!needle) return true;
      return row.filename.toLowerCase().includes(needle)
        || (row.sessionTitle ?? "").toLowerCase().includes(needle);
    });
  }, [project, query, rows]);

  if (!bridge) return <p className="settings-hint">{t.unavailable}</p>;

  const reveal = async (row: ExportHistoryRow) => {
    setNotice(undefined);
    try {
      const result = await bridge.reveal(row.token);
      if (result.missing) {
        setNotice(t.revealMissing);
        await load();
      }
    } catch {
      setNotice(t.revealMissing);
      await load();
    }
  };

  const forget = async (row: ExportHistoryRow) => {
    try {
      await bridge.forget(row.id);
    } finally {
      await load();
    }
  };

  return (
    <section className="export-history-settings">
      <h3>{t.heading}</h3>
      <div className="export-history-filters">
        <input
          aria-label={t.searchPlaceholder}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.searchPlaceholder}
          type="search"
          value={query}
        />
        <select aria-label={t.allProjects} onChange={(event) => setProject(event.target.value)} value={project}>
          <option value="all">{t.allProjects}</option>
          {projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </div>
      {notice ? <p className="export-history-notice" role="status">{notice}</p> : null}
      {visible.length > 0 ? (
        <ExportHistoryList locale={TEXT.languageTag} onForget={(row) => void forget(row)} onReveal={(row) => void reveal(row)} rows={visible} />
      ) : (
        <p className="settings-hint">{rows.length === 0 ? t.empty : t.noMatch}</p>
      )}
    </section>
  );
}

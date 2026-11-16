// Durable record of finished study-package exports.
//
// The in-memory `ExportDestinations` map only lives as long as the process: a
// package exported yesterday can only be found again by remembering which
// folder the OS save dialog used. This store keeps the finished exports — one
// row per export task, with the opaque token the main process issued for it —
// in `export-history.json` under the shell's userData, with the same
// temp-file-then-rename discipline as export-state.ts / window-state.ts.
//
// Only the main process reads or writes the file: the path stays here, the
// renderer gets the metadata and the token it may reveal with.
//
// Pure functions/class, no Electron import: unit-tested without a host.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ExportHistoryRecord {
  /** The export task id: the row's identity. Re-saving the same task updates
   *  this row rather than adding a second one, even though a new save issues a
   *  new token. */
  id: string;
  /** Opaque destination token; resolves to `path` while this row is listed. */
  token: string;
  /** Absolute path the user picked. Only the main process reads this. */
  path: string;
  filename: string;
  bytes: number;
  /** ISO time of the write that produced the file. */
  savedAt: string;
  projectId?: string;
  sessionId?: string;
  sessionTitle?: string;
  /** The package profile the export was taken at, so 重新保存 can repeat it. */
  level?: "necessary" | "complete";
}

interface ExportHistoryFile {
  version: 1;
  records: ExportHistoryRecord[];
}

/** Where the list is kept. */
export function exportHistoryFile(userData: string): string {
  return join(userData, "export-history.json");
}

/** Newest first, and never more rows than this. Eviction drops the record, not
 *  the user's file: this store does not own anything on disk but its own JSON. */
export const EXPORT_HISTORY_LIMIT = 200;

function isRecord(value: unknown): value is ExportHistoryRecord {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && row.id.trim() !== ""
    && typeof row.token === "string" && row.token.trim() !== ""
    && typeof row.path === "string" && row.path.trim() !== ""
    && typeof row.filename === "string"
    && typeof row.bytes === "number" && Number.isFinite(row.bytes)
    && typeof row.savedAt === "string";
}

function sanitize(records: unknown): ExportHistoryRecord[] {
  if (!Array.isArray(records)) return [];
  const rows = records.filter(isRecord).map((row) => ({
    bytes: row.bytes,
    filename: row.filename,
    id: row.id,
    path: row.path,
    savedAt: row.savedAt,
    token: row.token,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.sessionTitle ? { sessionTitle: row.sessionTitle } : {}),
    ...(row.level === "necessary" || row.level === "complete" ? { level: row.level } : {}),
  }));
  return rows.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
}

/** The whole list, or empty for a missing/corrupt file: a broken history must
 *  not stop the app from starting, and it carries no data worth recovering. */
export function loadExportHistory(userData: string): ExportHistoryRecord[] {
  try {
    const raw = JSON.parse(readFileSync(exportHistoryFile(userData), "utf8")) as Partial<ExportHistoryFile>;
    return sanitize(raw.records).slice(0, EXPORT_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** Atomic-ish write via temp file + rename (window-state.ts pattern). */
export function saveExportHistory(userData: string, records: ExportHistoryRecord[]): void {
  const target = exportHistoryFile(userData);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  const payload: ExportHistoryFile = { version: 1, records: records.slice(0, EXPORT_HISTORY_LIMIT) };
  writeFileSync(tmp, JSON.stringify(payload), "utf8");
  renameSync(tmp, target);
}

export class ExportHistoryStore {
  private readonly limit: number;
  private readonly userData: string;
  private rows: ExportHistoryRecord[];

  constructor(userData: string, limit = EXPORT_HISTORY_LIMIT) {
    this.userData = userData;
    this.limit = limit;
    this.rows = loadExportHistory(userData).slice(0, limit);
  }

  /** Newest first. */
  list(): ExportHistoryRecord[] {
    return this.rows.map((row) => ({ ...row }));
  }

  /** Add a finished export, or update the row of the same task (a re-save). */
  record(input: ExportHistoryRecord): ExportHistoryRecord {
    const row: ExportHistoryRecord = { ...input };
    const at = this.rows.findIndex((existing) => existing.id === row.id);
    if (at >= 0) this.rows.splice(at, 1);
    this.rows.unshift(row);
    if (this.rows.length > this.limit) this.rows = this.rows.slice(0, this.limit);
    this.persist();
    return { ...row };
  }

  /** Drop one row (移除记录). Returns whether it was there. */
  forget(id: string): boolean {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.id !== id);
    if (this.rows.length === before) return false;
    this.persist();
    return true;
  }

  /** The row holding a token, for reveal-after-restart. */
  byToken(token: string): ExportHistoryRecord | undefined {
    const row = this.rows.find((entry) => entry.token === token);
    return row ? { ...row } : undefined;
  }

  private persist(): void {
    saveExportHistory(this.userData, this.rows);
  }
}

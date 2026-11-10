// Last export destination persistence: the save dialog reopens at the folder
// the user last saved into, so the "next export defaults to the last chosen
// path" behaviour survives an app restart. Same self-managed JSON discipline
// as window-state.ts / wizard-state.ts (one read/write pair, no dependency).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ExportState {
  /** Directory the last confirmed export was saved into (no filename). */
  lastExportDir?: string;
}

export function exportStateFile(userData: string): string {
  return join(userData, "export-state.json");
}

export function loadExportState(userData: string): ExportState | null {
  try {
    const raw = JSON.parse(readFileSync(exportStateFile(userData), "utf8")) as Partial<ExportState>;
    if (typeof raw.lastExportDir === "string" && raw.lastExportDir.trim()) {
      return { lastExportDir: raw.lastExportDir.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

/** Atomic-ish write via temp file + rename (window-state.ts pattern). */
export function saveExportState(userData: string, state: ExportState): void {
  const target = exportStateFile(userData);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf8");
  renameSync(tmp, target);
}
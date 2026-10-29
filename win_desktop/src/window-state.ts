// Window bounds persistence: tiny JSON file in userData. Self-managed instead
// of electron-store: one read/write function is all this needs, no dependency.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

export function stateFile(userData: string): string {
  return join(userData, "window-state.json");
}

export function loadWindowState(userData: string): WindowBounds {
  try {
    const raw = JSON.parse(readFileSync(stateFile(userData), "utf8")) as Partial<WindowBounds>;
    const width = Number(raw.width);
    const height = Number(raw.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width >= 800 && height >= 600) {
      return {
        width: Math.round(width),
        height: Math.round(height),
        x: Number.isFinite(Number(raw.x)) ? Math.round(Number(raw.x)) : undefined,
        y: Number.isFinite(Number(raw.y)) ? Math.round(Number(raw.y)) : undefined,
        maximized: raw.maximized === true,
      };
    }
  } catch {
    /* missing or corrupt: fall through to default */
  }
  return { width: 1440, height: 900 };
}

/** Atomic-ish write via temp file + rename. */
export function saveWindowState(userData: string, bounds: WindowBounds): void {
  const target = stateFile(userData);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(bounds), "utf8");
  renameSync(tmp, target);
}

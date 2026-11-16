// First-run wizard state: step persistence so a half-finished wizard
// resumes where it left off. Same self-managed JSON discipline as
// window-state.ts (one read/write function, no dependency).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The wizard's model-config step is gone (just-in-time configuration —
 * the user configures models from the main UI after entering the system).
 * "starting" = data dir confirmed, backend boot/self-check in progress.
 * "model" = backend self-check passed, waiting for optional model configuration.
 */
export type WizardStep = "data-dir" | "starting" | "model" | "done";

export interface WizardState {
  step: WizardStep;
  /** Chosen backend data directory; required once step moves past "data-dir". */
  dataDir?: string;
  /** Stack child pid recorded at spawn time, so a resumed session waits for
   * (instead of duplicating) a first spawn that is still running. */
  stackPid?: number;
  /** Port epoch the wizard-spawned stack was started on. */
  epoch?: number;
  completedAt?: string;
}

export function wizardStateFile(userData: string): string {
  return join(userData, "wizard-state.json");
}

/** Missing/corrupt/unfinished state → the wizard must run (or resume). */
export function needsWizard(state: WizardState | null): boolean {
  return state === null || state.step !== "done";
}

export function loadWizardState(userData: string): WizardState | null {
  let raw: Partial<WizardState>;
  try {
    raw = JSON.parse(readFileSync(wizardStateFile(userData), "utf8")) as Partial<WizardState>;
  } catch {
    return null;
  }
  // "model" is a valid resumable step again (optional model config).
  const step = raw.step;
  if (step !== "data-dir" && step !== "starting" && step !== "model" && step !== "done") return null;
  const dataDir = typeof raw.dataDir === "string" && raw.dataDir.trim() ? raw.dataDir.trim() : undefined;
  // Past step 1 without a data dir the state is unusable (the stack cannot be
  // spawned nor the token found) — restart the wizard from scratch.
  if (step !== "data-dir" && !dataDir) return null;
  return {
    step,
    ...(dataDir ? { dataDir } : {}),
    ...(typeof raw.stackPid === "number" && Number.isInteger(raw.stackPid) && raw.stackPid > 0
      ? { stackPid: raw.stackPid } : {}),
    ...(typeof raw.epoch === "number" && Number.isInteger(raw.epoch) && raw.epoch >= 0
      ? { epoch: raw.epoch } : {}),
    ...(raw.step === "done" && typeof raw.completedAt === "string" ? { completedAt: raw.completedAt } : {}),
  };
}

/** Atomic-ish write via temp file + rename (window-state.ts pattern). */
export function saveWizardState(userData: string, state: WizardState): void {
  const target = wizardStateFile(userData);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf8");
  renameSync(tmp, target);
  // Plain-text mirror of the chosen data dir for the NSIS uninstaller's
  // "also delete user data" prompt (NSIS has no JSON). Keep in sync with
  // build/installer.nsh (customUnInstall).
  if (state.dataDir) {
    writeFileSync(join(dirname(target), "data-dir.txt"), state.dataDir + "\n", "utf8");
  }
}

/**
 * The data dir the stack must run with: the wizard's persisted choice wins
 * (the shell owns this explicitly); otherwise the legacy env path
 * (dev machines) — null means "let start-stack pick its own default".
 */
export function effectiveDataDir(env: NodeJS.ProcessEnv, state: WizardState | null): string | null {
  if (state?.dataDir?.trim()) return state.dataDir.trim();
  const fromEnv = env.SCIENCE_DISCOVERY_DATA_DIR?.trim();
  return fromEnv || null;
}

/** Best-effort liveness probe for the recorded stack pid (crash-resume case). */
export function pidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

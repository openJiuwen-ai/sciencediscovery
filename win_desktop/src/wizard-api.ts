// Wizard backend API calls (the model-config step was removed — models are
// configured from the main UI after entering the system, so the
// wizard ships only the final self-check). All decisions pure: fetch is
// injected, no Electron imports.
//
// Contracts verified against services/api:
//   GET /api/health (4410+N) → liveness for any caller; the deployment detail,
//     the Runner's body included, only with a bearer token
//   GET /api/settings → { overrides, effective } (modelConfigured display only)

export type WizardFetch = typeof fetch;

// --- shapes the wizard actually consumes (kept local & minimal) -------------

export interface SettingsResponse {
  overrides?: Record<string, unknown>;
  effective?: { modelId?: string | null };
}

/** The authenticated `/api/health` detail; a caller without a token gets only
 *  `{ service, liveness }`, so `runner` is the field that proves the detail. */
export interface HealthDetailResponse {
  runner?: { status?: string; execution?: { ready?: boolean } };
}

export interface SelfCheckResult {
  api: boolean;
  runner: boolean;
  /** null = runner endpoint not known (explicit-URL dev mode). */
  runnerChecked: boolean;
  /** Informational only — never gates entry (just-in-time config). */
  modelConfigured: boolean;
  ok: boolean;
}

// --- helpers -----------------------------------------------------------------

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function fetchSettings(
  apiBase: string, token: string, fetchImpl: WizardFetch,
): Promise<SettingsResponse | null> {
  const res = await fetchImpl(`${apiBase}/api/settings`, { headers: authHeaders(token) });
  return res.ok ? res.json() as Promise<SettingsResponse> : null;
}

// --- self-check (no model hard gate) -------------------------------------------

/** Run once; the wizard page polls until green or gives up (env provisioning). */
export async function runSelfCheck(
  apiBase: string, token: string, runnerBase: string | null, fetchImpl: WizardFetch,
): Promise<SelfCheckResult> {
  let api = false;
  let health: HealthDetailResponse | null = null;
  try {
    const res = await fetchImpl(`${apiBase}/api/health`, {
      headers: authHeaders(token), signal: AbortSignal.timeout(4000),
    });
    api = res.ok;
    if (api) health = await res.json() as HealthDetailResponse;
  } catch { /* down */ }
  // Readiness comes through the API, which forwards the Runner's own health
  // body: the Runner port answers an anonymous caller with liveness only, so a
  // direct probe cannot tell "ready" from "up" any more.
  const runner = health?.runner?.execution?.ready === true;
  let modelConfigured = false;
  if (api) {
    const settings = await fetchSettings(apiBase, token, fetchImpl);
    modelConfigured = Boolean(settings?.effective?.modelId);
  }
  return {
    api,
    runner,
    // Only meaningful when the shell knows a Runner to check; the readiness
    // itself is part of the API's authenticated answer.
    runnerChecked: runnerBase !== null,
    modelConfigured,
    // No model gate — the user may enter unconfigured and set up
    // models from the main UI (the backend's 409 guidance covers first use).
    ok: api && (!runnerBase || runner),
  };
}

// Wizard backend API calls (F8.4; F10.8 removed the model-config step —
// models are configured from the main UI after entering the system, so the
// wizard ships only the final self-check). All decisions pure: fetch is
// injected, no Electron imports.
//
// Contracts verified against services/api (2026-10-15):
//   GET /api/health (4410+N) / runner /health (4311+N) → no auth
//   GET /api/settings → { overrides, effective } (modelConfigured display only)

export type WizardFetch = typeof fetch;

// --- shapes the wizard actually consumes (kept local & minimal) -------------

export interface SettingsResponse {
  overrides?: Record<string, unknown>;
  effective?: { modelId?: string | null };
}

export interface SelfCheckResult {
  api: boolean;
  runner: boolean;
  /** null = runner endpoint not known (explicit-URL dev mode). */
  runnerChecked: boolean;
  /** Informational only since F10.8 — never gates entry (just-in-time config). */
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

// --- self-check (F8.4; F10.8 dropped the model hard gate) --------------------

/** Run once; the wizard page polls until green or gives up (env provisioning). */
export async function runSelfCheck(
  apiBase: string, token: string, runnerBase: string | null, fetchImpl: WizardFetch,
): Promise<SelfCheckResult> {
  const api = await fetchImpl(`${apiBase}/api/health`, { signal: AbortSignal.timeout(4000) })
    .then(r => r.ok).catch(() => false);
  let runner = false;
  if (runnerBase) {
    try {
      const res = await fetchImpl(`${runnerBase}/health`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        // Gate on execution readiness (readiness.ts: ready=true for the
        // unsandboxed Provider A path once the runner is up).
        const body = await res.json() as { execution?: { ready?: boolean } };
        runner = body.execution?.ready === true;
      }
    } catch { /* down */ }
  }
  let modelConfigured = false;
  if (api) {
    const settings = await fetchSettings(apiBase, token, fetchImpl);
    modelConfigured = Boolean(settings?.effective?.modelId);
  }
  return {
    api,
    runner,
    runnerChecked: runnerBase !== null,
    modelConfigured,
    // F10.8: no model gate — the user may enter unconfigured and set up
    // models from the main UI (F5/F6's 409 guidance covers first use).
    ok: api && (!runnerBase || runner),
  };
}

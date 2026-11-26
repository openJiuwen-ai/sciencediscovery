// DEV-ONLY harness (never shipped: tree-shaken from production builds via the
// `if (import.meta.env.DEV)` guard in main.tsx). Purpose: render the
// SetupWizard boot self-check list with a faked shell bridge so the
// [U5c] post-cleanup states can be captured for the upstream PR review.
// The Seatbelt row/banner scenarios are retired with the rows themselves
// (owner decision 2026-11-23: 初始化不拦截不提示，沙箱监测只在设置 — the
// wizard's list is api/runner/model alone).
//
// Query params:
//   ?scenario=ok      — self-check all green
//   ?scenario=pending — mid-check (every row still pending)
//   &lang=zh|en       — text locale (default zh)

import { createRoot } from "react-dom/client";
import { applyDocumentLanguage, setLanguage } from "./text.js";
import { SetupWizard } from "./views/SetupWizard.js";

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "ok";
const lang = params.get("lang") ?? "zh";

function fakeBridge() {
  const base = {
    getState: async () => ({ dataDir: "/Users/demo/Library/Application Support/ScienceDiscovery", defaultDataDir: "" }),
    openLogs: async () => "",
  };
  if (scenario === "pending") {
    // Resolve once with a not-ready result (so the list renders in the
    // "checking" phase with every row still pending), then never again.
    let first = true;
    return {
      ...base,
      backendStatus: async () => ({ status: "healthy" as const }),
      selfCheck: () => {
        if (!first) return new Promise(() => {});
        first = false;
        return Promise.resolve({
          api: false,
          runner: null,
          model: false,
          ok: false,
        });
      },
    };
  }
  // ok: resolve after a short delay so the "checking" phase renders first.
  return {
    ...base,
    selfCheck: async () => ({
      api: true,
      runner: true,
      runnerChecked: true,
      model: true,
      ok: true,
    }),
  };
}

// Inject the shell bridge the wizard reads at mount time, and pin the locale
// (setLanguage persists to localStorage and notifies listeners).
setLanguage(lang === "en" ? "en" : "zh-CN");
applyDocumentLanguage();
(window as unknown as { sdShell?: unknown }).sdShell = { wizard: fakeBridge() };

// Minimal client stub: the wizard only uses it in later steps (workspace
// directory picking etc.); the boot step needs nothing from the network.
const clientStub = {
  baseUrl: "http://localhost:4310",
  token: "",
  fetch: (async () => {
    throw new Error("harness: offline");
  }) as typeof fetch,
} as unknown as Parameters<typeof SetupWizard>[0]["client"];

function HarnessApp() {
  return (
    <SetupWizard
      client={clientStub}
      initialStep="boot"
      onConfigured={() => undefined}
      onProvidersChanged={() => undefined}
      presets={[]}
      providers={[]}
    />
  );
}

/** Entry from main.tsx (`?wizard-shot=1`). */
export function mountWizardShotHarness(root: HTMLElement) {
  createRoot(root).render(<HarnessApp />);
}

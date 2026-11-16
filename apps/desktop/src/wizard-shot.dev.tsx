// DEV-ONLY harness (never shipped: tree-shaken from production builds via the
// `if (import.meta.env.DEV)` guard in main.tsx). Purpose: render the
// SetupWizard boot self-check list with a faked shell bridge so the B2-2
// Seatbelt row (ok / pending) and the fail-closed error page can be
// captured for the upstream PR review (yuanzhou75's ask).
//
// Query params:
//   ?scenario=ok      — self-check all green (Seatbelt row shows ✓)
//   ?scenario=pending — mid-check (Seatbelt row shows …)
//   ?scenario=fail    — fail-closed error page (reason + diagnostics)
//   &lang=zh|en       — text locale (default zh)

import { createRoot } from "react-dom/client";
import { applyDocumentLanguage, setLanguage } from "./text.js";
import { SetupWizard } from "./views/SetupWizard.js";

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "ok";
const lang = params.get("lang") ?? "zh";

const SEATBELT_REASON = {
  zh: "macOS 沙箱（Seatbelt）自检未通过：sandbox-exec 编译配置被系统拒绝（退出码 1）。这通常来自 MDM 管控或系统安全策略限制。",
  en: "macOS sandbox (Seatbelt) self-check failed: sandbox-exec rejected the probe profile (exit code 1). This usually comes from MDM control or a system security policy.",
};
const DIAGNOSTICS = [
  "/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true; echo $?",
  "sudo profiles list | grep -i sandbox",
];

function fakeBridge() {
  const base = {
    getState: async () => ({ dataDir: "/Users/demo/Library/Application Support/ScienceDiscovery", defaultDataDir: "" }),
    openLogs: async () => "",
  };
  if (scenario === "fail") {
    return {
      ...base,
      selfCheck: async () => ({
        api: true,
        runner: true,
        runnerChecked: true,
        model: true,
        seatbelt: "failed" as const,
        seatbeltReason: SEATBELT_REASON[lang as "zh" | "en"] ?? SEATBELT_REASON.zh,
        seatbeltDiagnostics: DIAGNOSTICS,
        ok: false,
      }),
    };
  }
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
          seatbelt: "unknown" as const,
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
      seatbelt: "ok" as const,
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

// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { useEffect, useState } from "react";

import type { ApiClient } from "../api/client.js";
import { getHealth, getSettings } from "../api/models.js";
import type { ModelProvider, ModelProviderPreset } from "../api/types.js";
import { DATA_DIR_STORAGE_KEY, readStoredText, writeStoredText } from "../state/storage.js";
import { TEXT } from "../text.js";
import { ModelForm, type ModelFormResult } from "./ModelForm.js";

type Step = "workspace" | "boot" | "model";

interface Props {
  client: ApiClient;
  onConfigured: (result: ModelFormResult) => void | Promise<void>;
  /** Re-reads the catalog so a second attempt in this session sees the provider
   *  the first one created, and updates it instead of duplicating it. */
  onProvidersChanged: () => void | Promise<void>;
  presets: ModelProviderPreset[];
  providers: ModelProvider[];
  /** The step to open on. The app starts at the workspace; static tests render
   *  a later step directly because they have no DOM to click through. */
  initialStep?: Step;
}

/** The subset of the Electron preload's wizard bridge this page uses. The SPA
 *  is loaded in the shell's window, so the bridge is there in the real app and
 *  absent in a plain browser; every call is optional for that reason. */
interface DirCheckResult {
  freeBytes?: number | null;
  freeOk?: boolean;
  ok?: boolean;
  warnings?: string[];
  writable?: boolean;
}
interface BackendStatus {
  message?: string;
  status?: "idle" | "starting" | "healthy" | "failed";
}
interface SelfCheckResult {
  api?: boolean;
  modelConfigured?: boolean;
  ok?: boolean;
  runner?: boolean;
  runnerChecked?: boolean;
}
interface ShellWizardBridge {
  backendStatus?: () => Promise<BackendStatus>;
  browseDir?: () => Promise<string | null>;
  checkDir?: (path: string) => Promise<DirCheckResult>;
  getState?: () => Promise<{ dataDir?: string | null; defaultDataDir?: string }>;
  openLogs?: () => Promise<string>;
  retryBackend?: (path: string) => Promise<{ ok?: boolean }>;
  selfCheck?: () => Promise<SelfCheckResult>;
}

function shellWizard(): ShellWizardBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as unknown as { sdShell?: { wizard?: ShellWizardBridge } }).sdShell;
  return bridge?.wizard;
}

/** The recorded directory is a note to self, not a setting: `localStorage` may
 *  be unavailable (server rendering, a locked-down browser), and that must
 *  leave the field empty rather than break the page. */
function recordedDirectory(): string {
  try {
    if (typeof window === "undefined") return "";
    return readStoredText(window.localStorage, DATA_DIR_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberDirectory(path: string): void {
  try {
    if (typeof window === "undefined") return;
    writeStoredText(window.localStorage, DATA_DIR_STORAGE_KEY, path);
  } catch {
    // The wizard can still continue; losing the note is not losing the setup.
  }
}

function bootHeading(boot: BootView): { title: string; sub: string } {
  const text = TEXT.wizard.boot;
  switch (boot.phase) {
    case "starting":
      return { title: text.title, sub: text.sub };
    case "checking":
      return { title: text.checkingTitle, sub: text.checkingSub };
    case "ready":
      return { title: text.readyTitle, sub: text.readySub };
    case "failed":
      return boot.kind === "boot"
        ? { title: text.failedTitle, sub: text.failedSub }
        : { title: text.timeoutTitle, sub: text.timeoutSub };
  }
}

/** The shell prints the same sizes; keeping the rounding here avoids a second
 *  formatting convention on one screen. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}MB`;
  return `${Math.max(0, Math.round(bytes / 1024))}KB`;
}

type CheckTone = "ok" | "warn" | "err";
interface CheckLine {
  text: string;
  tone: CheckTone;
}

type BootPhase = "starting" | "checking" | "ready" | "failed";
type ItemState = "pending" | "ok" | "skip" | "fail";
interface BootView {
  phase: BootPhase;
  /** Which part failed: the service never came up, or the self-check timed out
   *  with a component still pending. The two failures say different things. */
  kind?: "boot" | "check";
  api: ItemState;
  runner: ItemState;
  model: ItemState;
  waited: number;
  message?: string;
  /** True only when the browser health probe saw no `runner` field (public
   *  liveness body). Other skip reasons keep the neutral "not checked" tip. */
  runnerNeedsToken?: boolean;
}
const INITIAL_BOOT: BootView = {
  phase: "starting",
  api: "pending",
  runner: "pending",
  model: "pending",
  waited: 0,
};
/** Same budgets as the shell wizard: poll the service every 2 s while it
 *  starts, and give the self-check 3 minutes before calling an item failed. */
const BACKEND_POLL_MS = 2000;
const SELF_CHECK_POLL_MS = 5000;
const SELF_CHECK_BUDGET_MS = 180_000;

interface ProbeResult {
  api: boolean;
  /** `null` means the item was not checked at all (no runner base, or no
   *  bridge in a plain browser), which the list shows as "–", never "✗". */
  runner: boolean | null;
  /** Browser path only: public health omitted `runner`, so the tip should say
   *  a token is required rather than the neutral "not checked". */
  runnerNeedsToken?: boolean;
  model: boolean;
  ok: boolean;
}
const PENDING_PROBE: ProbeResult = { api: false, runner: null, model: false, ok: false };

function dotClass(state: ItemState): string {
  return state === "pending" ? "is-pending" : state === "ok" ? "is-ok" : state === "fail" ? "is-fail" : "";
}
function dotGlyph(state: ItemState): string {
  return state === "ok" ? "✓" : state === "fail" ? "✗" : state === "pending" ? "…" : "–";
}

/**
 * The first run, in the shell wizard's split-screen language.
 *
 * Three steps, in the shell's order: the workspace directory, the environment
 * check, then the provider. The workspace step is a record, not a control — the
 * Electron shell fixes the live data directory before this bundle loads and no
 * route can move it, so the field says where the user's data goes without
 * pretending to relocate it.
 *
 * The environment step is the shell's 启动与自检 page, kept as its own step. It
 * asks the shell for the live backend status and runs the same self-check
 * (local API, execution engine, optional default model), with the same pending
 * → ✓ / – states and the same 3-minute budget. In a plain browser there is no
 * bridge, so it probes `/api/health` and `/api/settings` instead and treats the
 * runner as "not checked" rather than failed.
 *
 * When the preload bridge is present, the directory field starts at the
 * directory the shell actually chose, browses through the native dialog and
 * checks writability/disk space exactly as the shell's own step does. Those
 * controls stay out of the markup in a plain browser, where the request cannot
 * be answered.
 *
 * The form is the shared `ModelForm`; `revealSubmitOnSuccess` makes its test
 * the primary action and keeps the final button hidden until that test passes,
 * which is the same 测试并继续 → 开始使用 order the shell uses.
 */
export function SetupWizard({
  client,
  onConfigured,
  onProvidersChanged,
  presets,
  providers,
  initialStep = "workspace",
}: Props) {
  const [bridge] = useState(shellWizard);
  const [step, setStep] = useState<Step>(initialStep);
  const [dataDir, setDataDir] = useState(recordedDirectory);
  const [defaultDir, setDefaultDir] = useState("");
  const [check, setCheck] = useState<{ lines: CheckLine[]; ok: boolean }>();
  const [boot, setBoot] = useState<BootView>(INITIAL_BOOT);
  /** Incremented by 重新检查 so the boot effect runs again without leaving the step. */
  const [bootRun, setBootRun] = useState(0);

  const onWorkspace = step === "workspace";
  const onBoot = step === "boot";
  // All three steps share one panel: the artwork should not change under the
  // form as the user walks forward.
  const art = TEXT.wizard.art;
  const heading = onWorkspace
    ? { title: TEXT.wizard.workspace.title, sub: TEXT.wizard.workspace.sub }
    : onBoot
      ? bootHeading(boot)
      : { title: TEXT.wizard.title, sub: TEXT.wizard.sub };
  const progress = onWorkspace ? 1 / 3 : onBoot ? 2 / 3 : 1;

  // The shell's answer is authoritative: a previously recorded note must not
  // hide the directory the service is actually using.
  useEffect(() => {
    if (!bridge?.getState) return;
    let cancelled = false;
    void bridge
      .getState()
      .then((state) => {
        if (cancelled) return;
        setDefaultDir(state.defaultDataDir ?? "");
        setDataDir(state.dataDir?.trim() ? state.dataDir : state.defaultDataDir ?? "");
      })
      .catch(() => {
        // Without an answer the recorded note remains, which is still honest.
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // Same debounce as the shell: typing must not probe the disk on every key.
  useEffect(() => {
    if (!bridge?.checkDir) return;
    const path = dataDir.trim();
    if (path === "") {
      setCheck(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void bridge
        .checkDir?.(path)
        .then((result) => {
          if (cancelled) return;
          const writable = result.writable !== false && result.ok !== false;
          const lines: CheckLine[] = [
            {
              tone: writable ? "ok" : "err",
              text: writable
                ? TEXT.wizard.workspace.check.writable
                : TEXT.wizard.workspace.check.notWritable,
            },
          ];
          if (result.freeBytes == null) {
            lines.push({ tone: "warn", text: TEXT.wizard.workspace.check.freeUnknown });
          } else if (result.freeOk === false) {
            lines.push({
              tone: "err",
              text: TEXT.wizard.workspace.check.freeLow(formatBytes(result.freeBytes)),
            });
          } else {
            lines.push({
              tone: "ok",
              text: TEXT.wizard.workspace.check.free(formatBytes(result.freeBytes)),
            });
          }
          for (const warning of result.warnings ?? []) {
            lines.push({ tone: "warn", text: warning });
          }
          setCheck({ lines, ok: writable && result.freeOk !== false });
        })
        .catch(() => {
          if (!cancelled) setCheck(undefined);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bridge, dataDir]);

  // The environment step follows the shell's loop: wait for the service to be
  // healthy, then run the self-check, polling while a component is still on its
  // way and only calling it failed once the budget is spent.
  useEffect(() => {
    if (step !== "boot") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let checkStartedAt = 0;
    const bootStartedAt = Date.now();

    const emit = (patch: Partial<BootView>) => {
      if (!cancelled) setBoot((previous) => ({ ...previous, ...patch }));
    };

    const probe = async (): Promise<ProbeResult> => {
      if (bridge?.selfCheck) {
        try {
          const result = await bridge.selfCheck();
          return {
            api: result?.api === true,
            runner: result?.runnerChecked ? result.runner === true : null,
            model: result?.modelConfigured === true,
            ok: result?.ok === true,
          };
        } catch {
          return PENDING_PROBE;
        }
      }
      // No bridge (a plain browser): ask the service this page is talking to.
      try {
        const [health, settings] = await Promise.all([
          getHealth(client),
          getSettings(client).catch(() => undefined),
        ]);
        // Public health has no `runner`; treat that as unchecked (needs token),
        // not failed. With a token the client already sends, map readiness.
        const runnerMissing = health.runner === undefined;
        return {
          api: true,
          runner: runnerMissing ? null : health.runner?.execution?.ready === true,
          runnerNeedsToken: runnerMissing,
          model: Boolean(settings?.effective?.modelId),
          ok: true,
        };
      } catch {
        return PENDING_PROBE;
      }
    };

    const selfCheck = async () => {
      checkStartedAt = Date.now();
      emit({ phase: "checking", kind: undefined, message: undefined });
      const iterate = async () => {
        const result = await probe();
        if (cancelled) return;
        if (result.ok) {
          setBoot((previous) => ({
            ...previous,
            phase: "ready",
            kind: undefined,
            message: undefined,
            api: "ok",
            runner: result.runner === null ? "skip" : "ok",
            runnerNeedsToken: Boolean(result.runnerNeedsToken),
            model: result.model ? "ok" : "skip",
          }));
          return;
        }
        if (Date.now() - checkStartedAt > SELF_CHECK_BUDGET_MS) {
          setBoot((previous) => ({
            ...previous,
            phase: "failed",
            kind: "check",
            message: TEXT.wizard.boot.timeoutSub,
            api: result.api ? "ok" : "fail",
            runner: result.runner === null ? "skip" : result.runner ? "ok" : "fail",
            runnerNeedsToken: Boolean(result.runnerNeedsToken),
            model: result.model ? "ok" : "skip",
          }));
          return;
        }
        // A component that answered "not ready" stays pending; an unchecked
        // item is "–", and a ready one turns green immediately.
        emit({
          api: result.api ? "ok" : "pending",
          runner: result.runner === null ? "skip" : result.runner ? "ok" : "pending",
          runnerNeedsToken: Boolean(result.runnerNeedsToken),
          model: result.model ? "ok" : "skip",
        });
        timer = setTimeout(() => void iterate(), SELF_CHECK_POLL_MS);
      };
      await iterate();
    };

    const run = async () => {
      setBoot(INITIAL_BOOT);
      if (bridge?.backendStatus) {
        let status: BackendStatus | undefined;
        try {
          status = await bridge.backendStatus();
        } catch {
          status = undefined;
        }
        if (cancelled) return;
        if (status?.status === "failed") {
          setBoot({
            ...INITIAL_BOOT,
            phase: "failed",
            kind: "boot",
            message: status.message?.trim() || TEXT.wizard.boot.fallbackError,
          });
          return;
        }
        if (status?.status !== "healthy") {
          if (status?.status === "idle" && bridge.retryBackend) {
            try {
              await bridge.retryBackend(dataDir);
            } catch {
              // Best effort: the next poll reports what actually happened.
            }
            if (cancelled) return;
          }
          setBoot({
            ...INITIAL_BOOT,
            phase: "starting",
            waited: Math.round((Date.now() - bootStartedAt) / 1000),
          });
          timer = setTimeout(() => void run(), BACKEND_POLL_MS);
          return;
        }
      }
      if (cancelled) return;
      await selfCheck();
    };

    void run();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [step, bridge, bootRun, client, dataDir]);

  const browse = async () => {
    if (!bridge?.browseDir) return;
    try {
      const picked = await bridge.browseDir();
      if (picked !== null) setDataDir(picked);
    } catch {
      // The dialog was dismissed or the bridge failed; the typed path stands.
    }
  };

  /** Both ways out of the workspace step record the answer and open the
   *  environment step. Skipping clears the note, which is how the old footer
   *  expressed "use the default". */
  const leaveWorkspace = (record: boolean) => {
    const path = record ? dataDir.trim() : "";
    setDataDir(path);
    rememberDirectory(path);
    setBoot(INITIAL_BOOT);
    setStep("boot");
  };

  return (
    <div className="wizard-page">
      <main className="wizard-pane">
        <header className="wizard-brand">
          <span className="wizard-brand-mark" aria-hidden="true">
            <svg
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.7"
              viewBox="0 0 24 24"
            >
              <path d="M9 3h6" />
              <path d="M10 3v5.2L5.2 17a2.4 2.4 0 0 0 2.1 3.6h9.4a2.4 2.4 0 0 0 2.1-3.6L14 8.2V3" />
              <path d="M7.5 15h9" />
            </svg>
          </span>
          <span className="wizard-brand-name">{TEXT.appName}</span>
        </header>

        <div className="wizard-scroll">
          <div className="wizard-content">
            <div className="wizard-progress" data-step={step} aria-hidden="true">
              <span style={{ width: `${progress * 100}%` }} />
            </div>

            <section>
              <h1>{heading.title}</h1>
              <p className="wizard-sub">{heading.sub}</p>

              {onWorkspace ? (
                <div className="wizard-form">
                  <label className="field">
                    <span className="field-label">{TEXT.wizard.workspace.label}</span>
                    <span className="field-dir">
                      <input
                        className="field-input"
                        onChange={(event) => setDataDir(event.target.value)}
                        placeholder={TEXT.wizard.workspace.placeholder}
                        spellCheck={false}
                        value={dataDir}
                      />
                      {bridge?.browseDir ? (
                        <button
                          aria-label={TEXT.wizard.workspace.browse}
                          className="field-icon"
                          onClick={() => void browse()}
                          title={TEXT.wizard.workspace.browse}
                          type="button"
                        >
                          <svg
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="1.7"
                            viewBox="0 0 24 24"
                          >
                            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                          </svg>
                        </button>
                      ) : null}
                    </span>
                    {bridge?.getState && defaultDir !== "" ? (
                      <button
                        className="link-button"
                        onClick={() => setDataDir(defaultDir)}
                        type="button"
                      >
                        {TEXT.wizard.workspace.useDefault}
                      </button>
                    ) : null}
                  </label>
                  {check ? (
                    <div className="wizard-check">
                      {check.lines.map((line) => (
                        <span className={`is-${line.tone}`} key={line.text}>
                          {line.text}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <p className="wizard-note">{TEXT.wizard.workspace.note}</p>
                  <div className="form-actions">
                    <button
                      className="secondary-button"
                      onClick={() => leaveWorkspace(false)}
                      type="button"
                    >
                      {TEXT.wizard.workspace.skip}
                    </button>
                    <button
                      className="primary-button"
                      disabled={check !== undefined && !check.ok}
                      onClick={() => leaveWorkspace(true)}
                      type="button"
                    >
                      {TEXT.wizard.workspace.next}
                    </button>
                  </div>
                </div>
              ) : onBoot ? (
                <div className="wizard-form">
                  {boot.phase === "starting" ? (
                    <>
                      <div className="boot-status">
                        <span className="spinner" aria-hidden="true" />
                        <p>
                          {boot.waited > 0
                            ? TEXT.wizard.boot.waited(boot.waited)
                            : TEXT.wizard.boot.starting}
                        </p>
                      </div>
                      <p className="wizard-hint">{TEXT.wizard.boot.hint}</p>
                    </>
                  ) : null}

                  {boot.phase !== "starting" && boot.kind !== "boot" ? (
                    <ul className="wizard-selfcheck">
                      {(
                        [
                          ["api", boot.api],
                          ["runner", boot.runner],
                          ["model", boot.model],
                        ] as const
                      ).map(([key, state]) => (
                        <li key={key}>
                          <span
                            className={["boot-dot", dotClass(state)].filter(Boolean).join(" ")}
                            title={
                              state !== "skip"
                                ? undefined
                                : key === "runner" && boot.runnerNeedsToken
                                  ? TEXT.wizard.boot.runnerNeedsToken
                                  : TEXT.wizard.boot.notChecked
                            }
                          >
                            {dotGlyph(state)}
                          </span>
                          <span>{TEXT.wizard.boot.items[key]}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {boot.phase === "failed" && boot.message ? (
                    <div className="test-result is-fail" role="alert">
                      {boot.message}
                    </div>
                  ) : null}

                  <div className="form-actions">
                    {boot.phase === "failed" ? (
                      <>
                        {bridge?.openLogs ? (
                          <button
                            className="secondary-button"
                            onClick={() => {
                              void Promise.resolve(bridge.openLogs?.()).catch(() => undefined);
                            }}
                            type="button"
                          >
                            {TEXT.wizard.boot.logs}
                          </button>
                        ) : null}
                        <button
                          className={
                            boot.kind === "boot" ? "primary-button" : "secondary-button"
                          }
                          onClick={() => setBootRun((count) => count + 1)}
                          type="button"
                        >
                          {boot.kind === "boot"
                            ? TEXT.wizard.boot.retryBoot
                            : TEXT.wizard.boot.retry}
                        </button>
                      </>
                    ) : null}
                    {boot.phase === "ready" ? (
                      <button
                        className="primary-button"
                        onClick={() => setStep("model")}
                        type="button"
                      >
                        {TEXT.wizard.boot.next}
                      </button>
                    ) : null}
                    <button
                      className="wizard-back"
                      onClick={() => setStep("workspace")}
                      type="button"
                    >
                      {TEXT.wizard.back}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="wizard-form">
                  <ModelForm
                    client={client}
                    onConfigured={onConfigured}
                    onProvidersChanged={onProvidersChanged}
                    presets={presets}
                    providers={providers}
                    revealSubmitOnSuccess
                    submitLabel={TEXT.wizard.finish}
                    testLabel={TEXT.wizard.testAndContinue}
                    trailingAction={
                      <button
                        className="wizard-back"
                        onClick={() => {
                          setBoot(INITIAL_BOOT);
                          setStep("boot");
                        }}
                        type="button"
                      >
                        {TEXT.wizard.back}
                      </button>
                    }
                  />
                </div>
              )}
            </section>
          </div>
        </div>
      </main>

      <aside className="wizard-art" aria-hidden="true">
        <div className="wizard-art-copy">
          <h2>{art.title}</h2>
          <p>{art.sub}</p>
        </div>
      </aside>
    </div>
  );
}

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

import React, { useCallback, useEffect, useState } from "react";

import {
  parseAllowedDomain,
  type ProxySettingsDetails,
  type RuntimeStatus,
  type SandboxNetworkSettings,
  type SystemQuotaSettings,
  type SystemTimeoutSettings,
} from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { ProxyPolicySelect } from "./ProxySettingsEditor.js";
import { useLocale, type MessageKey } from "./i18n/index.js";

type Translate = ReturnType<typeof useLocale>["t"];

const TIMEOUT_FIELDS: Array<{
  descriptionKey: MessageKey;
  field: keyof SystemTimeoutSettings;
  labelKey: MessageKey;
}> = [
  {
    descriptionKey: "runtime.timeouts.gatewayIdle.description",
    field: "gatewayIdleTimeoutMs",
    labelKey: "runtime.timeouts.gatewayIdle.label",
  },
  {
    descriptionKey: "runtime.timeouts.gatewayTurn.description",
    field: "gatewayTurnTimeoutMs",
    labelKey: "runtime.timeouts.gatewayTurn.label",
  },
  {
    descriptionKey: "runtime.timeouts.runnerExec.description",
    field: "runnerExecTimeoutMs",
    labelKey: "runtime.timeouts.runnerExec.label",
  },
  {
    descriptionKey: "runtime.timeouts.kernelIdle.description",
    field: "kernelIdleTimeoutMs",
    labelKey: "runtime.timeouts.kernelIdle.label",
  },
  {
    descriptionKey: "runtime.timeouts.permissionWait.description",
    field: "permissionWaitTimeoutMs",
    labelKey: "runtime.timeouts.permissionWait.label",
  },
];

function seconds(milliseconds: number): string {
  return milliseconds === 0 ? "" : String(milliseconds / 1000);
}

function duration(milliseconds: number, t: Translate): string {
  if (milliseconds === 0) return t("runtime.unlimited");
  if (milliseconds % 60_000 === 0) return t("runtime.unitMinutes", { count: milliseconds / 60_000 });
  if (milliseconds % 1000 === 0) return t("runtime.unitSeconds", { count: milliseconds / 1000 });
  return t("runtime.unitMilliseconds", { count: milliseconds });
}

export function TimeoutSettingsEditor({
  onChange,
  settings,
}: {
  onChange: (settings: SystemTimeoutSettings) => void;
  settings: SystemTimeoutSettings;
}) {
  const { t } = useLocale();
  function setUnlimited(field: keyof SystemTimeoutSettings, unlimited: boolean): void {
    onChange({
      ...settings,
      [field]: unlimited ? 0 : (settings[field] || 60_000),
    });
  }

  function setSeconds(field: keyof SystemTimeoutSettings, value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    onChange({ ...settings, [field]: Math.round(parsed * 1000) });
  }

  return <section className="timeout-settings">
    <div className="settings-detail-header">
      <span className="eyebrow">{t("runtime.timeouts.eyebrow")}</span>
      <h3>{t("settings.groups.timeouts.label")}</h3>
      <p>{t("runtime.timeouts.help")}</p>
    </div>
    <div className="timeout-grid">
      {TIMEOUT_FIELDS.map(({ descriptionKey, field, labelKey }) => {
        const label = t(labelKey);
        const unlimited = settings[field] === 0;
        return <fieldset key={field}>
          <legend>{label}</legend>
          <p>{t(descriptionKey)}</p>
          <label className="timeout-value">
            <span>{t("runtime.timeouts.seconds")}</span>
            <input
              aria-label={t("runtime.timeouts.aria", { label })}
              disabled={unlimited}
              min="0.001"
              onChange={(event) => setSeconds(field, event.target.value)}
              step="0.001"
              type="number"
              value={seconds(settings[field])}
            />
          </label>
          <label className="timeout-unlimited">
            <input
              checked={unlimited}
              onChange={(event) => setUnlimited(field, event.target.checked)}
              type="checkbox"
            />
            <span>{t("runtime.unlimited")}</span>
          </label>
          <small>{t("runtime.draft", { value: duration(settings[field], t) })}</small>
        </fieldset>;
      })}
    </div>
    <div className="settings-actions"><span className="settings-source">{t("runtime.timeouts.saveNote")}</span></div>
  </section>;
}

const GIB = 1_073_741_824;
const MIB = 1_048_576;

function formatBytes(bytes: number, t: Translate): string {
  if (bytes === 0) return t("runtime.unlimited");
  if (bytes % GIB === 0) return `${bytes / GIB} GiB`;
  if (bytes % MIB === 0) return `${bytes / MIB} MiB`;
  return t("runtime.unitBytes", { count: bytes });
}

/** Avoid binary/decimal float noise in number inputs (e.g. 1000000/MiB → 0.953…). */
function bytesToGiBInput(bytes: number): string {
  const gib = bytes / GIB;
  if (Number.isInteger(gib)) return String(gib);
  const rounded = Math.round(gib * 1_000_000) / 1_000_000;
  return String(rounded);
}

export function QuotaSettingsEditor({
  onChange,
  settings,
}: {
  onChange: (settings: SystemQuotaSettings) => void;
  settings: SystemQuotaSettings;
}) {
  const { t } = useLocale();
  function setGiBField(field: keyof SystemQuotaSettings, value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    onChange({ ...settings, [field]: Math.round(parsed * GIB) });
  }

  const workspaceUnlimited = settings.runnerMaxWorkspaceBytes === 0;
  const outputUnlimited = settings.runnerMaxOutputBytes === 0;
  const uploadFileUnlimited = settings.uploadMaxFileBytes === 0;
  const uploadRequestUnlimited = settings.uploadMaxRequestBytes === 0;

  return <section className="timeout-settings">
    <div className="settings-detail-header">
      <span className="eyebrow">{t("runtime.quotas.eyebrow")}</span>
      <h3>{t("settings.groups.quotas.label")}</h3>
      <p>{t("runtime.quotas.help")}</p>
    </div>
    <div className="timeout-grid">
      <fieldset>
        <legend>{t("runtime.quotas.uploadFile.label")}</legend>
        <p>{t("runtime.quotas.uploadFile.description")}</p>
        <label className="timeout-value">
          <span>GiB</span>
          <input
            aria-label={t("runtime.quotas.uploadFile.aria")}
            disabled={uploadFileUnlimited}
            min="1"
            onChange={(event) => setGiBField("uploadMaxFileBytes", event.target.value)}
            step="1"
            type="number"
            value={uploadFileUnlimited ? "" : bytesToGiBInput(settings.uploadMaxFileBytes)}
          />
        </label>
        <label className="timeout-unlimited">
          <input
            checked={uploadFileUnlimited}
            onChange={(event) => onChange({
              ...settings,
              uploadMaxFileBytes: event.target.checked ? 0 : (settings.uploadMaxFileBytes || GIB),
            })}
            type="checkbox"
          />
          <span>{t("runtime.unlimited")}</span>
        </label>
        <small>{t("runtime.draft", { value: formatBytes(settings.uploadMaxFileBytes, t) })}</small>
      </fieldset>
      <fieldset>
        <legend>{t("runtime.quotas.uploadRequest.label")}</legend>
        <p>{t("runtime.quotas.uploadRequest.description")}</p>
        <label className="timeout-value">
          <span>GiB</span>
          <input
            aria-label={t("runtime.quotas.uploadRequest.aria")}
            disabled={uploadRequestUnlimited}
            min="1"
            onChange={(event) => setGiBField("uploadMaxRequestBytes", event.target.value)}
            step="1"
            type="number"
            value={uploadRequestUnlimited ? "" : bytesToGiBInput(settings.uploadMaxRequestBytes)}
          />
        </label>
        <label className="timeout-unlimited">
          <input
            checked={uploadRequestUnlimited}
            onChange={(event) => onChange({
              ...settings,
              uploadMaxRequestBytes: event.target.checked ? 0 : (settings.uploadMaxRequestBytes || GIB * 10),
            })}
            type="checkbox"
          />
          <span>{t("runtime.unlimited")}</span>
        </label>
        <small>{t("runtime.draft", { value: formatBytes(settings.uploadMaxRequestBytes, t) })}</small>
      </fieldset>
      <fieldset>
        <legend>{t("runtime.quotas.workspace.label")}</legend>
        <p>{t("runtime.quotas.workspace.description")}</p>
        <label className="timeout-value">
          <span>GiB</span>
          <input
            aria-label={t("runtime.quotas.workspace.aria")}
            disabled={workspaceUnlimited}
            min="1"
            onChange={(event) => setGiBField("runnerMaxWorkspaceBytes", event.target.value)}
            step="1"
            type="number"
            value={workspaceUnlimited ? "" : bytesToGiBInput(settings.runnerMaxWorkspaceBytes)}
          />
        </label>
        <label className="timeout-unlimited">
          <input
            checked={workspaceUnlimited}
            onChange={(event) => onChange({
              ...settings,
              runnerMaxWorkspaceBytes: event.target.checked ? 0 : (settings.runnerMaxWorkspaceBytes || GIB * 10),
            })}
            type="checkbox"
          />
          <span>{t("runtime.unlimited")}</span>
        </label>
        <small>{t("runtime.draft", { value: formatBytes(settings.runnerMaxWorkspaceBytes, t) })}</small>
      </fieldset>
      <fieldset>
        <legend>{t("runtime.quotas.output.label")}</legend>
        <p>{t("runtime.quotas.output.description")}</p>
        <label className="timeout-value">
          <span>GiB</span>
          <input
            aria-label={t("runtime.quotas.output.aria")}
            disabled={outputUnlimited}
            min="1"
            onChange={(event) => setGiBField("runnerMaxOutputBytes", event.target.value)}
            step="1"
            type="number"
            value={outputUnlimited ? "" : bytesToGiBInput(settings.runnerMaxOutputBytes)}
          />
        </label>
        <label className="timeout-unlimited">
          <input
            checked={outputUnlimited}
            onChange={(event) => onChange({
              ...settings,
              runnerMaxOutputBytes: event.target.checked ? 0 : (settings.runnerMaxOutputBytes || GIB),
            })}
            type="checkbox"
          />
          <span>{t("runtime.unlimited")}</span>
        </label>
        <small>{t("runtime.draft", { value: formatBytes(settings.runnerMaxOutputBytes, t) })}</small>
      </fieldset>
    </div>
    <div className="settings-actions"><span className="settings-source">{t("runtime.quotas.saveNote")}</span></div>
  </section>;
}

/**
 * Sandbox network access: whether commands executed through run_shell may reach the
 * network, and which domains they may reach. Deliberately its own settings
 * group, separate from the Network proxies group, which configures this
 * service's own outbound calls and does not affect sandbox code.
 */
export function SandboxNetworkSettingsEditor({
  onChange,
  proxySettings,
  settings,
}: {
  onChange: (settings: SandboxNetworkSettings) => void;
  /** Network proxies registry, so allowed traffic can reuse a configured server. */
  proxySettings?: ProxySettingsDetails;
  settings: SandboxNetworkSettings;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(settings.allowedDomains.join("\n"));
  const [domainError, setDomainError] = useState<string>();

  function commitDomains(value: string): void {
    setDraft(value);
    const entries = value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
    try {
      for (const entry of entries) parseAllowedDomain(entry);
      setDomainError(undefined);
      onChange({ ...settings, allowedDomains: entries });
    } catch (error) {
      setDomainError(error instanceof Error ? error.message : t("runtime.sandbox.invalidDomain"));
    }
  }

  const allowlist = settings.mode === "domain-allowlist";
  return <section className="timeout-settings">
    <div className="settings-detail-header">
      <span className="eyebrow">{t("runtime.sandbox.eyebrow")}</span>
      <h3>{t("runtime.sandbox.title")}</h3>
      <p>
        {t("runtime.sandbox.helpBefore")}<code>run_shell</code>{t("runtime.sandbox.helpAfter")}
      </p>
    </div>
    <div className="timeout-grid">
      <fieldset>
        <legend>{t("runtime.sandbox.modeLabel")}</legend>
        <p>{t("runtime.sandbox.modeHelp")}</p>
        <label className="timeout-value">
          <span>{t("runtime.sandbox.modeLabel")}</span>
          <select
            aria-label={t("runtime.sandbox.modeAria")}
            onChange={(event) => onChange({
              ...settings,
              mode: event.target.value === "domain-allowlist" ? "domain-allowlist" : "none",
            })}
            value={settings.mode}
          >
            <option value="none">{t("runtime.sandbox.modeNone")}</option>
            <option value="domain-allowlist">{t("runtime.sandbox.modeAllowlist")}</option>
          </select>
        </label>
      </fieldset>
      <fieldset>
        <legend>{t("runtime.sandbox.domainsLegend")}</legend>
        <p>
          {t("runtime.sandbox.domainsHelpIntro")} <code>example.org</code>, <code>*.example.org</code>{t("runtime.sandbox.domainsHelpMiddle")}
          <code>:443</code>{t("runtime.sandbox.domainsHelpEnd")}
        </p>
        <label className="timeout-value">
          <span>{t("runtime.sandbox.domainsLabel")}</span>
          <textarea
            aria-label={t("runtime.sandbox.domainsLegend")}
            disabled={!allowlist}
            onChange={(event) => commitDomains(event.target.value)}
            rows={6}
            value={draft}
          />
        </label>
        {domainError ? <small role="alert">{domainError}</small> : <small>{t("runtime.sandbox.domainsDraft", { count: settings.allowedDomains.length })}</small>}
      </fieldset>
      <fieldset>
        <legend>{t("runtime.sandbox.privateLegend")}</legend>
        <p>{t("runtime.sandbox.privateHelp")}</p>
        <label className="timeout-unlimited">
          <input
            checked={settings.allowPrivateNetwork}
            disabled={!allowlist}
            onChange={(event) => onChange({ ...settings, allowPrivateNetwork: event.target.checked })}
            type="checkbox"
          />
          <span>{t("runtime.sandbox.privateAllow")}</span>
        </label>
      </fieldset>
      <fieldset>
        <legend>{t("runtime.sandbox.routeLegend")}</legend>
        <p>
          {t("runtime.sandbox.routeHelpBefore")}<em>{t("runtime.sandbox.routeEmphasis")}</em>{t("runtime.sandbox.routeHelpAfter")}
        </p>
        {proxySettings
          ? <ProxyPolicySelect
            disabled={!allowlist}
            label={t("runtime.sandbox.routeLabel")}
            onChange={(egressProxyPolicy) => onChange({ ...settings, egressProxyPolicy })}
            settings={proxySettings}
            value={settings.egressProxyPolicy}
          />
          : <p className="muted">{t("runtime.sandbox.loadingServers")}</p>}
      </fieldset>
    </div>
    <p className="muted">{t("runtime.sandbox.epochNote")}</p>
  </section>;
}

function timestamp(value: string): string {
  return new Date(value).toLocaleString();
}

export function RuntimeStatusPanel({
  client,
  onError,
  onNotice,
}: {
  client: ApiClient;
  onError: (message?: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = useLocale();
  const [status, setStatus] = useState<RuntimeStatus>();
  const [tearingDownKernelId, setTearingDownKernelId] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setStatus(await client.getRuntimeStatus());
    } catch (error) {
      onError(error instanceof Error ? error.message : t("runtime.status.loadFailed"));
    }
  }, [client, onError]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [refresh]);

  async function teardownKernel(kernelId: string): Promise<void> {
    setTearingDownKernelId(kernelId);
    try {
      const result = await client.teardownKernel(kernelId);
      onNotice(result.count
        ? t("runtime.status.kernelTornDown", { id: kernelId })
        : t("runtime.status.kernelInactive", { id: kernelId }));
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : t("runtime.status.teardownFailed"));
    } finally {
      setTearingDownKernelId(undefined);
    }
  }

  return <section className="runtime-status">
    <div className="settings-detail-header">
      <span className="eyebrow">{t("runtime.status.eyebrow")}</span>
      <h3>{t("settings.groups.runtime.label")}</h3>
      <p>{t("runtime.status.help")}</p>
    </div>
    {!status ? <p className="muted">{t("runtime.status.loading")}</p> : <>
      <div className="runtime-status-summary">
        <article><strong>{status.sessions.length}</strong><span>{t("runtime.status.runningSessions")}</span></article>
        <article><strong>{status.runner.activeExecutions.length}</strong><span>{t("runtime.status.runnerJobs")}</span></article>
        <article><strong>{status.runner.kernels.length}</strong><span>{t("runtime.status.activeKernels")}</span></article>
      </div>

      <div className="runtime-status-section">
        <h4>{t("runtime.status.sessions")}</h4>
        {status.sessions.length ? status.sessions.map((run) => <article key={run.runId}>
          <div><strong>{run.title}</strong><small>{run.sessionId}</small></div>
          <span className={`timeline-status ${run.status}`}>{run.status}</span>
          <small>{t("runtime.status.sessionLine", { started: timestamp(run.startedAt), activity: timestamp(run.lastActivityAt) })}</small>
        </article>) : <p>{t("runtime.status.noSessions")}</p>}
      </div>

      <div className="runtime-status-section">
        <h4>{t("runtime.status.runner")}</h4>
        {status.runner.status === "unavailable" ? <p className="runtime-status-error">{status.runner.error}</p>
          : status.runner.activeExecutions.length
            ? status.runner.activeExecutions.map((execution) => <article key={execution.executionId}>
                <div><strong>{execution.language} · {execution.kernelMode}</strong><small>{execution.executionId}</small></div>
                <span className={`timeline-status ${execution.status}`}>{execution.status}</span>
                <small>{t("runtime.status.jobLine", { id: execution.sessionId, queued: timestamp(execution.queuedAt) })}</small>
              </article>)
            : <p>{t("runtime.status.runnerIdle")}</p>}
      </div>

      <div className="runtime-status-section">
        <h4>{t("runtime.status.kernels")}</h4>
        {status.runner.kernels.length ? status.runner.kernels.map((kernel) => <article key={kernel.id}>
          <div><strong>{kernel.language} · {t("runtime.status.persistent")}</strong><small>{kernel.id}</small></div>
          <button
            aria-label={t("runtime.status.teardownAria", { id: kernel.id })}
            className="secondary-button runtime-teardown-button"
            disabled={tearingDownKernelId === kernel.id}
            onClick={() => void teardownKernel(kernel.id)}
            type="button"
          >{tearingDownKernelId === kernel.id ? t("runtime.status.tearingDown") : t("runtime.status.teardown")}</button>
          <small>{t("runtime.status.kernelLine", { session: kernel.sessionId, lastUsed: timestamp(kernel.lastUsedAt), expiry: kernel.expiresAt ? t("runtime.status.kernelExpiry", { expires: timestamp(kernel.expiresAt) }) : t("runtime.status.kernelNoExpiry") })}</small>
        </article>) : <p>{t("runtime.status.noKernels")}</p>}
      </div>
      <small className="settings-source">{t("runtime.status.captured", { timestamp: timestamp(status.capturedAt) })}</small>
    </>}
  </section>;
}

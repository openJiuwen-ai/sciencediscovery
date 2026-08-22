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
  type RuntimeStatus,
  type SandboxNetworkSettings,
  type SystemQuotaSettings,
  type SystemTimeoutSettings,
} from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";

const TIMEOUT_FIELDS: Array<{
  description: string;
  field: keyof SystemTimeoutSettings;
  label: string;
}> = [
  {
    description: "Stops the current turn when the Agent has no streamed output or progress for too long.",
    field: "gatewayIdleTimeoutMs",
    label: "Agent idle",
  },
  {
    description: "Limits one complete Agent turn, including the model, tools, and streamed output.",
    field: "gatewayTurnTimeoutMs",
    label: "Agent turn",
  },
  {
    description: "Wall-clock limit for one Runner code execution.",
    field: "runnerExecTimeoutMs",
    label: "Runner execution",
  },
  {
    description: "Releases a persistent Kernel after it has been inactive.",
    field: "kernelIdleTimeoutMs",
    label: "Kernel idle",
  },
  {
    description: "How long a run waits for a permission decision.",
    field: "permissionWaitTimeoutMs",
    label: "Permission wait",
  },
];

function seconds(milliseconds: number): string {
  return milliseconds === 0 ? "" : String(milliseconds / 1000);
}

function duration(milliseconds: number): string {
  if (milliseconds === 0) return "Unlimited";
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000} min`;
  if (milliseconds % 1000 === 0) return `${milliseconds / 1000} s`;
  return `${milliseconds} ms`;
}

export function TimeoutSettingsEditor({
  onChange,
  settings,
}: {
  onChange: (settings: SystemTimeoutSettings) => void;
  settings: SystemTimeoutSettings;
}) {
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
      <span className="eyebrow">Runtime deadlines</span>
      <h3>Timeouts</h3>
      <p>Set product wall-clock limits globally. Unlimited disables that timer. Internal request-signature safety windows are not changed here.</p>
    </div>
    <div className="timeout-grid">
      {TIMEOUT_FIELDS.map(({ description, field, label }) => {
        const unlimited = settings[field] === 0;
        return <fieldset key={field}>
          <legend>{label}</legend>
          <p>{description}</p>
          <label className="timeout-value">
            <span>Seconds</span>
            <input
              aria-label={`${label} timeout in seconds`}
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
            <span>Unlimited</span>
          </label>
          <small>Draft: {duration(settings[field])}</small>
        </fieldset>;
      })}
    </div>
    <div className="settings-actions"><span className="settings-source">Changes take effect only after using the dialog Save action.</span></div>
  </section>;
}

const GIB = 1_073_741_824;
const MIB = 1_048_576;

function formatBytes(bytes: number): string {
  if (bytes === 0) return "Unlimited";
  if (bytes % GIB === 0) return `${bytes / GIB} GiB`;
  if (bytes % MIB === 0) return `${bytes / MIB} MiB`;
  return `${bytes} bytes`;
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
      <span className="eyebrow">Runner and upload volume limits</span>
      <h3>Quotas</h3>
      <p>
        Limit Session workspace size, retained execution output, and multipart upload sizes.
        Unlimited sets that value to 0. Workspace total applies to both runner execution and upload accumulation.
      </p>
    </div>
    <div className="timeout-grid">
      <fieldset>
        <legend>Upload per file</legend>
        <p>Maximum size of one uploaded file. Shown on the workspace upload control. Default is 1 GiB.</p>
        <label className="timeout-value">
          <span>GiB</span>
          <input
            aria-label="Upload per-file quota in GiB"
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
          <span>Unlimited</span>
        </label>
        <small>Draft: {formatBytes(settings.uploadMaxFileBytes)}</small>
      </fieldset>
      <fieldset>
        <legend>Upload per request</legend>
        <p>Maximum size of one multipart upload request (all files combined). Default is 10 GiB.</p>
        <label className="timeout-value">
          <span>GiB</span>
          <input
            aria-label="Upload per-request quota in GiB"
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
          <span>Unlimited</span>
        </label>
        <small>Draft: {formatBytes(settings.uploadMaxRequestBytes)}</small>
      </fieldset>
      <fieldset>
        <legend>Workspace total</legend>
        <p>Maximum total size of files in the Session workspace (runner + uploads). Default is 10 GiB.</p>
        <label className="timeout-value">
          <span>GiB</span>
          <input
            aria-label="Workspace total quota in GiB"
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
          <span>Unlimited</span>
        </label>
        <small>Draft: {formatBytes(settings.runnerMaxWorkspaceBytes)}</small>
      </fieldset>
      <fieldset>
        <legend>Execution output</legend>
        <p>Retained stdout+stderr budget for one execution. Default is 1 GiB. Oversized output is truncated with a marker; the run still succeeds. Unlimited keeps the full stream in memory.</p>
        <label className="timeout-value">
          <span>GiB</span>
          <input
            aria-label="Runner output budget in GiB"
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
          <span>Unlimited</span>
        </label>
        <small>Draft: {formatBytes(settings.runnerMaxOutputBytes)}</small>
      </fieldset>
    </div>
    <div className="settings-actions"><span className="settings-source">Changes take effect only after using the dialog Save action. Env vars seed defaults on first boot.</span></div>
  </section>;
}

/**
 * Sandbox network access: whether run_python / run_r / run_shell may reach the
 * network, and which domains they may reach. Deliberately its own settings
 * group, separate from the Network proxies group, which configures this
 * service's own outbound calls and does not affect sandbox code.
 */
export function SandboxNetworkSettingsEditor({
  onChange,
  settings,
}: {
  onChange: (settings: SandboxNetworkSettings) => void;
  settings: SandboxNetworkSettings;
}) {
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
      setDomainError(error instanceof Error ? error.message : "Invalid allowed domain");
    }
  }

  const allowlist = settings.mode === "domain-allowlist";
  return <section className="timeout-settings">
    <div className="settings-detail-header">
      <span className="eyebrow">Sandbox code execution</span>
      <h3>Sandbox network access</h3>
      <p>
        Controls whether code run by <code>run_python</code>, <code>run_r</code> and <code>run_shell</code> can
        reach the network. The sandbox never gets a network interface: with a domain allowlist, outbound traffic
        leaves only through this deployment&apos;s egress gateway, which allows the domains listed here.
        Web and MCP outbound servers are configured separately under Network proxies and do not affect sandbox code.
      </p>
    </div>
    <div className="timeout-grid">
      <fieldset>
        <legend>Mode</legend>
        <p>
          No network is the default and matches a sandbox with no network at all.
          Domain allowlist keeps the sandbox isolated and permits only the listed domains.
        </p>
        <label className="timeout-value">
          <span>Mode</span>
          <select
            aria-label="Sandbox network mode"
            onChange={(event) => onChange({
              ...settings,
              mode: event.target.value === "domain-allowlist" ? "domain-allowlist" : "none",
            })}
            value={settings.mode}
          >
            <option value="none">No network</option>
            <option value="domain-allowlist">Domain allowlist</option>
          </select>
        </label>
      </fieldset>
      <fieldset>
        <legend>Allowed domains</legend>
        <p>
          One entry per line: <code>example.org</code>, <code>*.example.org</code> for subdomains,
          optionally with <code>:443</code> to restrict the port. Traffic is filtered by host name only —
          TLS is not inspected, so a broad entry stays a broad grant.
        </p>
        <label className="timeout-value">
          <span>Domains</span>
          <textarea
            aria-label="Allowed domains"
            disabled={!allowlist}
            onChange={(event) => commitDomains(event.target.value)}
            rows={6}
            value={draft}
          />
        </label>
        {domainError ? <small role="alert">{domainError}</small> : <small>Draft: {settings.allowedDomains.length} domains</small>}
      </fieldset>
      <fieldset>
        <legend>Private addresses</legend>
        <p>
          Off by default: an allowed domain that resolves to a loopback, link-local or private address is
          rejected, so sandbox code cannot reach this deployment&apos;s own services. Turn it on only for an
          internal mirror or registry.
        </p>
        <label className="timeout-unlimited">
          <input
            checked={settings.allowPrivateNetwork}
            disabled={!allowlist}
            onChange={(event) => onChange({ ...settings, allowPrivateNetwork: event.target.checked })}
            type="checkbox"
          />
          <span>Allow private and loopback addresses</span>
        </label>
      </fieldset>
    </div>
    <p className="muted">
      Saving a change rotates the Permission Epoch of every open Session and clears its persistent kernels and
      shell, because the policy is frozen into the epoch each execution runs under.
    </p>
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
  const [status, setStatus] = useState<RuntimeStatus>();
  const [tearingDownKernelId, setTearingDownKernelId] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setStatus(await client.getRuntimeStatus());
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not load runtime status");
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
        ? `Kernel ${kernelId} was torn down`
        : `Kernel ${kernelId} was already inactive`);
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not tear down Kernel");
    } finally {
      setTearingDownKernelId(undefined);
    }
  }

  return <section className="runtime-status">
    <div className="settings-detail-header">
      <span className="eyebrow">Live operations</span>
      <h3>Runtime status</h3>
      <p>Running Sessions, queued or running Runner jobs, and persistent Kernels. This view refreshes every three seconds.</p>
    </div>
    {!status ? <p className="muted">Loading runtime status…</p> : <>
      <div className="runtime-status-summary">
        <article><strong>{status.sessions.length}</strong><span>Running sessions</span></article>
        <article><strong>{status.runner.activeExecutions.length}</strong><span>Runner jobs</span></article>
        <article><strong>{status.runner.kernels.length}</strong><span>Active kernels</span></article>
      </div>

      <div className="runtime-status-section">
        <h4>Sessions</h4>
        {status.sessions.length ? status.sessions.map((run) => <article key={run.runId}>
          <div><strong>{run.title}</strong><small>{run.sessionId}</small></div>
          <span className={`timeline-status ${run.status}`}>{run.status}</span>
          <small>Started {timestamp(run.startedAt)} · activity {timestamp(run.lastActivityAt)}</small>
        </article>) : <p>No Session run is active.</p>}
      </div>

      <div className="runtime-status-section">
        <h4>Runner</h4>
        {status.runner.status === "unavailable" ? <p className="runtime-status-error">{status.runner.error}</p>
          : status.runner.activeExecutions.length
            ? status.runner.activeExecutions.map((execution) => <article key={execution.executionId}>
                <div><strong>{execution.language} · {execution.kernelMode}</strong><small>{execution.executionId}</small></div>
                <span className={`timeline-status ${execution.status}`}>{execution.status}</span>
                <small>Session {execution.sessionId} · queued {timestamp(execution.queuedAt)}</small>
              </article>)
            : <p>Runner is healthy; no execution is active.</p>}
      </div>

      <div className="runtime-status-section">
        <h4>Kernels</h4>
        {status.runner.kernels.length ? status.runner.kernels.map((kernel) => <article key={kernel.id}>
          <div><strong>{kernel.language} · persistent</strong><small>{kernel.id}</small></div>
          <button
            aria-label={`Teardown Kernel ${kernel.id}`}
            className="secondary-button runtime-teardown-button"
            disabled={tearingDownKernelId === kernel.id}
            onClick={() => void teardownKernel(kernel.id)}
            type="button"
          >{tearingDownKernelId === kernel.id ? "Tearing down…" : "Teardown"}</button>
          <small>Session {kernel.sessionId} · last used {timestamp(kernel.lastUsedAt)}{kernel.expiresAt ? ` · expires ${timestamp(kernel.expiresAt)}` : " · idle timeout unlimited"}</small>
        </article>) : <p>No persistent Kernel is active.</p>}
      </div>
      <small className="settings-source">Captured {timestamp(status.capturedAt)}</small>
    </>}
  </section>;
}

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

import { useEffect, useState, type FormEvent } from "react";

import type { PermissionDecision, PermissionRequest, RemoteHostTarget, RemoteJob } from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { ChevronRightIcon } from "./icons.js";
import { PermissionDecisionActions } from "./PermissionDecisionActions.js";
import { activityCardId, type ActivityCardDisclosure } from "./session/run-activity.js";

function capacity(host: RemoteHostTarget): string {
  const capabilities = host.capabilities;
  if (!capabilities) return host.error ?? "Probe unavailable";
  const memoryGiB = capabilities.memoryBytes ? Math.round(capabilities.memoryBytes / 1024 ** 3) : undefined;
  return [
    capabilities.cpuCores ? `${capabilities.cpuCores} CPU` : "CPU unknown",
    memoryGiB ? `${memoryGiB} GiB` : "memory unknown",
    capabilities.gpu ?? "no GPU detected",
    capabilities.slurm ? "SLURM" : "direct SSH",
  ].join(" · ");
}

export function RemoteHostManager({ client, onError, onPermissionRequest, sessionId }: {
  client: ApiClient;
  onError: (message: string) => void;
  onPermissionRequest: (request: PermissionRequest) => void;
  sessionId?: string;
}) {
  const [hosts, setHosts] = useState<RemoteHostTarget[]>([]);
  const [alias, setAlias] = useState("");
  const [busyId, setBusyId] = useState<string>();

  async function refresh(): Promise<void> {
    setHosts(await client.listRemoteHosts());
  }

  useEffect(() => { void refresh().catch((error: Error) => onError(error.message)); }, [client]);

  async function ensureHostPermission(hostAlias: string): Promise<boolean> {
    if (!sessionId) throw new Error("Open a Session before authorizing an SSH host");
    const result = await client.createPermissionRequest(sessionId, {
      action: "host",
      resource: hostAlias,
      summary: `Connect to SSH host ${hostAlias} for a read-only capability probe`,
    });
    if (!result.allowed && result.request) {
      onPermissionRequest(result.request);
      onError("SSH probe is paused. Close settings, review the host permission card, then retry after allowing it.");
      return false;
    }
    return true;
  }

  async function addHost(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusyId("new");
    try {
      if (!await ensureHostPermission(alias.trim())) return;
      const host = await client.registerRemoteHost({ alias: alias.trim() });
      setAlias("");
      await refresh();
      if (host.error) onError(host.error);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not register SSH host");
    } finally {
      setBusyId(undefined);
    }
  }

  return <div className="remote-host-manager">
    <div className="settings-detail-header"><span className="eyebrow">Institution-controlled compute</span><h3>SSH targets</h3><p>Register an alias already present in the user SSH config. The backend uses existing SSH keys or agent settings and installs no remote service.</p></div>
    <form className="remote-host-form" onSubmit={(event) => void addHost(event)}><label><span>SSH config alias</span><input required pattern="[A-Za-z0-9._-]+" value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="institution-hpc" /></label><button className="primary-button" disabled={busyId === "new" || !alias.trim()} type="submit">Probe and add</button></form>
    <div className="remote-host-list">{hosts.map((host) => <article className={`remote-host-card ${host.status}`} key={host.id}><div><strong>{host.alias}</strong><small>{capacity(host)}</small>{host.capabilities ? <small>Scratch: {host.capabilities.scratchPaths.join(", ") || "not detected"} · conda {host.capabilities.conda ? "yes" : "no"} · modules {host.capabilities.modules ? "yes" : "no"}</small> : null}</div><span>{host.status}</span><button className="secondary-button" disabled={Boolean(busyId)} onClick={() => void (async () => { setBusyId(host.id); try { if (!await ensureHostPermission(host.alias)) return; const updated = await client.probeRemoteHost(host.id); await refresh(); if (updated.error) onError(updated.error); } catch (error) { onError(error instanceof Error ? error.message : "Probe failed"); } finally { setBusyId(undefined); } })()} type="button">Refresh probe</button><button className="danger-button" disabled={Boolean(busyId)} onClick={() => void (async () => { setBusyId(host.id); try { await client.deleteRemoteHost(host.id); await refresh(); } catch (error) { onError(error instanceof Error ? error.message : "Could not delete host"); } finally { setBusyId(undefined); } })()} type="button">Delete</button></article>)}</div>
    <div className="config-note">The capability probe only reads CPU, memory, GPU/CUDA, package/module/container availability, scratch locations, and SLURM client presence. Remote jobs remain separately approval-gated.</div>
  </div>;
}

export function RemoteJobsPanel({
  busy,
  expandedCards,
  jobs,
  onDecision,
  onRefresh,
  onToggleCard,
}: ActivityCardDisclosure & {
  busy: boolean;
  jobs: RemoteJob[];
  onDecision: (job: RemoteJob, decision: PermissionDecision) => void;
  onRefresh: (job: RemoteJob) => void;
}) {
  if (!jobs.length) return null;
  return <section aria-label="Remote job approval cards" className="remote-jobs-panel"><div className="track-list-heading"><strong>Remote jobs</strong><span>{jobs.length} cards · separate approval required</span></div>{jobs.map((job) => {
    const cardId = activityCardId("remote-job", job.id);
    // A job waiting for approval is the only place to grant it, so it starts
    // expanded; an explicit toggle always wins, letting the user fold it away.
    const expanded = expandedCards[cardId] ?? job.state === "awaiting_approval";
    return <article className={`remote-job-card ${job.state}`} key={job.id}>
      <button aria-expanded={expanded} className="remote-job-heading" onClick={() => onToggleCard(cardId, !expanded)} type="button">
        <span className="card-chevron"><ChevronRightIcon size={15} /></span>
        <span><strong>{job.card.mode.toLocaleUpperCase()} · {job.card.targetAlias}</strong><small>{job.card.resources.cpus} CPU · {job.card.resources.memoryMb} MiB · {job.card.resources.gpus} GPU · {job.card.resources.walltimeMinutes} min</small></span>
        <i>{job.state.replaceAll("_", " ")}</i>
      </button>
      {expanded ? <div className="remote-job-body">
        <pre>{job.card.command}</pre>
        <p><strong>Working directory</strong>{job.card.remoteWorkingDirectory}</p>
        {job.card.inputPaths.length ? <p><strong>In-place inputs</strong>{job.card.inputPaths.join(" · ")}</p> : null}
        {job.card.outputs.length ? <ul>{job.card.outputs.map((output) => <li key={`${output.path}:${output.disposition}`}>{output.path} <em>{output.disposition === "pull" ? "pull if ≤1 MiB" : "leave remote"}</em></li>)}</ul> : null}
        {job.state === "awaiting_approval" ? <PermissionDecisionActions busy={busy} onDecision={(decision) => onDecision(job, decision)} /> : null}
        {job.card.mode === "slurm" && ["submitted", "running"].includes(job.state) ? <button className="secondary-button" disabled={busy} onClick={() => onRefresh(job)} type="button">Refresh SLURM status</button> : null}
        {job.remoteJobId ? <p><strong>Scheduler job</strong>{job.remoteJobId} · {job.scriptReference}</p> : null}
        {job.outputRecords.length ? <ul className="remote-output-list">{job.outputRecords.map((output) => <li key={output.path}>{output.localPath ?? output.path} <em>{output.status}</em></li>)}</ul> : null}
        {job.error ? <p className="environment-error">{job.error}</p> : null}
      </div> : null}
    </article>;
  })}</section>;
}

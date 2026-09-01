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

import type {
  PermissionDecision,
  PermissionRequest,
  Project,
  RemoteHostTarget,
  RemoteJob,
  RemoteWorkspaceSyncRecord,
  Session,
} from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { ChevronRightIcon } from "./icons.js";
import { PermissionDecisionActions } from "./PermissionDecisionActions.js";
import { activityCardId, type ActivityCardDisclosure } from "./session/run-activity.js";

function capacity(host: RemoteHostTarget): string {
  const capabilities = host.capabilities;
  if (!capabilities) return host.error ?? "Probe unavailable";
  if (host.connectionKind === "direct") {
    return `${host.endpoint?.protocol ?? "http"}://${host.endpoint?.host ?? "?"}:${host.endpoint?.port ?? "?"} · token authenticated`;
  }
  const memoryGiB = capabilities.memoryBytes ? Math.round(capabilities.memoryBytes / 1024 ** 3) : undefined;
  return [
    capabilities.cpuCores ? `${capabilities.cpuCores} CPU` : "CPU unknown",
    memoryGiB ? `${memoryGiB} GiB` : "memory unknown",
    capabilities.gpu ?? "no GPU detected",
    capabilities.slurm ? "SLURM" : "direct SSH",
  ].join(" · ");
}

/** How this host will get a runner, so the card says it before the user connects. */
function runnerSource(host: RemoteHostTarget): string {
  if (host.connectionKind === "direct") return "started by you on that machine";
  if (host.capabilities?.runnerCommandAvailable) return `runner ${host.runnerCommand} already installed`;
  return host.capabilities?.nodeVersion
    ? `deployed automatically over SSH (Node ${host.capabilities.nodeVersion})`
    : "cannot deploy: no runner and no Node.js 22+ found";
}

/**
 * Whether a Session can execute on this host. SSH hosts must be Linux and must
 * either carry the runner already or be able to receive the deployed one.
 */
function runnerUsable(host: RemoteHostTarget): boolean {
  if (host.status !== "ready") return false;
  if (host.connectionKind === "direct") return Boolean(host.endpoint && host.hasToken);
  return host.capabilities?.platform === "Linux"
    && (host.capabilities.runnerCommandAvailable || Boolean(host.capabilities.nodeVersion));
}

export function RemoteHostManager({ client, onError, onPermissionRequest, onProjectChange, onSessionChange, project, session }: {
  client: ApiClient;
  onError: (message: string) => void;
  onPermissionRequest: (request: PermissionRequest) => void;
  onProjectChange: (project: Project) => void;
  onSessionChange: (session: Session) => void;
  project?: Project;
  session?: Session;
}) {
  const [hosts, setHosts] = useState<RemoteHostTarget[]>([]);
  const [alias, setAlias] = useState("");
  const [runnerCommand, setRunnerCommand] = useState("sciencediscovery-runner");
  const [directLabel, setDirectLabel] = useState("");
  const [directAddress, setDirectAddress] = useState("");
  const [directPort, setDirectPort] = useState("4311");
  const [directToken, setDirectToken] = useState("");
  const [busyId, setBusyId] = useState<string>();
  const [syncRecords, setSyncRecords] = useState<RemoteWorkspaceSyncRecord[]>([]);

  async function refresh(): Promise<void> {
    setHosts(await client.listRemoteHosts());
  }

  useEffect(() => { void refresh().catch((error: Error) => onError(error.message)); }, [client]);
  useEffect(() => {
    if (!session?.remoteRunnerHostId) {
      setSyncRecords([]);
      return;
    }
    void client.listRemoteWorkspaceSyncs(session.id)
      .then(setSyncRecords)
      .catch((error: Error) => onError(error.message));
  }, [client, session?.id, session?.remoteRunnerHostId]);

  async function ensureHostPermission(hostAlias: string): Promise<boolean> {
    if (!session) throw new Error("Open a Session before authorizing an SSH host");
    const result = await client.createPermissionRequest(session.id, {
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
      const host = await client.registerRemoteHost({
        alias: alias.trim(),
        connectionKind: "ssh",
        runnerCommand: runnerCommand.trim(),
      });
      setAlias("");
      await refresh();
      if (host.error) onError(host.error);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not register SSH host");
    } finally {
      setBusyId(undefined);
    }
  }

  /**
   * Register a runner the user started themselves. The token is sent once and
   * then only ever lives encrypted in the API's credential store, so the form
   * clears it as soon as the machine is registered.
   */
  async function addDirectHost(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusyId("new-direct");
    try {
      const host = await client.registerRemoteHost({
        alias: directLabel.trim(),
        connectionKind: "direct",
        endpoint: { host: directAddress.trim(), port: Number(directPort), protocol: "http" },
        token: directToken,
      });
      setDirectLabel("");
      setDirectAddress("");
      setDirectToken("");
      await refresh();
      if (host.error) onError(host.error);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not register the runner");
    } finally {
      setBusyId(undefined);
    }
  }

  return <div className="remote-host-manager">
    <div className="settings-detail-header"><span className="eyebrow">Institution-controlled compute</span><h3>SSH machines</h3><p>Register a Linux alias already present in the user SSH config. ScienceDiscovery uses the runner executable if that machine already has one, and otherwise deploys and starts its own runner over the same SSH connection — no manual install. Versions are shown and differences are flagged.</p></div>
    <form className="remote-host-form" onSubmit={(event) => void addHost(event)}><label><span>SSH config alias</span><input required pattern="[A-Za-z0-9._-]+" value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="institution-hpc" /></label><label><span>Runner executable</span><input required value={runnerCommand} onChange={(event) => setRunnerCommand(event.target.value)} placeholder="sciencediscovery-runner" /></label><button className="primary-button" disabled={busyId === "new" || !alias.trim() || !runnerCommand.trim()} type="submit">Probe and add</button></form>
    <div className="settings-detail-header"><span className="eyebrow">Self-deployed runner</span><h3>Runner on another machine</h3><p>Start a runner yourself on the other machine with a listening address and <code>SCIENCE_AGENT_RUNNER_TOKEN</code>, then connect to it by IP address and port. The token is stored encrypted and never shown again; without it the connection is refused. Use this only over a network you trust, or put the runner behind your own TLS endpoint.</p></div>
    <form className="remote-host-form" onSubmit={(event) => void addDirectHost(event)}><label><span>Name</span><input required pattern="[A-Za-z0-9._-]+" value={directLabel} onChange={(event) => setDirectLabel(event.target.value)} placeholder="lab-workstation" /></label><label><span>IP address or hostname</span><input required value={directAddress} onChange={(event) => setDirectAddress(event.target.value)} placeholder="192.168.1.20" /></label><label><span>Port</span><input required inputMode="numeric" value={directPort} onChange={(event) => setDirectPort(event.target.value)} placeholder="4311" /></label><label><span>Token</span><input required type="password" value={directToken} onChange={(event) => setDirectToken(event.target.value)} placeholder="SCIENCE_AGENT_RUNNER_TOKEN" /></label><button className="primary-button" disabled={busyId === "new-direct" || !directLabel.trim() || !directAddress.trim() || !directToken.trim()} type="submit">Connect and add</button></form>
    <div className="remote-host-list">{hosts.map((host) => {
      const connected = host.runnerStatus?.state === "ready";
      return <article className={`remote-host-card ${host.status}`} key={host.id}><div><strong>{host.alias}</strong><small>{host.connectionKind === "direct" ? "self-deployed" : "SSH"} · {capacity(host)}</small><small>{host.connectionKind === "direct" ? host.capabilities?.platform ?? "OS unknown" : `${host.capabilities?.platform ?? "OS unknown"} · ${runnerSource(host)}`}</small>{host.runnerStatus?.remoteVersion ? <small>Remote {host.runnerStatus.remoteVersion} · local {host.runnerStatus.localVersion ?? "unknown"}{host.runnerStatus.versionMismatch ? " · version differs" : ""}{host.runnerStatus.deployed ? " · deployed by ScienceDiscovery" : ""}</small> : null}{host.runnerStatus?.error ? <small>{host.runnerStatus.error}</small> : null}</div><span>{connected ? "connected" : host.runnerStatus?.state ?? host.status}</span><button className="secondary-button" disabled={Boolean(busyId) || (!connected && !runnerUsable(host))} onClick={() => void (async () => { setBusyId(`runner:${host.id}`); try { connected ? await client.disconnectRemoteRunner(host.id) : await client.connectRemoteRunner(host.id); await refresh(); } catch (error) { onError(error instanceof Error ? error.message : "Runner connection failed"); await refresh(); } finally { setBusyId(undefined); } })()} type="button">{connected ? "Disconnect" : "Connect runner"}</button><button className="secondary-button" disabled={Boolean(busyId)} onClick={() => void (async () => { setBusyId(host.id); try { if (host.connectionKind === "ssh" && !await ensureHostPermission(host.alias)) return; const updated = await client.probeRemoteHost(host.id); await refresh(); if (updated.error) onError(updated.error); } catch (error) { onError(error instanceof Error ? error.message : "Probe failed"); } finally { setBusyId(undefined); } })()} type="button">Refresh probe</button><button className="danger-button" disabled={Boolean(busyId)} onClick={() => void (async () => { setBusyId(host.id); try { await client.deleteRemoteHost(host.id); await refresh(); } catch (error) { onError(error instanceof Error ? error.message : "Could not delete host"); } finally { setBusyId(undefined); } })()} type="button">Delete</button></article>;
    })}</div>
    {project ? <section className="remote-host-manager"><div className="settings-detail-header"><span className="eyebrow">Project boundary</span><h3>Allowed remote runners</h3><p>Only checked machines can appear in this Project's Session selector or Agent context.</p></div>{hosts.filter(runnerUsable).map((host) => <label key={host.id}><input checked={project.remoteRunnerHostIds.includes(host.id)} disabled={Boolean(busyId)} onChange={() => void (async () => { setBusyId(`project:${host.id}`); try { const ids = project.remoteRunnerHostIds.includes(host.id) ? project.remoteRunnerHostIds.filter((id) => id !== host.id) : [...project.remoteRunnerHostIds, host.id]; onProjectChange(await client.updateProject(project.id, { remoteRunnerHostIds: ids })); } catch (error) { onError(error instanceof Error ? error.message : "Could not update Project allowlist"); } finally { setBusyId(undefined); } })()} type="checkbox" /> <span>{host.alias}</span></label>)}</section> : null}
    {project && session ? <section className="remote-host-manager"><div className="settings-detail-header"><span className="eyebrow">Fixed Session target</span><h3>Execution runner</h3><p>Python, R, shell, persistent kernels, and the sandbox use this target until you change it. The Agent never selects a machine.</p></div><label><span>Runner</span><select disabled={Boolean(busyId)} value={session.remoteRunnerHostId ?? ""} onChange={(event) => void (async () => { setBusyId("session-runner"); try { onSessionChange(await client.updateSession(session.id, { remoteRunnerHostId: event.target.value || null })); } catch (error) { onError(error instanceof Error ? error.message : "Could not change Session runner"); } finally { setBusyId(undefined); } })()}><option value="">Local runner</option>{hosts.filter((host) => project.remoteRunnerHostIds.includes(host.id) && runnerUsable(host)).map((host) => <option key={host.id} value={host.id}>{host.alias}</option>)}</select></label></section> : null}
    {session?.remoteRunnerHostId ? <section className="remote-host-manager"><div className="settings-detail-header"><span className="eyebrow">Independent workspaces</span><h3>Remote workspace</h3><p>The remote workspace is separate from this Session's local workspace and persists across connections. Only the model transfers files, by naming the paths it needs; nothing is mirrored on connect, cancel, disconnect, or a target change.</p></div><div className="config-note">Transfers made by the model appear below. Deleting the remote workspace is the only destructive action offered here, and it is never automatic.</div>{syncRecords.slice(0, 10).map((record) => <small key={record.id}>{record.direction} · {record.status} · {record.fileCount} files · {record.bytes} bytes · {record.paths.join(", ")}{record.error ? ` · ${record.error}` : ""}</small>)}<div><button className="danger-button" disabled={Boolean(busyId)} onClick={() => void (async () => { if (!window.confirm("Delete every file in this Session's remote workspace? This cannot be undone.")) return; setBusyId("delete-remote-workspace"); try { await client.deleteRemoteWorkspace(session.id); } catch (error) { onError(error instanceof Error ? error.message : "Could not delete remote workspace"); } finally { setBusyId(undefined); } })()} type="button">Delete remote workspace</button></div></section> : null}
    <div className="config-note">The SSH/SLURM one-shot job card remains a separate feature and approval flow. Connecting or selecting a runner does not turn those jobs into runner executions.</div>
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

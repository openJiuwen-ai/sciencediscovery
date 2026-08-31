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
  const memoryGiB = capabilities.memoryBytes ? Math.round(capabilities.memoryBytes / 1024 ** 3) : undefined;
  return [
    capabilities.cpuCores ? `${capabilities.cpuCores} CPU` : "CPU unknown",
    memoryGiB ? `${memoryGiB} GiB` : "memory unknown",
    capabilities.gpu ?? "no GPU detected",
    capabilities.slurm ? "SLURM" : "direct SSH",
  ].join(" · ");
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
  const [busyId, setBusyId] = useState<string>();
  const [syncPaths, setSyncPaths] = useState("");
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
      const host = await client.registerRemoteHost({ alias: alias.trim(), runnerCommand: runnerCommand.trim() });
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
    <div className="settings-detail-header"><span className="eyebrow">Institution-controlled compute</span><h3>SSH targets and runners</h3><p>Register a Linux alias already present in the user SSH config and name its pre-installed runner executable. ScienceDiscovery displays versions and warns on differences; it never installs or upgrades the remote runner.</p></div>
    <form className="remote-host-form" onSubmit={(event) => void addHost(event)}><label><span>SSH config alias</span><input required pattern="[A-Za-z0-9._-]+" value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="institution-hpc" /></label><label><span>Runner executable</span><input required value={runnerCommand} onChange={(event) => setRunnerCommand(event.target.value)} placeholder="sciencediscovery-runner" /></label><button className="primary-button" disabled={busyId === "new" || !alias.trim() || !runnerCommand.trim()} type="submit">Probe and add</button></form>
    <div className="remote-host-list">{hosts.map((host) => {
      const runnerReady = host.capabilities?.platform === "Linux" && host.capabilities.runnerCommandAvailable;
      const connected = host.runnerStatus?.state === "ready";
      return <article className={`remote-host-card ${host.status}`} key={host.id}><div><strong>{host.alias}</strong><small>{capacity(host)}</small><small>{host.capabilities?.platform ?? "OS unknown"} · runner {host.runnerCommand} {host.capabilities?.runnerCommandAvailable ? "found" : "not found"}</small>{host.runnerStatus?.remoteVersion ? <small>Remote {host.runnerStatus.remoteVersion} · local {host.runnerStatus.localVersion ?? "unknown"}{host.runnerStatus.versionMismatch ? " · version differs" : ""}</small> : null}{host.runnerStatus?.error ? <small>{host.runnerStatus.error}</small> : null}</div><span>{connected ? "connected" : host.runnerStatus?.state ?? host.status}</span><button className="secondary-button" disabled={Boolean(busyId) || (!connected && !runnerReady)} onClick={() => void (async () => { setBusyId(`runner:${host.id}`); try { connected ? await client.disconnectRemoteRunner(host.id) : await client.connectRemoteRunner(host.id); await refresh(); } catch (error) { onError(error instanceof Error ? error.message : "Runner connection failed"); await refresh(); } finally { setBusyId(undefined); } })()} type="button">{connected ? "Disconnect" : "Connect runner"}</button><button className="secondary-button" disabled={Boolean(busyId)} onClick={() => void (async () => { setBusyId(host.id); try { if (!await ensureHostPermission(host.alias)) return; const updated = await client.probeRemoteHost(host.id); await refresh(); if (updated.error) onError(updated.error); } catch (error) { onError(error instanceof Error ? error.message : "Probe failed"); } finally { setBusyId(undefined); } })()} type="button">Refresh probe</button><button className="danger-button" disabled={Boolean(busyId)} onClick={() => void (async () => { setBusyId(host.id); try { await client.deleteRemoteHost(host.id); await refresh(); } catch (error) { onError(error instanceof Error ? error.message : "Could not delete host"); } finally { setBusyId(undefined); } })()} type="button">Delete</button></article>;
    })}</div>
    {project ? <section className="remote-host-manager"><div className="settings-detail-header"><span className="eyebrow">Project boundary</span><h3>Allowed remote runners</h3><p>Only checked Linux hosts with the configured runner installed can appear in this Project's Session selector or Agent context.</p></div>{hosts.filter((host) => host.status === "ready" && host.capabilities?.platform === "Linux" && host.capabilities.runnerCommandAvailable).map((host) => <label key={host.id}><input checked={project.remoteRunnerHostIds.includes(host.id)} disabled={Boolean(busyId)} onChange={() => void (async () => { setBusyId(`project:${host.id}`); try { const ids = project.remoteRunnerHostIds.includes(host.id) ? project.remoteRunnerHostIds.filter((id) => id !== host.id) : [...project.remoteRunnerHostIds, host.id]; onProjectChange(await client.updateProject(project.id, { remoteRunnerHostIds: ids })); } catch (error) { onError(error instanceof Error ? error.message : "Could not update Project allowlist"); } finally { setBusyId(undefined); } })()} type="checkbox" /> <span>{host.alias}</span></label>)}</section> : null}
    {project && session ? <section className="remote-host-manager"><div className="settings-detail-header"><span className="eyebrow">Fixed Session target</span><h3>Execution runner</h3><p>Python, R, shell, persistent kernels, and the sandbox use this target until you change it. The Agent never selects a machine.</p></div><label><span>Runner</span><select disabled={Boolean(busyId)} value={session.remoteRunnerHostId ?? ""} onChange={(event) => void (async () => { setBusyId("session-runner"); try { onSessionChange(await client.updateSession(session.id, { remoteRunnerHostId: event.target.value || null })); } catch (error) { onError(error instanceof Error ? error.message : "Could not change Session runner"); } finally { setBusyId(undefined); } })()}><option value="">Local runner</option>{hosts.filter((host) => project.remoteRunnerHostIds.includes(host.id) && host.status === "ready" && host.capabilities?.platform === "Linux" && host.capabilities.runnerCommandAvailable).map((host) => <option key={host.id} value={host.id}>{host.alias}</option>)}</select></label></section> : null}
    {session?.remoteRunnerHostId ? <section className="remote-host-manager"><div className="settings-detail-header"><span className="eyebrow">Explicit transfer</span><h3>Workspace sync</h3><p>Local and remote workspaces are independent and persistent. Enter selected relative file or directory paths; no action runs on disconnect, cancel, or target changes.</p></div><label><span>Paths (one per line)</span><textarea value={syncPaths} onChange={(event) => setSyncPaths(event.target.value)} placeholder={"inputs/data.csv\nresults/"} /></label><div><button className="secondary-button" disabled={Boolean(busyId) || !syncPaths.trim()} onClick={() => void (async () => { setBusyId("sync-push"); try { await client.syncRemoteWorkspace(session.id, { direction: "push", paths: syncPaths.split(/\r?\n/).map((path) => path.trim()).filter(Boolean) }); setSyncRecords(await client.listRemoteWorkspaceSyncs(session.id)); } catch (error) { onError(error instanceof Error ? error.message : "Push failed"); } finally { setBusyId(undefined); } })()} type="button">Push selected paths</button> <button className="primary-button" disabled={Boolean(busyId) || !syncPaths.trim()} onClick={() => void (async () => { setBusyId("sync-pull"); try { await client.syncRemoteWorkspace(session.id, { direction: "pull", paths: syncPaths.split(/\r?\n/).map((path) => path.trim()).filter(Boolean) }); setSyncRecords(await client.listRemoteWorkspaceSyncs(session.id)); } catch (error) { onError(error instanceof Error ? error.message : "Pull failed"); } finally { setBusyId(undefined); } })()} type="button">Pull selected paths</button> <button className="danger-button" disabled={Boolean(busyId)} onClick={() => void (async () => { if (!window.confirm("Delete every file in this Session's remote workspace? This cannot be undone.")) return; setBusyId("delete-remote-workspace"); try { await client.deleteRemoteWorkspace(session.id); } catch (error) { onError(error instanceof Error ? error.message : "Could not delete remote workspace"); } finally { setBusyId(undefined); } })()} type="button">Delete remote workspace</button></div><div className="config-note">Existing destination files are rejected. The model can choose overwrite explicitly through its sync tool. Remote deletion is available only through the explicit button above.</div>{syncRecords.slice(0, 10).map((record) => <small key={record.id}>{record.direction} · {record.status} · {record.fileCount} files · {record.bytes} bytes · {record.paths.join(", ")}{record.error ? ` · ${record.error}` : ""}</small>)}</section> : null}
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

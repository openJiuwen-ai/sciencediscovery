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
  RegisterRemoteHostRequest,
  RemoteHostTarget,
  RemoteJob,
  RemoteWorkspaceSyncRecord,
  Session,
  UpdateSessionRequest,
} from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { ChevronRightIcon } from "./icons.js";
import { PermissionDecisionActions } from "./PermissionDecisionActions.js";
import { activityCardId, type ActivityCardDisclosure } from "./session/run-activity.js";

/**
 * Remote machines a Session may use: its own `remoteRunnerHostIds` override
 * (`[]` forbids every remote machine), else the Project allowlist. Local
 * execution stays available either way.
 */
export function effectiveRemoteRunnerHostIds(project: Project | undefined, session: Session | undefined): string[] {
  return session?.remoteRunnerHostIds ?? project?.remoteRunnerHostIds ?? [];
}

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

/** Fresh host catalog for the scoped settings sections, fetched on mount. */
function useRemoteHosts(client: ApiClient, onError: (message: string) => void): RemoteHostTarget[] | undefined {
  const [hosts, setHosts] = useState<RemoteHostTarget[]>();
  useEffect(() => {
    let cancelled = false;
    void client.listRemoteHosts()
      .then((list) => { if (!cancelled) setHosts(list); })
      .catch((error: Error) => { if (!cancelled) onError(error.message); });
    return () => { cancelled = true; };
    // onError is a stable App callback; the catalog reloads per client, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  return hosts;
}

function hostKindLabel(host: RemoteHostTarget): string {
  return host.connectionKind === "direct" ? "self-deployed" : "SSH";
}

/**
 * The global machine catalog: register, connect, probe, and delete remote
 * machines. Project/Session allowlists deliberately live on those objects'
 * own settings, not here.
 */
export function RemoteHostManager({ client, onError, onPermissionRequest, session }: {
  client: ApiClient;
  onError: (message: string) => void;
  onPermissionRequest: (request: PermissionRequest) => void;
  /** Only used to raise the SSH probe permission card. */
  session?: Session;
}) {
  const [hosts, setHosts] = useState<RemoteHostTarget[]>([]);
  const [adding, setAdding] = useState<"direct" | "ssh">();
  const [alias, setAlias] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [runnerCommand, setRunnerCommand] = useState("sciencediscovery-runner");
  const [directLabel, setDirectLabel] = useState("");
  const [directAddress, setDirectAddress] = useState("");
  const [directPort, setDirectPort] = useState("4311");
  const [directToken, setDirectToken] = useState("");
  const [busyId, setBusyId] = useState<string>();

  async function refresh(): Promise<void> {
    setHosts(await client.listRemoteHosts());
  }

  useEffect(() => { void refresh().catch((error: Error) => onError(error.message)); }, [client]);

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
      const port = sshPort.trim();
      const request: RegisterRemoteHostRequest = {
        alias: alias.trim(),
        connectionKind: "ssh",
        // Omitting the port lets the user's SSH config resolve the destination.
        ...(port ? { port: Number(port) } : {}),
        runnerCommand: runnerCommand.trim(),
      };
      const host = await client.registerRemoteHost(request);
      setAlias("");
      setSshPort("");
      setAdding(undefined);
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
      setAdding(undefined);
      await refresh();
      if (host.error) onError(host.error);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not register the runner");
    } finally {
      setBusyId(undefined);
    }
  }

  async function toggleRunnerConnection(host: RemoteHostTarget, connected: boolean): Promise<void> {
    setBusyId(`runner:${host.id}`);
    try {
      if (connected) await client.disconnectRemoteRunner(host.id);
      else await client.connectRemoteRunner(host.id);
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Runner connection failed");
      await refresh();
    } finally {
      setBusyId(undefined);
    }
  }

  async function probe(host: RemoteHostTarget): Promise<void> {
    setBusyId(host.id);
    try {
      if (host.connectionKind === "ssh" && !await ensureHostPermission(host.alias)) return;
      const updated = await client.probeRemoteHost(host.id);
      await refresh();
      if (updated.error) onError(updated.error);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Probe failed");
    } finally {
      setBusyId(undefined);
    }
  }

  async function removeHost(host: RemoteHostTarget): Promise<void> {
    if (!window.confirm(`Delete ${host.alias} from the machine catalog? Projects and Sessions that allow it lose access.`)) return;
    setBusyId(host.id);
    try {
      await client.deleteRemoteHost(host.id);
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not delete the machine");
    } finally {
      setBusyId(undefined);
    }
  }

  return <div className="remote-host-manager">
    <div className="settings-detail-header"><span className="eyebrow">Institution-controlled compute</span><h3>Remote machines</h3><p>Register the machines ScienceDiscovery may connect to: an SSH machine it deploys a runner onto itself, or a runner you started on another machine. Which machines a Project or Session may actually use is configured in that Project's or Session's own settings, not here.</p></div>
    {hosts.length ? <div className="remote-host-list">{hosts.map((host) => {
      const connected = host.runnerStatus?.state === "ready";
      const state = connected ? "ready" : host.runnerStatus?.state ?? host.status;
      return <article className={`remote-host-card ${host.status}`} key={host.id}>
        <div className="remote-host-card-main">
          <div className="remote-host-card-title"><strong>{host.alias}</strong><span className={`remote-host-status ${connected ? "ready" : state === "error" ? "error" : ""}`}>{connected ? "connected" : state}</span></div>
          <small>{hostKindLabel(host)} · {capacity(host)}</small>
          <small>{host.connectionKind === "direct" ? host.capabilities?.platform ?? "OS unknown" : `${host.capabilities?.platform ?? "OS unknown"} · ${runnerSource(host)}`}</small>
          {host.runnerStatus?.remoteVersion ? <small>Remote {host.runnerStatus.remoteVersion} · local {host.runnerStatus.localVersion ?? "unknown"}{host.runnerStatus.versionMismatch ? " · version differs" : ""}{host.runnerStatus.deployed ? " · deployed by ScienceDiscovery" : ""}</small> : null}
          {host.runnerStatus?.error ? <small>{host.runnerStatus.error}</small> : null}
        </div>
        <div className="remote-host-actions">
          <button className="secondary-button" disabled={Boolean(busyId) || (!connected && !runnerUsable(host))} onClick={() => void toggleRunnerConnection(host, connected)} type="button">{connected ? "Disconnect" : "Connect runner"}</button>
          <button className="secondary-button" disabled={Boolean(busyId)} onClick={() => void probe(host)} type="button">Refresh probe</button>
          <button className="danger-button" disabled={Boolean(busyId)} onClick={() => void removeHost(host)} type="button">Delete</button>
        </div>
      </article>;
    })}</div> : <p className="remote-host-empty">No remote machines registered yet.</p>}
    <div className="remote-host-add-row">
      <button aria-expanded={adding === "ssh"} className="secondary-button" onClick={() => setAdding(adding === "ssh" ? undefined : "ssh")} type="button">Add SSH machine</button>
      <button aria-expanded={adding === "direct"} className="secondary-button" onClick={() => setAdding(adding === "direct" ? undefined : "direct")} type="button">Add self-deployed runner</button>
    </div>
    {adding === "ssh" ? <form className="remote-host-form" onSubmit={(event) => void addHost(event)}>
      <p className="remote-host-form-help">An alias from your SSH config or a plain IP/hostname — one field for both. Leave the port empty to resolve it (including HostName and Port) from your SSH config. ScienceDiscovery probes the machine and, when no runner is installed, deploys and starts its own runner over the same SSH connection — no manual install. Versions are shown and differences are flagged.</p>
      <div className="remote-host-form-fields">
        <label><span>SSH alias or IP/hostname</span><input required value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="institution-hpc or 192.168.1.20" /></label>
        <label><span>Port (optional)</span><input inputMode="numeric" value={sshPort} onChange={(event) => setSshPort(event.target.value)} placeholder="From SSH config" /></label>
        <label><span>Runner executable</span><input required value={runnerCommand} onChange={(event) => setRunnerCommand(event.target.value)} placeholder="sciencediscovery-runner" /></label>
      </div>
      <div className="remote-host-form-actions">
        <button className="secondary-button" onClick={() => setAdding(undefined)} type="button">Cancel</button>
        <button className="primary-button" disabled={busyId === "new" || !alias.trim() || !runnerCommand.trim()} type="submit">Probe and add</button>
      </div>
    </form> : null}
    {adding === "direct" ? <form className="remote-host-form" onSubmit={(event) => void addDirectHost(event)}>
      <p className="remote-host-form-help">Start a runner yourself on the other machine with a listening address and <code>SCIENCE_AGENT_RUNNER_TOKEN</code>, then connect to it by IP address and port. The token is stored encrypted and never shown again; without it the connection is refused. Use this only over a network you trust, or put the runner behind your own TLS endpoint.</p>
      <div className="remote-host-form-fields">
        <label><span>Name</span><input required pattern="[A-Za-z0-9._-]+" value={directLabel} onChange={(event) => setDirectLabel(event.target.value)} placeholder="lab-workstation" /></label>
        <label><span>IP address or hostname</span><input required value={directAddress} onChange={(event) => setDirectAddress(event.target.value)} placeholder="192.168.1.20" /></label>
        <label><span>Port</span><input required inputMode="numeric" value={directPort} onChange={(event) => setDirectPort(event.target.value)} placeholder="4311" /></label>
        <label><span>Token</span><input required type="password" value={directToken} onChange={(event) => setDirectToken(event.target.value)} placeholder="SCIENCE_AGENT_RUNNER_TOKEN" /></label>
      </div>
      <div className="remote-host-form-actions">
        <button className="secondary-button" onClick={() => setAdding(undefined)} type="button">Cancel</button>
        <button className="primary-button" disabled={busyId === "new-direct" || !directLabel.trim() || !directAddress.trim() || !directToken.trim()} type="submit">Connect and add</button>
      </div>
    </form> : null}
    <div className="config-note">The SSH/SLURM one-shot job card remains a separate feature and approval flow. Connecting or allowing a runner does not turn those jobs into runner executions.</div>
  </div>;
}

/** Project-scoped allowlist, rendered inside the Project settings dialog. */
export function ProjectRemoteSettings({ client, onError, onProjectChange, project }: {
  client: ApiClient;
  onError: (message: string) => void;
  onProjectChange: (project: Project) => void;
  project: Project;
}) {
  const hosts = useRemoteHosts(client, onError);
  const [busyId, setBusyId] = useState<string>();
  const usable = (hosts ?? []).filter(runnerUsable);

  async function toggle(host: RemoteHostTarget): Promise<void> {
    setBusyId(host.id);
    try {
      const ids = project.remoteRunnerHostIds.includes(host.id)
        ? project.remoteRunnerHostIds.filter((id) => id !== host.id)
        : [...project.remoteRunnerHostIds, host.id];
      onProjectChange(await client.updateProject(project.id, { remoteRunnerHostIds: ids }));
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not update Project allowlist");
    } finally {
      setBusyId(undefined);
    }
  }

  return <section className="scoped-remote-settings">
    <div className="editor-heading"><strong>Remote compute</strong><small>Remote machines this Project's Sessions may use. Register and connect machines in system settings → Remote compute.</small></div>
    {!hosts ? <p className="muted">Loading remote machines…</p>
      : usable.length ? <div className="settings-choices">{usable.map((host) => <label key={host.id}>
        <input checked={project.remoteRunnerHostIds.includes(host.id)} disabled={Boolean(busyId)} onChange={() => void toggle(host)} type="checkbox" />
        <span>{host.alias}<small>{hostKindLabel(host)}</small></span>
      </label>)}</div>
      : <p className="settings-choice-empty">No usable remote machines yet. Add one in system settings → Remote compute.</p>}
  </section>;
}

/**
 * Session-scoped override of the Project allowlist, plus the read-only remote
 * workspace record, rendered inside the Session settings dialog. Allowing a
 * remote machine only makes it available; local file access and local
 * execution always stay available.
 */
export function SessionRemoteSettings({ client, disabled = false, onError, onSessionChange, project, session }: {
  client: ApiClient;
  disabled?: boolean;
  onError: (message: string) => void;
  onSessionChange: (session: Session) => void;
  project: Project;
  session: Session;
}) {
  const hosts = useRemoteHosts(client, onError);
  const [syncRecords, setSyncRecords] = useState<RemoteWorkspaceSyncRecord[]>([]);
  const [busyId, setBusyId] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void client.listRemoteWorkspaceSyncs(session.id)
      .then((records) => { if (!cancelled) setSyncRecords(records); })
      .catch((error: Error) => { if (!cancelled) onError(error.message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, session.id]);

  const override = session.remoteRunnerHostIds;
  const mode = override == null ? "inherit" : "override";
  const projectHosts = (hosts ?? []).filter((host) => project.remoteRunnerHostIds.includes(host.id) && runnerUsable(host));
  const effectiveIds = effectiveRemoteRunnerHostIds(project, session);
  const effectiveHosts = (hosts ?? []).filter((host) => effectiveIds.includes(host.id));

  async function update(body: UpdateSessionRequest, fallback: string): Promise<void> {
    setBusyId("session-remote");
    try {
      onSessionChange(await client.updateSession(session.id, body));
    } catch (error) {
      onError(error instanceof Error ? error.message : fallback);
    } finally {
      setBusyId(undefined);
    }
  }

  async function setMode(next: "inherit" | "override"): Promise<void> {
    if (next === "inherit") await update({ remoteRunnerHostIds: null }, "Could not restore the Project allowlist");
    // Start the override from what the Session may use today, so switching
    // modes never silently widens or drops machines.
    else await update({ remoteRunnerHostIds: effectiveIds }, "Could not override the allowlist");
  }

  async function toggle(host: RemoteHostTarget): Promise<void> {
    const selected = override ?? project.remoteRunnerHostIds;
    const ids = selected.includes(host.id)
      ? selected.filter((id) => id !== host.id)
      : [...selected, host.id];
    await update({ remoteRunnerHostIds: ids }, "Could not update the Session allowlist");
  }

  // Each allowed machine owns a separate remote workspace; records and the
  // destructive delete are grouped under the machine they belong to.
  const workspaceHosts: Array<{ alias: string; id: string }> = [];
  for (const host of effectiveHosts) workspaceHosts.push({ alias: host.alias, id: host.id });
  for (const record of syncRecords) {
    if (!workspaceHosts.some((host) => host.id === record.hostId)) {
      workspaceHosts.push({ alias: hosts?.find((host) => host.id === record.hostId)?.alias ?? record.hostId, id: record.hostId });
    }
  }

  async function deleteWorkspace(host: { alias: string; id: string }): Promise<void> {
    if (!window.confirm(`Delete every file in this Session's remote workspace on ${host.alias}? This cannot be undone.`)) return;
    setBusyId(`delete-remote-workspace:${host.id}`);
    try {
      await client.deleteRemoteWorkspace(session.id, host.id);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not delete remote workspace");
    } finally {
      setBusyId(undefined);
    }
  }

  return <section className="scoped-remote-settings">
    <div className="editor-heading"><strong>Remote compute</strong><small>Remote machines this Session may use. Allowing one only makes it available — local file access and local execution stay available either way.</small></div>
    <label className="settings-field">
      <span>Allowed remote runners</span>
      <select disabled={disabled || Boolean(busyId)} value={mode} onChange={(event) => void setMode(event.target.value as "inherit" | "override")}>
        <option value="inherit">Inherit · Project allows {project.remoteRunnerHostIds.length}</option>
        <option value="override">Override · {mode === "override" ? (override?.length ?? 0) : effectiveIds.length} selected</option>
      </select>
    </label>
    {mode === "override" ? (
      !hosts ? <p className="muted">Loading remote machines…</p>
        : projectHosts.length ? <div className="settings-choices">{projectHosts.map((host) => <label key={host.id}>
          <input checked={(override ?? []).includes(host.id)} disabled={disabled || Boolean(busyId)} onChange={() => void toggle(host)} type="checkbox" />
          <span>{host.alias}<small>{hostKindLabel(host)}</small></span>
        </label>)}</div>
        : <p className="settings-choice-empty">This Project allows no remote machines yet; widen it in the Project settings.</p>
    ) : null}
    {workspaceHosts.length > 0 ? <div className="remote-workspace-panel">
      <div className="editor-heading"><strong>Remote workspace</strong><small>Each machine keeps a workspace separate from this Session's local one, across connections. Only the model transfers files, by naming the paths it needs; nothing is mirrored on connect, cancel, or disconnect.</small></div>
      {workspaceHosts.map((host) => {
        const records = syncRecords.filter((record) => record.hostId === host.id);
        return <div className="remote-workspace-host" key={host.id}>
          <strong>{host.alias}</strong>
          <div className="remote-workspace-records">
            {records.length ? records.slice(0, 10).map((record) => <small key={record.id}>{record.direction} · {record.status} · {record.fileCount} files · {record.bytes} bytes · {record.paths.join(", ")}{record.error ? ` · ${record.error}` : ""}</small>) : <small>No transfers yet.</small>}
          </div>
          <div className="remote-workspace-actions"><button className="danger-button" disabled={disabled || Boolean(busyId)} onClick={() => void deleteWorkspace(host)} type="button">Delete remote workspace</button></div>
        </div>;
      })}
    </div> : null}
  </section>;
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

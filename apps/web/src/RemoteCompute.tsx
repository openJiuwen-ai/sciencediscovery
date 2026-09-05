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

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import type {
  PermissionDecision,
  Project,
  SshConfigHostImport,
  RemoteHostTarget,
  RemoteJob,
  RemoteWorkspaceSyncRecord,
  Session,
  UpdateSessionRequest,
} from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { hostKeyFromError, type GeneratedRemoteHostKey, type RemoteHostKeyInfo } from "./api/settings.js";
import { CopyButton } from "./CopyButton.js";
import { SshKeyFileField } from "./SshKeyFileField.js";
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
  if (host.error) return "Probe failed";
  if (!capabilities) return "Probe unavailable";
  if (host.connectionKind === "direct") {
    return `${host.endpoint?.protocol ?? "http"}://${host.endpoint?.host ?? "?"}:${host.endpoint?.port ?? "?"} · token authenticated`;
  }
  const memoryGiB = capabilities.memoryBytes ? Math.round(capabilities.memoryBytes / 1024 ** 3) : undefined;
  return [
    capabilities.cpuCores ? `${capabilities.cpuCores} CPU` : "CPU unknown",
    memoryGiB ? `${memoryGiB} GiB` : "memory unknown",
    capabilities.gpu ?? "no GPU detected",
    "sandboxed Runner",
  ].join(" · ");
}

/** How a successfully probed Linux host will get a runner. */
function runnerSource(host: RemoteHostTarget): string | undefined {
  if (host.connectionKind === "direct") return "started by you on that machine";
  if (host.status !== "ready" || host.error) return undefined;
  const capabilities = host.capabilities;
  if (capabilities?.platform !== "Linux") return undefined;
  if (capabilities.runnerCommandAvailable) return `runner ${host.runnerCommand} already installed`;
  return "SEA runner deployed automatically over SSH; remote Node.js is not required";
}

function resourceBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function RunnerResourceSummary({ host }: { host: RemoteHostTarget }): ReactNode {
  const resources = host.runnerStatus?.resources;
  if (host.runnerStatus?.state !== "ready") return <small>Workspace disk: unknown · connect Runner to measure</small>;
  if (!resources) return <small>{host.runnerStatus.resourcesError ?? "Workspace disk: metrics not available yet"}</small>;
  const disk = resources.workspaceDisk;
  return <div className="remote-host-resources" aria-label="Runner resources">
    <strong>Workspace disk: {disk ? `${resourceBytes(disk.availableBytes)} available / ${resourceBytes(disk.totalBytes)} total` : "unknown"}</strong>
    {disk ? <small className="remote-host-resource-path">{disk.path}</small> : <small>{resources.workspaceDiskError}</small>}
    {disk && (disk.availableBytes < 1024 ** 3 || disk.availableBytes < disk.totalBytes * 0.1)
      ? <div role="alert">Low workspace disk space. Environment installs and file writes may fail.</div> : null}
    <small>Filesystem free space, not a per-workspace quota. Other files on this filesystem share this space.</small>
    <small>CPU: {resources.cpuCores} cores · load (1 min): {resources.loadAverage1m.toFixed(2)}</small>
    <small>Memory: {resourceBytes(resources.memoryFreeBytes)} free / {resourceBytes(resources.memoryTotalBytes)} total · host uptime: {Math.floor(resources.uptimeSeconds / 3600)} h</small>
    <small>Measured {new Date(resources.capturedAt).toLocaleString()} · refresh to update. Host readings may differ from container limits.</small>
  </div>;
}

/**
 * Whether a Session can execute on this host. SSH hosts must be Linux and must
 * either carry the runner already or be able to receive the deployed one.
 */
function runnerUsable(host: RemoteHostTarget): boolean {
  if (host.status !== "ready") return false;
  if (host.connectionKind === "direct") return Boolean(host.endpoint && host.hasToken);
  return host.capabilities?.platform === "Linux";
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

interface HostKeyPrompt {
  changed: boolean;
  hostKey: RemoteHostKeyInfo;
  /** Where the card renders: the add form, or the machine card that raised it. */
  origin: "add" | string;
  target: string;
  resume: () => Promise<void>;
}

/**
 * The global machine catalog: register, connect, probe, and delete remote
 * machines — including SSH credentials and host-key trust, all inside this
 * dialog. Registering a machine here is a deliberate user action, so nothing
 * raises a permission card in the conversation; Project/Session allowlists
 * deliberately live on those objects' own settings.
 */
export function RemoteHostManager({ client, onCredentialEditStateChange, onError }: {
  client: ApiClient;
  onCredentialEditStateChange?: (editing: boolean) => void;
  onError: (message: string) => void;
}) {
  const [hosts, setHosts] = useState<RemoteHostTarget[]>([]);
  const [adding, setAdding] = useState<"direct" | "ssh">();
  const [alias, setAlias] = useState("");
  const [runnerName, setRunnerName] = useState("");
  const [description, setDescription] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [runnerCommand, setRunnerCommand] = useState("sciencediscovery-runner");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [generatedKey, setGeneratedKey] = useState<GeneratedRemoteHostKey>();
  const [configHosts, setConfigHosts] = useState<SshConfigHostImport[]>();
  const [configListOpen, setConfigListOpen] = useState(false);
  const [showCredentials, setShowCredentials] = useState(false);
  const [importNote, setImportNote] = useState("");
  const [directLabel, setDirectLabel] = useState("");
  const [directAddress, setDirectAddress] = useState("");
  const [directPort, setDirectPort] = useState("4311");
  const [directToken, setDirectToken] = useState("");
  const [busyId, setBusyId] = useState<string>();
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPrompt>();
  const [editingCredentials, setEditingCredentials] = useState<string>();
  const [credUsername, setCredUsername] = useState("");
  const [credPassword, setCredPassword] = useState("");
  const [credKeyPath, setCredKeyPath] = useState("");
  const [credPassphrase, setCredPassphrase] = useState("");
  const [credGeneratedKey, setCredGeneratedKey] = useState<GeneratedRemoteHostKey>();

  async function refresh(): Promise<void> {
    setHosts(await client.listRemoteHosts());
  }

  useEffect(() => { void refresh().catch((error: Error) => onError(error.message)); }, [client]);
  useEffect(() => () => onCredentialEditStateChange?.(false), [onCredentialEditStateChange]);

  function clearCredentialDraft(): void {
    setCredUsername("");
    setCredPassword("");
    setCredKeyPath("");
    setCredPassphrase("");
    setCredGeneratedKey(undefined);
  }

  function toggleCredentialsEditor(host: RemoteHostTarget): void {
    if (editingCredentials === host.id) {
      setEditingCredentials(undefined);
      clearCredentialDraft();
      onCredentialEditStateChange?.(false);
      return;
    }
    setEditingCredentials(host.id);
    setCredUsername(host.username ?? "");
    setCredPassword("");
    setCredKeyPath("");
    setCredPassphrase("");
    setCredGeneratedKey(undefined);
    onCredentialEditStateChange?.(true);
  }

  /** Password and key are write-only: clear them as soon as they are sent. */
  function clearSshForm(): void {
    setAlias("");
    setRunnerName("");
    setDescription("");
    setSshPort("");
    setUsername("");
    setPassword("");
    setKeyPath("");
    setKeyPassphrase("");
    setGeneratedKey(undefined);
    setConfigHosts(undefined);
    setConfigListOpen(false);
    setShowCredentials(false);
    setImportNote("");
  }

  /** Turn an untrusted/changed host key into an in-dialog trust card. */
  function handleFailure(error: unknown, target: string, origin: HostKeyPrompt["origin"], retry: (hostKey: RemoteHostKeyInfo) => Promise<void>, fallback: string): void {
    const keyIssue = hostKeyFromError(error);
    if (keyIssue) {
      setHostKeyPrompt({
        ...keyIssue,
        origin,
        target,
        resume: async () => {
          setHostKeyPrompt(undefined);
          await retry(keyIssue.hostKey);
        },
      });
      return;
    }
    onError(error instanceof Error ? error.message : fallback);
  }

  /** A probe can also fail softly with host.error; an untrusted key there opens the same trust card. */
  function reportHostError(host: RemoteHostTarget): void {
    if (host.hostKey && host.hostKey.trusted === false) {
      const hostKey = host.hostKey;
      setHostKeyPrompt({
        changed: false,
        hostKey,
        origin: host.id,
        target: host.alias,
        resume: async () => {
          setHostKeyPrompt(undefined);
          await probe(host, hostKey);
        },
      });
      return;
    }
    if (host.error) onError(host.error);
  }

  async function submitSshForm(trustHostKey?: RemoteHostKeyInfo, registeredHostId?: string): Promise<void> {
    setBusyId("new");
    try {
      const port = sshPort.trim();
      const host = registeredHostId && trustHostKey
        ? await client.trustRemoteHostKey(registeredHostId, trustHostKey)
        : await client.registerRemoteHost({
        alias: alias.trim(),
        runnerName: runnerName.trim() || alias.trim(),
        description: description.trim(),
        connectionKind: "ssh",
        // Omitting the port lets the user's SSH config resolve the destination.
        ...(port ? { port: Number(port) } : {}),
        runnerCommand: runnerCommand.trim(),
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(password ? { password } : {}),
        // A key file path — the API reads and encrypts the material; private
        // keys are never pasted into this UI.
        ...(keyPath.trim() ? { privateKeyPath: keyPath.trim() } : {}),
        ...(keyPassphrase ? { passphrase: keyPassphrase } : {}),
        ...(trustHostKey ? { trustHostKey } : {}),
      });
      clearSshForm();
      setAdding(undefined);
      await refresh();
      if (host.error) reportHostError(host);
    } catch (error) {
      const hostId = hostKeyFromError(error)?.hostId ?? registeredHostId;
      handleFailure(error, alias.trim(), "add", (hostKey) => submitSshForm(hostKey, hostId), "Could not register SSH host");
    } finally {
      setBusyId(undefined);
    }
  }

  /** Toggle the ssh_config Host list; entries are loaded once per dialog visit. */
  async function toggleConfigList(): Promise<void> {
    if (configListOpen) {
      setConfigListOpen(false);
      return;
    }
    setConfigListOpen(true);
    if (configHosts !== undefined) return;
    setBusyId("import");
    try {
      setConfigHosts(await client.listSshConfigHosts());
    } catch (error) {
      setConfigListOpen(false);
      onError(error instanceof Error ? error.message : "Could not read ssh_config");
    } finally {
      setBusyId(undefined);
    }
  }

  /** Resolve and import one selected entry; list responses intentionally omit key paths. */
  async function importSshConfigHost(selected: SshConfigHostImport): Promise<void> {
    setBusyId(`import:${selected.alias}`);
    try {
      const entry = await client.resolveSshConfigHost(selected.alias);
      // The product's SSH client does not consult ssh_config after import, so
      // copy the resolved destination into the shared alias/hostname field.
      setAlias(entry.hostName ?? entry.alias);
      setSshPort(entry.port ? String(entry.port) : "");
      setUsername(entry.username ?? "");
      setKeyPath(entry.identityFile ?? "");
      setGeneratedKey(undefined);
      if (entry.username || entry.identityFile) setShowCredentials(true);
      setConfigListOpen(false);
      const keyNote = entry.identityFile && !entry.identityKeyReadable
        ? " — the identity file is not readable by this installation, pick another key file or generate one"
        : "";
      setImportNote(`Imported ${entry.alias} from ssh_config${entry.hostName ? ` (connects to ${entry.hostName})` : ""}${keyNote} — every field stays editable.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : `Could not import ${selected.alias} from ssh_config`);
    } finally {
      setBusyId(undefined);
    }
  }

  /** Generate a product-held key pair; only the public key is shown. */
  async function generateKey(): Promise<void> {
    setBusyId("generate");
    try {
      const generated = await client.generateRemoteHostKey();
      setGeneratedKey(generated);
      setKeyPath(generated.privateKeyPath);
      setShowCredentials(true);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not generate a key pair");
    } finally {
      setBusyId(undefined);
    }
  }

  async function generateCredKey(): Promise<void> {
    setBusyId("generate-credentials");
    try {
      const generated = await client.generateRemoteHostKey();
      setCredGeneratedKey(generated);
      setCredKeyPath(generated.privateKeyPath);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not generate a key pair");
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
        runnerName: directLabel.trim(),
        description: description.trim(),
        connectionKind: "direct",
        endpoint: { host: directAddress.trim(), port: Number(directPort), protocol: "http" },
        token: directToken,
      });
      setDirectLabel("");
      setDescription("");
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

  async function toggleRunnerConnection(host: RemoteHostTarget, connected: boolean, trust?: RemoteHostKeyInfo): Promise<void> {
    setBusyId(`runner:${host.id}`);
    try {
      if (!connected && trust) await client.trustRemoteHostKey(host.id, trust);
      const status = connected
        ? await client.disconnectRemoteRunner(host.id)
        : await client.connectRemoteRunner(host.id);
      await refresh();
      if (!connected && status.hostKeyChallenge) {
        const challenge = status.hostKeyChallenge;
        setHostKeyPrompt({
          changed: challenge.changed,
          hostKey: challenge,
          origin: host.id,
          target: host.alias,
          resume: async () => {
            setHostKeyPrompt(undefined);
            await toggleRunnerConnection(host, connected, challenge);
          },
        });
      }
    } catch (error) {
      handleFailure(error, host.alias, host.id, (hostKey) => toggleRunnerConnection(host, connected, hostKey), "Runner connection failed");
      await refresh();
    } finally {
      setBusyId(undefined);
    }
  }

  async function probe(host: RemoteHostTarget, trust?: RemoteHostKeyInfo): Promise<void> {
    setBusyId(host.id);
    try {
      if (trust) await client.trustRemoteHostKey(host.id, trust);
      const updated = await client.probeRemoteHost(host.id);
      await refresh();
      if (updated.error) reportHostError(updated);
    } catch (error) {
      handleFailure(error, host.alias, host.id, (hostKey) => probe(host, hostKey), "Probe failed");
    } finally {
      setBusyId(undefined);
    }
  }

  async function saveCredentials(event: FormEvent, host: RemoteHostTarget): Promise<void> {
    event.preventDefault();
    setBusyId(`credentials:${host.id}`);
    try {
      const updated = await client.updateRemoteHostCredentials(host.id, {
        ...(credUsername.trim() ? { username: credUsername.trim() } : {}),
        // Empty fields keep the stored value; there is no way to read them back.
        ...(credPassword ? { password: credPassword } : {}),
        ...(credKeyPath.trim() ? { privateKeyPath: credKeyPath.trim() } : {}),
        ...(credPassphrase ? { passphrase: credPassphrase } : {}),
      });
      setEditingCredentials(undefined);
      clearCredentialDraft();
      onCredentialEditStateChange?.(false);
      setHosts((current) => current.map((candidate) => candidate.id === updated.id
        ? { ...updated, ...(candidate.runnerStatus ? { runnerStatus: candidate.runnerStatus } : {}) }
        : candidate));
      await refresh().catch((error: Error) => onError(`Credentials were saved, but the machine list could not refresh: ${error.message}`));
      if (updated.error) reportHostError(updated);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not update credentials");
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

  /** The public half of a generated pair, with copy help; the private key is never shown. */
  function renderGeneratedKey(generated: GeneratedRemoteHostKey, target: string, loginUser: string): ReactNode {
    return <div className="remote-host-pubkey">
      <strong>Public key generated</strong>
      <p>Append this line to <code>~/.ssh/authorized_keys</code> for {loginUser || "the login user"} on {target || "the machine"}. The private key stays on this ScienceDiscovery installation and is never shown in the browser.</p>
      <div className="remote-host-pubkey-row"><code>{generated.publicKey}</code><CopyButton getText={() => generated.publicKey} label="Copy public key" /></div>
    </div>;
  }

  const credentialsEditor = (host: RemoteHostTarget) => <form className="remote-host-credentials-form" onSubmit={(event) => void saveCredentials(event, host)}>
    <small>Saved values stay hidden. Leave password and key fields empty to keep the stored values.</small>
    <div className="remote-host-form-fields">
      <label><span>Username</span><input autoComplete="off" value={credUsername} onChange={(event) => setCredUsername(event.target.value)} placeholder="researcher" /></label>
      <label><span>Password</span><input autoComplete="new-password" type="password" value={credPassword} onChange={(event) => setCredPassword(event.target.value)} placeholder="Leave empty to keep the stored one" /></label>
      <SshKeyFileField client={client} label="Private key file" value={credKeyPath} disabled={Boolean(busyId)}
        onChange={(path) => { setCredKeyPath(path); setCredGeneratedKey(undefined); }}
        placeholder={host.hasPrivateKey ? "Leave empty to keep the stored key" : "~/.ssh/id_ed25519"} />
      <label><span>Key passphrase</span><input autoComplete="new-password" type="password" value={credPassphrase} onChange={(event) => setCredPassphrase(event.target.value)} placeholder={host.hasPrivateKey ? "Leave empty to keep the stored passphrase" : "Only if the key is encrypted"} /></label>
    </div>
    <div className="remote-host-form-extras">
      <button className="secondary-button" disabled={Boolean(busyId)} onClick={() => void generateCredKey()} type="button">Generate a key pair</button>
      <small>Only the public key is ever shown.</small>
    </div>
    {credGeneratedKey ? renderGeneratedKey(credGeneratedKey, host.alias, credUsername.trim()) : null}
    <div className="remote-host-form-actions">
      <button className="secondary-button" onClick={() => toggleCredentialsEditor(host)} type="button">Cancel</button>
      <button className="primary-button" disabled={Boolean(busyId)} type="submit">Save credentials</button>
    </div>
  </form>;

  /** The trust card renders next to the action that raised it: in the add form, or inside the machine card. */
  function renderHostKeyPrompt(origin: HostKeyPrompt["origin"]): ReactNode {
    if (!hostKeyPrompt || hostKeyPrompt.origin !== origin) return null;
    return <div className="remote-host-key-prompt" role="alert">
      <strong>{hostKeyPrompt.changed ? "Host key changed" : "Unknown host key"}</strong>
      <p>{hostKeyPrompt.changed
        ? `The host key presented by ${hostKeyPrompt.target} differs from the one trusted earlier. Only continue if you expected the machine to be reinstalled or rekeyed.`
        : `The SSH server at ${hostKeyPrompt.target} presented a key that is not trusted yet. Compare the fingerprint with the machine's administrator before trusting it.`}</p>
      <code>{hostKeyPrompt.hostKey.algorithm} · {hostKeyPrompt.hostKey.fingerprint}</code>
      <div className="remote-host-key-actions">
        <button className="secondary-button" onClick={() => setHostKeyPrompt(undefined)} type="button">Cancel</button>
        <button className="primary-button" onClick={() => void hostKeyPrompt.resume()} type="button">Trust and continue</button>
      </div>
    </div>;
  }

  return <div className="remote-host-manager">
    <div className="settings-detail-header"><span className="eyebrow">Institution-controlled compute</span><h3>Runners</h3><p>Configure parallel sandboxed execution environments: SSH-managed Runners or self-deployed Runners on this or another machine. Each has a stable ID and description that main and child Agents can select. Which machines a Project or Session may actually use is configured in that Project's or Session's own settings, not here.</p></div>
    <article className="remote-host-card ready"><div className="remote-host-card-main"><strong>Local Runner</strong><small>Runner ID: local</small><small>Default local sandbox · current Agent workspace and installed local environments</small></div></article>
    {hosts.length ? <div className="remote-host-list">{hosts.map((host) => {
      const connected = host.runnerStatus?.state === "ready";
      const state = connected ? "ready" : host.runnerStatus?.state ?? host.status;
      const untrustedKey = host.hostKey?.trusted === false ? host.hostKey : undefined;
      const publicKey = host.publicKey;
      const source = runnerSource(host);
      const storedCredentials = [
        host.username ? `user ${host.username}` : undefined,
        host.hasPassword ? "password stored" : undefined,
        host.hasPrivateKey ? "key stored" : undefined,
      ].filter(Boolean).join(" · ");
      return <article className={`remote-host-card ${host.status}`} key={host.id}>
        <div className="remote-host-card-main">
          <div className="remote-host-card-title"><strong>{host.runnerName ?? host.alias}</strong><span className={`remote-host-status ${connected ? "ready" : state === "error" ? "error" : ""}`}>{connected ? "connected" : state}</span></div>
          <small>Runner ID: {host.id}</small>
          {host.connectionKind !== "direct" ? <small>SSH target: {host.alias}</small> : null}
          <small>{host.description || host.runnerName || host.alias}</small>
          <small>{hostKindLabel(host)} · {capacity(host)}</small>
          {host.connectionKind === "direct"
            ? <small>{host.capabilities?.platform ?? "OS unknown"}</small>
            : host.capabilities
              ? <small>{[host.capabilities.platform ?? "OS unknown", source].filter(Boolean).join(" · ")}</small>
              : null}
          {host.runnerStatus?.remoteVersion ? <small>Remote {host.runnerStatus.remoteVersion} · local {host.runnerStatus.localVersion ?? "unknown"}{host.runnerStatus.versionMismatch ? " · version differs" : ""}{host.runnerStatus.deployed ? " · deployed by ScienceDiscovery" : ""}</small> : null}
          <RunnerResourceSummary host={host} />
          {storedCredentials ? <small>{storedCredentials}</small> : null}
          {untrustedKey ? <small>{`Host key not trusted: ${untrustedKey.algorithm} · ${untrustedKey.fingerprint}`}</small> : null}
          {publicKey ? <div className="remote-host-pubkey-line"><code title={publicKey}>{publicKey}</code><CopyButton getText={() => publicKey} label="Copy public key" /></div> : null}
        </div>
        <div className="remote-host-actions">
          <button className="secondary-button" disabled={Boolean(busyId) || (!connected && !runnerUsable(host))} onClick={() => void toggleRunnerConnection(host, connected)} type="button">{connected ? "Disconnect" : "Connect runner"}</button>
          <button className="secondary-button" disabled={Boolean(busyId)} onClick={() => void probe(host)} type="button">Refresh probe</button>
          {host.connectionKind === "ssh" ? <button aria-expanded={editingCredentials === host.id} className="secondary-button" disabled={Boolean(busyId)} onClick={() => toggleCredentialsEditor(host)} type="button">Credentials</button> : null}
          {untrustedKey ? <button className="secondary-button" disabled={Boolean(busyId)} onClick={() => setHostKeyPrompt({ changed: false, hostKey: untrustedKey, origin: host.id, target: host.alias, resume: async () => { setHostKeyPrompt(undefined); await probe(host, untrustedKey); } })} type="button">Trust host key</button> : null}
          <button className="danger-button" disabled={Boolean(busyId)} onClick={() => void removeHost(host)} type="button">Delete</button>
        </div>
        {[...new Set([host.error, host.runnerStatus?.error].filter(Boolean))].map((error) =>
          <div className="remote-host-error" role="alert" key={error}>{error}</div>)}
        {renderHostKeyPrompt(host.id)}
        {editingCredentials === host.id ? credentialsEditor(host) : null}
      </article>;
    })}</div> : <p className="remote-host-empty">No remote machines registered yet.</p>}
    <div className="remote-host-add-row">
      <button aria-expanded={adding === "ssh"} className="secondary-button" onClick={() => setAdding(adding === "ssh" ? undefined : "ssh")} type="button">Add SSH machine</button>
      <button aria-expanded={adding === "direct"} className="secondary-button" onClick={() => setAdding(adding === "direct" ? undefined : "direct")} type="button">Add self-deployed runner</button>
    </div>
    {adding === "ssh" ? <form className="remote-host-form" onSubmit={(event) => { event.preventDefault(); void submitSshForm(); }}>
      <p className="remote-host-form-help">An alias from your SSH config or a plain IP/hostname — one field for both; leave the port empty to let the SSH configuration resolve it. Add a username and a password or key when the machine needs them; credentials are stored encrypted and never shown again. ScienceDiscovery probes the machine and, when no runner is installed, deploys and starts its own runner over the same SSH connection — no manual install. Versions are shown and differences are flagged.</p>
      <div className="remote-host-form-fields">
        <label><span>Runner name</span><input value={runnerName} onChange={(event) => setRunnerName(event.target.value)} placeholder="e.g. GPU analysis environment" /></label>
        <label><span>Description</span><input maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Purpose, hardware and installed software" /></label>
        <label><span>SSH alias or IP/hostname</span><input required value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="institution-hpc or 192.168.1.20" /></label>
        <label><span>Port (optional)</span><input inputMode="numeric" value={sshPort} onChange={(event) => setSshPort(event.target.value)} placeholder="From SSH config" /></label>
        <label><span>Runner executable</span><input required value={runnerCommand} onChange={(event) => setRunnerCommand(event.target.value)} placeholder="sciencediscovery-runner" /></label>
      </div>
      <div className="remote-host-form-extras">
        <button aria-expanded={configListOpen} className="secondary-button" disabled={Boolean(busyId)} onClick={() => void toggleConfigList()} type="button">Import from ssh_config</button>
        {importNote ? <small>{importNote}</small> : null}
      </div>
      {configListOpen ? <div className="remote-host-import-list">
        {configHosts === undefined ? <small>Loading ssh_config…</small>
          : configHosts.length === 0 ? <small>No Host entries found in your ssh_config.</small>
          : configHosts.map((entry) => <button className="remote-host-import-entry" disabled={Boolean(busyId)} key={entry.alias} onClick={() => void importSshConfigHost(entry)} type="button">
            <strong>{entry.alias}</strong>
            <small>{[entry.hostName, entry.port ? `port ${entry.port}` : "", entry.username].filter(Boolean).join(" · ")}</small>
          </button>)}
      </div> : null}
      <div className="remote-host-form-extras">
        <button aria-expanded={showCredentials} className="secondary-button" onClick={() => setShowCredentials(!showCredentials)} type="button">Credentials (optional)</button>
        {!showCredentials ? <small>Username, password, or a key file — only when the machine needs them.</small> : null}
      </div>
      {showCredentials ? <div className="remote-host-form-credentials">
        <div className="remote-host-form-fields">
          <label><span>Username</span><input autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="researcher" /></label>
          <label><span>Password (optional)</span><input autoComplete="new-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Stored encrypted, never shown again" /></label>
          <SshKeyFileField client={client} label="Private key file (optional)" value={keyPath} disabled={Boolean(busyId)}
            onChange={(path) => { setKeyPath(path); setGeneratedKey(undefined); }} placeholder="~/.ssh/id_ed25519" />
          <label><span>Key passphrase (optional)</span><input autoComplete="new-password" type="password" value={keyPassphrase} onChange={(event) => setKeyPassphrase(event.target.value)} placeholder="Only if the key is encrypted" /></label>
        </div>
        <div className="remote-host-form-extras">
          <button className="secondary-button" disabled={Boolean(busyId)} onClick={() => void generateKey()} type="button">Generate a key pair</button>
          <small>Only the public key is ever shown; the private key never leaves this installation.</small>
        </div>
        {generatedKey ? renderGeneratedKey(generatedKey, alias.trim(), username.trim()) : null}
      </div> : null}
      {renderHostKeyPrompt("add")}
      <div className="remote-host-form-actions">
        <button className="secondary-button" onClick={() => { clearSshForm(); setAdding(undefined); }} type="button">Cancel</button>
        <button className="primary-button" disabled={busyId === "new" || !alias.trim() || !runnerCommand.trim()} type="submit">Probe and add</button>
      </div>
    </form> : null}
    {adding === "direct" ? <form className="remote-host-form" onSubmit={(event) => void addDirectHost(event)}>
      <p className="remote-host-form-help">Start a runner yourself on this or another machine with a listening address and <code>SCIENCE_AGENT_RUNNER_TOKEN</code>, then connect to it by IP address and port. The token is stored encrypted and never shown again; without it the connection is refused. Use this only over a network you trust, or put the runner behind your own TLS endpoint.</p>
      <div className="remote-host-form-fields">
        <label><span>Description</span><input maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Purpose, hardware and installed software" /></label>
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
    <div className="config-note">All Shell/Python/R commands execute through sandboxed Runners with provenance and artifact version tracking. SSH/SLURM one-shot jobs are not supported.</div>
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
        <span>{host.runnerName ?? host.alias}<small>{host.id} · {host.alias} · {hostKindLabel(host)}</small></span>
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
  for (const host of effectiveHosts) workspaceHosts.push({ alias: host.runnerName ?? host.alias, id: host.id });
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
          <span>{host.runnerName ?? host.alias}<small>{host.id} · {host.alias} · {hostKindLabel(host)}</small></span>
        </label>)}</div>
        : <p className="settings-choice-empty">This Project allows no remote machines yet; widen it in the Project settings.</p>
    ) : null}
    {workspaceHosts.length > 0 ? <div className="remote-workspace-panel">
      <div className="editor-heading"><strong>Remote workspace</strong><small>Each machine keeps a workspace separate from this Session's local one, across connections. Only the model transfers files, by naming the paths it needs; nothing is mirrored on connect, cancel, or disconnect.</small></div>
      {workspaceHosts.map((host) => {
        const records = syncRecords.filter((record) => record.hostId === host.id);
        return <div className="remote-workspace-host" key={host.id}>
          <strong>{host.alias}</strong><small>Runner ID: {host.id}</small>
          <div className="remote-workspace-records">
            {records.length ? records.slice(0, 10).map((record) => <small key={record.id}>{record.agentId ? `Agent ${record.agentId}` : "Main Agent"} · {record.direction} · {record.status} · {record.fileCount} files · {record.bytes} bytes · {record.paths.join(", ")}{record.error ? ` · ${record.error}` : ""}</small>) : <small>No transfers yet.</small>}
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
  return <section aria-label="Remote job approval cards" className="remote-jobs-panel"><div className="track-list-heading"><strong>Remote jobs</strong><span>{jobs.length} historical records · read-only</span></div>{jobs.map((job) => {
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
        <p>Historical job — independent SSH/SLURM execution is no longer supported. Use a Runner.</p>

        {job.remoteJobId ? <p><strong>Scheduler job</strong>{job.remoteJobId} · {job.scriptReference}</p> : null}
        {job.outputRecords.length ? <ul className="remote-output-list">{job.outputRecords.map((output) => <li key={output.path}>{output.localPath ?? output.path} <em>{output.status}</em></li>)}</ul> : null}
        {job.error ? <p className="environment-error">{job.error}</p> : null}
      </div> : null}
    </article>;
  })}</section>;
}

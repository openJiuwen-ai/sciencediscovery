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

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import type {
  PermissionDecision,
  NpuInventory,
  NpuRunnerSelectionsResponse,
  Project,
  RemoteConnectLogEntry,
  SshConfigHostImport,
  RemoteHostTarget,
  RemoteJob,
  Session,
  UpdateSessionRequest,
} from "@sciencediscovery/schema";
import { effectiveRunnerIds, selectableNpuDevices } from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { hostKeyFromError, type GeneratedRemoteHostKey, type RemoteHostKeyInfo } from "./api/settings.js";
import { RunnerEnvironmentSettings } from "./RunnerEnvironmentSettings.js";
import { CopyButton } from "./CopyButton.js";
import { useLocale } from "./i18n/index.js";
import { SshKeyFileField } from "./SshKeyFileField.js";
import { ChevronRightIcon, CpuIcon, ThermometerIcon, ZapIcon } from "./icons.js";
import { PermissionDecisionActions } from "./PermissionDecisionActions.js";
import { activityCardId, type ActivityCardDisclosure } from "./session/run-activity.js";

/**
 * Remote machines a Session may use: its own `remoteRunnerHostIds` override
 * (`[]` forbids every remote machine), else the Project allowlist. Local execution is controlled by the unified selection when present.
 */
export function effectiveRemoteRunnerHostIds(project: Project | undefined, session: Session | undefined): string[] {
  return project ? effectiveRunnerIds(project, session).filter((id) => id !== "local") : [];
}

function resourceBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * What this machine must still fit before installs start failing: the Runner
 * itself (the SEA binary is ~120 MiB, plus the micromamba provisioner and its
 * package cache) and two base conda environments (the Python starter carries
 * numpy/pandas/scipy/matplotlib, roughly 2 GiB on disk each). Deliberately an
 * absolute estimate, not a percentage: on a multi-TiB disk a "10% left" rule
 * cries wolf with hundreds of GiB still free.
 */
const RUNNER_ESSENTIALS_BYTES = 1 * 1024 ** 3;
const BASE_CONDA_ENV_BYTES = 2 * 1024 ** 3;
export const REMOTE_DISK_REQUIRED_BYTES = RUNNER_ESSENTIALS_BYTES + 2 * BASE_CONDA_ENV_BYTES;

function ResourceMeter({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }): ReactNode {
  const { t } = useLocale();
  // Missing/invalid telemetry is not zero capacity. Keep the reading explicit.
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0 || value < 0 || value > total) return <small>{t("remote.meterUnknown", { label })}</small>;
  const percent = Math.round(value / total * 1000) / 10;
  return <div className={`remote-resource-meter ${tone}`}>
    <div className="remote-resource-meter-label"><span>{label}</span><strong>{resourceBytes(value)} / {resourceBytes(total)}</strong></div>
    <div className="remote-resource-meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={{ width: `${percent}%` }} />
    </div>
  </div>;
}

export function RunnerResourceSummary({ host }: { host: RemoteHostTarget }): ReactNode {
  const { t } = useLocale();
  const resources = host.runnerStatus?.resources;
  if (host.runnerStatus?.state !== "ready" || !resources) return <div className="remote-host-resources" aria-label={t("remote.resourcesAria")}>
    <small>{host.runnerStatus?.state !== "ready"
      ? t("remote.diskUnknownDisconnected")
      : host.runnerStatus.resourcesError ?? t("remote.diskNoMetrics")}</small>
  </div>;
  const disk = resources.workspaceDisk;
  const lowDisk = disk && disk.availableBytes < REMOTE_DISK_REQUIRED_BYTES;
  return <div className="remote-host-resources" aria-label={t("remote.resourcesAria")}>
    <div className="remote-resource-tile">
    {disk ? <ResourceMeter label={t("remote.diskUsed")} value={disk.totalBytes - disk.availableBytes} total={disk.totalBytes} tone={lowDisk ? "warning" : "success"} /> : <small>{t("remote.meterUnknown", { label: t("remote.diskUsed") })}</small>}
    {disk ? <small className="remote-host-resource-path">{disk.path}</small> : <small>{resources.workspaceDiskError}</small>}
    {lowDisk && disk
      ? <div role="alert">{t("remote.lowDisk", { available: resourceBytes(disk.availableBytes), required: resourceBytes(REMOTE_DISK_REQUIRED_BYTES) })}</div> : null}
    </div>
    <div className="remote-resource-tile">
      <ResourceMeter label={t("remote.memoryUsed")} value={resources.memoryTotalBytes - resources.memoryFreeBytes} total={resources.memoryTotalBytes} tone="info" />
    </div>
    <div className="remote-resource-stats">
      <div><small>{t("remote.cpuCores")}</small><strong>{resources.cpuCores}</strong></div>
      <div><small>{t("remote.load1m")}</small><strong>{resources.loadAverage1m.toFixed(2)}</strong></div>
      <div><small>{t("remote.uptime")}</small><strong>{Math.floor(resources.uptimeSeconds / 3600)} <small>{t("remote.hoursUnit")}</small></strong></div>
    </div>
  </div>;
}

/** `3445 / 65536 MiB` as `3.4 / 64.0 GiB`, which is how operators talk about HBM. */
function npuMemory(usedMb: number | undefined, totalMb: number | undefined): string | undefined {
  if (usedMb === undefined || totalMb === undefined || totalMb <= 0) return undefined;
  return `${(usedMb / 1024).toFixed(1)} / ${(totalMb / 1024).toFixed(1)} GiB`;
}

/**
 * The live story of a Runner connect attempt.
 *
 * Connecting can take minutes — the Runner bundle may be uploaded and the
 * provisioner seeded before the first health answer — and the connect request
 * only returns at the very end. The page polls this log while the request is
 * in flight, so the operator watches the steps instead of a dead button. The
 * panel stays after a failure (its last lines usually name the cause) and is
 * cleared by the next attempt or a successful connect.
 */
export function ConnectLogPanel({ entries, live }: {
  entries: readonly RemoteConnectLogEntry[];
  live: boolean;
}): ReactNode {
  const { t } = useLocale();
  const bodyRef = useRef<HTMLDivElement>(null);
  // Follow the tail like a terminal would, but never yank the scroll away from
  // someone who scrolled up to read an earlier line.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
    if (nearBottom) body.scrollTop = body.scrollHeight;
  }, [entries.length]);
  return <div className={`remote-connect-log${live ? " live" : ""}`} role="log" aria-label={t("remote.connectLogTitle")}>
    <div className="remote-connect-log-header">
      <strong>{t("remote.connectLogTitle")}</strong>
      {live ? <small>{t("remote.connectLogLive")}</small> : null}
    </div>
    <div className="remote-connect-log-body" ref={bodyRef}>
      {entries.length === 0
        ? <small className="remote-connect-log-waiting">{t("remote.connectLogWaiting")}</small>
        : entries.map((entry, index) => <div className="remote-connect-log-line" key={`${entry.at}:${index}`}>
          <time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString(undefined, { hour12: false })}</time>
          <span>{entry.line}</span>
        </div>)}
    </div>
  </div>;
}

/**
 * A Runner's NPU cards and which of them may be handed to its sandboxes.
 *
 * Runner-agnostic on purpose: the local machine can carry the NPUs just as a
 * registered one can, and an operator must be able to tick either without the
 * two behaving differently. Every card is listed, including the ones that
 * cannot be used — hiding them would leave someone wondering where NPU 0 went.
 * An unusable card is shown with the driver's own reason on the row, so the
 * refusal is understood while ticking rather than during an execution. Its
 * checkbox is disabled only while it is unticked: a card that was usable when
 * it was ticked and has since been claimed by someone else must still be
 * removable, and disabling the whole row would leave the operator stuck with
 * a selection every execution then refuses.
 */
export function NpuDeviceSelector({ client, inventory, onError, onSelected, runnerId, selected }: {
  client: ApiClient;
  inventory: NpuInventory | null | undefined;
  onError: (message: string) => void;
  onSelected: (devices: number[]) => void;
  runnerId: string;
  selected: readonly number[];
}): ReactNode {
  const { t } = useLocale();
  const [saving, setSaving] = useState(false);
  // Ticks are edited locally until the operator saves. Picking cards is a plan
  // ("these four for the next run"), and saving each box on its own turned a
  // four-card plan into four writes, each re-probing the machine and each able
  // to fail on its own — with the first three already stored.
  const [draft, setDraft] = useState<number[]>();
  if (!inventory) return null;
  const ticked = new Set(draft ?? selected);
  const usableCount = selectableNpuDevices(inventory).length;
  const dirty = draft !== undefined && (draft.length !== selected.length
    || draft.some((hostIndex, position) => hostIndex !== selected[position]));

  const toggle = (hostIndex: number, checked: boolean): void => {
    const next = new Set(ticked);
    if (checked) next.add(hostIndex); else next.delete(hostIndex);
    setDraft([...next].sort((left, right) => left - right));
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    try {
      onSelected((await client.setRunnerNpuDevices(runnerId, draft)).devices);
      setDraft(undefined);
    } catch (error) {
      // The draft survives a rejected save: the Runner refusing one card must
      // not throw away the rest of what the operator picked.
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return <section className="remote-npu" aria-label={t("remote.npuTitle")}>
    <div className="remote-npu-header">
      <strong>{t("remote.npuTitle")}</strong>
      <small>{t("remote.npuCount", { total: inventory.devices.length, usable: usableCount })}</small>
    </div>
    {inventory.error ? <small role="alert">{inventory.error}</small> : null}
    {inventory.devices.length === 0
      ? <small>{t("remote.npuNone")}</small>
      : <ul className="remote-npu-list">
        {inventory.devices.map((device) => {
          const memory = npuMemory(device.hbmUsedMb, device.hbmTotalMb);
          const memoryPercent = device.hbmUsedMb === undefined || !device.hbmTotalMb
            ? undefined
            : Math.min(100, Math.max(0, (device.hbmUsedMb / device.hbmTotalMb) * 100));
          const aiCore = device.aiCorePercent === undefined
            ? undefined
            : Math.min(100, Math.max(0, device.aiCorePercent));
          const temperature = device.temperatureCelsius;
          const temperatureTone = temperature === undefined ? "" : temperature >= 75 ? " hot" : temperature >= 60 ? " warm" : "";
          const isTicked = ticked.has(device.hostIndex);
          return <li key={device.hostIndex} className={device.sandboxUsable ? "" : "unusable"}>
            <label className="remote-npu-pick">
              <input
                type="checkbox"
                checked={isTicked}
                disabled={(!device.sandboxUsable && !isTicked) || saving}
                onChange={(event) => toggle(device.hostIndex, event.target.checked)}
              />
              <span className="remote-npu-name">{t("remote.npuCard", { chip: device.chipName, index: device.hostIndex })}</span>
              {device.health ? <span className={`remote-detail-badge ${device.health === "OK" ? "neutral" : "warning"}`}>{device.health}</span> : null}
            </label>
            {/* Every cell is rendered even when its reading is missing, so the
                columns stay aligned from card to card. */}
            {memory === undefined || memoryPercent === undefined
              ? <span className="remote-npu-meter" />
              : <span className="remote-npu-meter" title={t("remote.npuMemoryLabel")}>
                <span className="remote-npu-meter-caption">{t("remote.npuMemoryCaption")}</span>
                <span className="remote-npu-meter-track"><span style={{ width: `${memoryPercent}%` }} /></span>
                <small className="remote-npu-meter-value">{memory}</small>
              </span>}
            {aiCore === undefined
              ? <span className="remote-npu-meter core" />
              : <span className={`remote-npu-meter core${aiCore >= 85 ? " high" : ""}`} title={t("remote.npuAiCoreLabel")}>
                <CpuIcon size={12} />
                <span className="remote-npu-meter-track"><span style={{ width: `${aiCore}%` }} /></span>
                <small className="remote-npu-meter-value">{t("remote.npuAiCore", { percent: aiCore })}</small>
              </span>}
            {temperature === undefined
              ? <span className="remote-npu-chip temperature" />
              : <span className={`remote-npu-chip temperature${temperatureTone}`} title={t("remote.npuTemperatureLabel")}>
                <ThermometerIcon size={12} />
                {t("remote.npuTemperature", { celsius: temperature })}
              </span>}
            {device.powerWatts === undefined
              ? <span className="remote-npu-chip power" />
              : <span className="remote-npu-chip power" title={t("remote.npuPowerLabel")}>
                <ZapIcon size={12} />
                {t("remote.npuPower", { watts: Math.round(device.powerWatts) })}
              </span>}
            {device.sandboxUsable
              ? null
              // The driver's own wording stays as the machine reported it; only
              // what the product says around it is translated.
              : <small className="remote-npu-reason">
                {device.sandboxUnusableReason ?? t("remote.npuUnusable")}
                {isTicked ? ` ${t("remote.npuUnusableSelected")}` : null}
              </small>}
          </li>;
        })}
      </ul>}
    {usableCount === 0 && inventory.devices.length > 0
      ? <small role="alert">{t("remote.npuNoneUsable")}</small>
      : null}
    <div className="remote-npu-footer">
      <small>{t("remote.npuRenumbered")}</small>
      {dirty ? <div className="remote-npu-actions">
        <small className="remote-npu-unsaved">{t("remote.npuUnsaved")}</small>
        <button className="secondary-button" disabled={saving} onClick={() => setDraft(undefined)} type="button">
          {t("remote.npuDiscard")}
        </button>
        <button className="primary-button" disabled={saving} onClick={() => void save()} type="button">
          {saving ? t("remote.npuSaving") : t("remote.npuSave")}
        </button>
      </div> : null}
    </div>
  </section>;
}

/**
 * Whether a Session can execute on this host. SSH hosts must be Linux and must
 * either carry the runner already or be able to receive the deployed one.
 */
function runnerUsable(host: RemoteHostTarget): boolean {
  if (host.id === "local") return true;
  if (host.status !== "ready") return false;
  if (host.connectionKind === "direct") return Boolean(host.endpoint && host.hasToken);
  return host.capabilities?.platform === "Linux";
}

/** Fresh host catalog for the scoped settings sections, fetched on mount. */
function useRemoteHosts(client: ApiClient, onError: (message: string) => void): RemoteHostTarget[] | undefined {
  const [hosts, setHosts] = useState<RemoteHostTarget[]>();
  useEffect(() => {
    let cancelled = false;
    void client.listRunners()
      .then((list) => { if (!cancelled) setHosts(list); })
      .catch((error: Error) => { if (!cancelled) onError(error.message); });
    return () => { cancelled = true; };
    // onError is a stable App callback; the catalog reloads per client, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  return hosts;
}

type Translate = ReturnType<typeof useLocale>["t"];

function hostKindLabel(host: RemoteHostTarget, t: Translate): string {
  if (host.id === "local") return t("runnerCatalog.stackConnection");
  return host.connectionKind === "direct" ? t("remote.kindSelfDeployed") : "SSH";
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
  const { t } = useLocale();
  const [hosts, setHosts] = useState<RemoteHostTarget[]>([]);
  // One selection map covers every Runner, including the built-in endpoint.
  const [npu, setNpu] = useState<NpuRunnerSelectionsResponse>();
  const npuSelections = npu?.selections ?? {};
  const selectNpu = (runnerId: string, devices: number[]): void => {
    setNpu((current) => current && { ...current, selections: { ...current.selections, [runnerId]: devices } });
  };
  const [managingRunner, setManagingRunner] = useState<string>();
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
  // The in-flight (or last failed) connection story per host, polled while the
  // connect request is still waiting for its answer.
  const [connectLogs, setConnectLogs] = useState<Record<string, RemoteConnectLogEntry[]>>({});
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPrompt>();
  const [editingCredentials, setEditingCredentials] = useState<string>();
  const [credUsername, setCredUsername] = useState("");
  const [credPassword, setCredPassword] = useState("");
  const [credKeyPath, setCredKeyPath] = useState("");
  const [credPassphrase, setCredPassphrase] = useState("");
  const [credGeneratedKey, setCredGeneratedKey] = useState<GeneratedRemoteHostKey>();

  async function refresh(): Promise<void> {
    setHosts(await client.listRunners());
  }

  useEffect(() => { void refresh().catch((error: Error) => onError(error.message)); }, [client]);
  // Read once for all Runners rather than per machine record, and separately
  // from the catalog so a machine list still renders if this call fails.
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const loaded = await client.listRunnerNpuDevices();
      if (!cancelled) setNpu(loaded);
    };
    void load().catch((error: unknown) => { onError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
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
      handleFailure(error, alias.trim(), "add", (hostKey) => submitSshForm(hostKey, hostId), t("remote.errorRegisterSshHost"));
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
      onError(error instanceof Error ? error.message : t("remote.errorReadSshConfig"));
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
        ? t("remote.importNoteKeyUnreadable")
        : "";
      setImportNote(t("remote.importNote", {
        alias: entry.alias,
        target: entry.hostName ? t("remote.importNoteTarget", { host: entry.hostName }) : "",
        keyNote,
      }));
    } catch (error) {
      onError(error instanceof Error ? error.message : t("remote.errorImportSshConfig", { alias: selected.alias }));
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
      onError(error instanceof Error ? error.message : t("remote.errorGenerateKeyPair"));
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
      onError(error instanceof Error ? error.message : t("remote.errorGenerateKeyPair"));
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
      onError(error instanceof Error ? error.message : t("remote.errorRegisterRunner"));
    } finally {
      setBusyId(undefined);
    }
  }

  async function toggleRunnerConnection(host: RemoteHostTarget, connected: boolean, trust?: RemoteHostKeyInfo): Promise<void> {
    setBusyId(`runner:${host.id}`);
    // Connecting can take minutes; poll the attempt's story while the request
    // is in flight so the operator sees progress instead of a dead button.
    let stopLogPolling: (() => void) | undefined;
    if (!connected) {
      setConnectLogs((current) => ({ ...current, [host.id]: [] }));
      const poll = async (): Promise<void> => {
        const log = await client.remoteRunnerConnectLog(host.id).catch(() => undefined);
        // A cleared story (successful connect, disconnect) stays cleared even
        // when a poll was already in flight while it happened.
        if (log) setConnectLogs((current) => host.id in current ? { ...current, [host.id]: log.entries } : current);
      };
      const timer = setInterval(() => void poll(), 800);
      stopLogPolling = () => clearInterval(timer);
    } else {
      setConnectLogs((current) => {
        const next = { ...current };
        delete next[host.id];
        return next;
      });
    }
    try {
      if (!connected && trust) await client.trustRemoteHostKey(host.id, trust);
      const status = connected
        ? await client.disconnectRemoteRunner(host.id)
        : await client.connectRunner(host.id);
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
      // A successful connect's story has nothing left to say; a failed one
      // keeps its lines, they usually name the cause.
      if (!connected && status.state === "ready") {
        setConnectLogs((current) => {
          const next = { ...current };
          delete next[host.id];
          return next;
        });
      }
    } catch (error) {
      // The story's last lines are written as the attempt fails; fetch them
      // once more so the panel shows the cause, not just the middle.
      if (!connected) {
        const log = await client.remoteRunnerConnectLog(host.id).catch(() => undefined);
        if (log) setConnectLogs((current) => ({ ...current, [host.id]: log.entries }));
      }
      handleFailure(error, host.alias, host.id, (hostKey) => toggleRunnerConnection(host, connected, hostKey), t("remote.errorRunnerConnection"));
      await refresh();
    } finally {
      stopLogPolling?.();
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
      handleFailure(error, host.alias, host.id, (hostKey) => probe(host, hostKey), t("remote.errorProbe"));
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
      await refresh().catch((error: Error) => onError(t("remote.errorRefreshAfterCredentials", { message: error.message })));
      if (updated.error) reportHostError(updated);
    } catch (error) {
      onError(error instanceof Error ? error.message : t("remote.errorUpdateCredentials"));
    } finally {
      setBusyId(undefined);
    }
  }

  async function removeHost(host: RemoteHostTarget): Promise<void> {
    if (!window.confirm(t("remote.confirmDelete", { alias: host.alias }))) return;
    setBusyId(host.id);
    try {
      await client.deleteRemoteHost(host.id);
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : t("remote.errorDelete"));
    } finally {
      setBusyId(undefined);
    }
  }

  /** The public half of a generated pair, with copy help; the private key is never shown. */
  function renderGeneratedKey(generated: GeneratedRemoteHostKey, target: string, loginUser: string): ReactNode {
    return <div className="remote-host-pubkey">
      <strong>{t("remote.pubkeyGenerated")}</strong>
      <p>{t("remote.pubkeyHelpBefore")}<code>~/.ssh/authorized_keys</code>{t("remote.pubkeyHelpAfter", { user: loginUser || t("remote.pubkeyLoginUserFallback"), machine: target || t("remote.pubkeyMachineFallback") })}</p>
      <div className="remote-host-pubkey-row"><code>{generated.publicKey}</code><CopyButton getText={() => generated.publicKey} label={t("remote.copyPublicKey")} /></div>
    </div>;
  }

  const credentialsEditor = (host: RemoteHostTarget) => <form className="remote-host-credentials-form" onSubmit={(event) => void saveCredentials(event, host)}>
    <small>{t("remote.credentialsSavedHidden")}</small>
    <div className="remote-host-form-fields">
      <label><span>{t("remote.usernameLabel")}</span><input autoComplete="off" value={credUsername} onChange={(event) => setCredUsername(event.target.value)} placeholder="researcher" /></label>
      <label><span>{t("remote.passwordLabel")}</span><input autoComplete="new-password" type="password" value={credPassword} onChange={(event) => setCredPassword(event.target.value)} placeholder={t("remote.passwordKeepPlaceholder")} /></label>
      <SshKeyFileField client={client} label={t("remote.privateKeyFileLabel")} value={credKeyPath} disabled={Boolean(busyId)}
        onChange={(path) => { setCredKeyPath(path); setCredGeneratedKey(undefined); }}
        placeholder={host.hasPrivateKey ? t("remote.keyKeepPlaceholder") : "~/.ssh/id_ed25519"} />
      <label><span>{t("remote.keyPassphraseLabel")}</span><input autoComplete="new-password" type="password" value={credPassphrase} onChange={(event) => setCredPassphrase(event.target.value)} placeholder={host.hasPrivateKey ? t("remote.passphraseKeepPlaceholder") : t("remote.passphraseEncryptedPlaceholder")} /></label>
    </div>
    <div className="remote-host-form-extras">
      <button className="secondary-button" disabled={Boolean(busyId)} onClick={() => void generateCredKey()} type="button">{t("remote.generateKeyPair")}</button>
      <small>{t("remote.onlyPublicKeyShown")}</small>
    </div>
    {credGeneratedKey ? renderGeneratedKey(credGeneratedKey, host.alias, credUsername.trim()) : null}
    <div className="remote-host-form-actions">
      <button className="secondary-button" onClick={() => toggleCredentialsEditor(host)} type="button">{t("common.cancel")}</button>
      <button className="primary-button" disabled={Boolean(busyId)} type="submit">{t("remote.saveCredentials")}</button>
    </div>
  </form>;

  /** The trust card renders next to the action that raised it: in the add form, or inside the machine card. */
  function renderHostKeyPrompt(origin: HostKeyPrompt["origin"]): ReactNode {
    if (!hostKeyPrompt || hostKeyPrompt.origin !== origin) return null;
    return <div className="remote-host-key-prompt" role="alert">
      <strong>{hostKeyPrompt.changed ? t("remote.hostKeyChanged") : t("remote.hostKeyUnknown")}</strong>
      <p>{hostKeyPrompt.changed
        ? t("remote.hostKeyChangedHelp", { target: hostKeyPrompt.target })
        : t("remote.hostKeyUnknownHelp", { target: hostKeyPrompt.target })}</p>
      <code>{hostKeyPrompt.hostKey.algorithm} · {hostKeyPrompt.hostKey.fingerprint}</code>
      <div className="remote-host-key-actions">
        <button className="secondary-button" onClick={() => setHostKeyPrompt(undefined)} type="button">{t("common.cancel")}</button>
        <button className="primary-button" onClick={() => void hostKeyPrompt.resume()} type="button">{t("remote.trustAndContinue")}</button>
      </div>
    </div>;
  }

  return <div className="remote-host-manager">
    <div className="settings-detail-header"><span className="eyebrow">{t("remote.eyebrow")}</span><h3>{t("remote.runnersTitle")}</h3><p>{t("remote.runnersHelp")}</p></div>
    {hosts.length ? <div className="remote-host-list">{hosts.map((host) => {
      const connected = host.runnerStatus?.state === "ready";
      const state = connected ? "ready" : host.runnerStatus?.state ?? host.status;
      const untrustedKey = host.hostKey?.trusted === false ? host.hostKey : undefined;
      const publicKey = host.publicKey;
      const address = host.connectionKind === "direct" ? host.endpoint?.host : host.hostName ?? host.alias;
      const port = host.connectionKind === "direct" ? host.endpoint?.port : host.port ?? 22;
      const destination = address?.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
      const storedCredentials = [
        host.hasPassword ? t("remote.passwordStored") : undefined,
        host.hasPrivateKey ? t("remote.keyStored") : undefined,
      ].filter(Boolean).join(" · ");
      const connectLog = connectLogs[host.id];
      const connectInFlight = busyId === `runner:${host.id}` && !connected;
      return <article className={`remote-host-card ${host.status}`} key={host.id}>
        <header className="remote-host-card-header">
        <div className="remote-host-card-main">
          <div className="remote-host-card-title"><strong>{host.id === "local" ? t("remote.localRunner") : host.runnerName ?? host.alias}</strong><span className={`remote-host-status ${connected ? "ready" : state === "error" ? "error" : ""}`}>{connected ? t("remote.connected") : state}</span>
            {/* A disconnected Runner says nothing about the machine, so while
                nothing is connected the machine's own answer is shown beside
                the connection state. */}
            {connected || !host.reachability ? null
              : <span
                className={`remote-host-reachability ${host.reachability.state}`}
                title={host.reachability.error ?? t(`remote.reachability.${host.reachability.state}Help`)}
              >{t(`remote.reachability.${host.reachability.state}`)}</span>}
          </div>
          <div className="remote-host-identity">
            <span>{host.id === "local" ? t("remote.localRunnerHelp") : `${destination ?? t("remote.addressUnknown")}:${port ?? "?"}`}</span>
            {host.id !== "local" ? <span>{host.connectionKind === "ssh" ? t("remote.identityUser", { username: host.username ?? t("remote.identityUserSshConfig") }) : t("remote.tokenAuth")}</span> : null}
          </div>
        </div>
        <div className="remote-host-actions">
          <button className="secondary-button" disabled={Boolean(busyId) || (!connected && !runnerUsable(host))} onClick={() => void toggleRunnerConnection(host, false)} type="button">{connected ? t("runnerCatalog.checkConnection") : t("remote.connectRunner")}</button>
          <button className="secondary-button" disabled={Boolean(busyId)} onClick={() => void refresh().catch((error: Error) => onError(error.message))} type="button">{t("runnerCatalog.refreshResources")}</button>
          {host.connectionKind === "ssh" ? <button aria-expanded={editingCredentials === host.id} className="secondary-button" disabled={Boolean(busyId)} onClick={() => toggleCredentialsEditor(host)} type="button">{t("remote.credentials")}</button> : null}
          {untrustedKey ? <button className="secondary-button" disabled={Boolean(busyId)} onClick={() => setHostKeyPrompt({ changed: false, hostKey: untrustedKey, origin: host.id, target: host.alias, resume: async () => { setHostKeyPrompt(undefined); await probe(host, untrustedKey); } })} type="button">{t("remote.trustHostKey")}</button> : null}
          <button className="secondary-button" onClick={() => setManagingRunner(managingRunner === host.id ? undefined : host.id)} type="button">{t("runnerCatalog.manage")}</button>
          {host.id !== "local" ? <button className="danger-button" disabled={Boolean(busyId)} onClick={() => void removeHost(host)} type="button">{t("common.delete")}</button> : null}
        </div>
        </header>
        {[...new Set([host.error, host.runnerStatus?.error].filter(Boolean))].map((error) =>
          <div className="remote-host-error" role="alert" key={error}>{error}</div>)}
        {connectInFlight || connectLog?.length ? <ConnectLogPanel entries={connectLog ?? []} live={connectInFlight} /> : null}
        {host.description && ![host.alias, host.runnerName].includes(host.description) ? <p className="remote-host-description">{host.description}</p> : null}
        <details className="remote-host-disclosure" open>
        <summary><span>{t("remote.machineDetails")}</span>{connected && host.runnerStatus?.resources ? <small>{t("remote.updated")} <time dateTime={host.runnerStatus.resources.capturedAt}>{new Date(host.runnerStatus.resources.capturedAt).toLocaleString()}</time></small> : null}</summary>
        <div className="remote-host-card-details">
          <section className="remote-host-connection" aria-label={t("remote.connectionAria")}>
            <div className="remote-detail-badges">
              <span className="remote-detail-badge info">{host.id === "local" ? t("runnerCatalog.stackConnection") : host.connectionKind === "ssh" ? t("remote.sshTunnel") : t("remote.selfDeployedDirect")}</span>
              {host.capabilities?.platform ? <span className="remote-detail-badge neutral">{host.capabilities.platform}</span> : null}
              {host.runnerStatus?.versionMismatch ? <span className="remote-detail-badge warning">{t("remote.versionDiffers")}</span> : null}
            </div>
            {host.capabilities?.gpu ? <small>{t("remote.gpuLabel", { gpu: host.capabilities.gpu })}</small> : null}
            <small>{t("remote.runnerId", { id: host.id })}</small>
            {host.connectionKind === "ssh" && host.hostName && host.alias !== host.hostName ? <small>{t("remote.detailSshAlias", { alias: host.alias })}</small> : null}
            {host.runnerStatus?.remoteVersion ? <small>{t("remote.versionLine", { remoteVersion: host.runnerStatus.remoteVersion, localVersion: host.runnerStatus.localVersion ?? t("remote.unknown") })}</small> : null}
            {host.connectionKind === "ssh" ? <div className="remote-detail-badges"><span className="remote-detail-badge neutral">{t("remote.credentialsPrefix", { value: storedCredentials || t("remote.credentialsSshConfig") })}</span></div> : null}
            {untrustedKey ? <small>{t("remote.hostKeyNotTrusted", { algorithm: untrustedKey.algorithm, fingerprint: untrustedKey.fingerprint })}</small> : null}
            {publicKey ? <details className="remote-host-public-key"><summary>{t("remote.publicKey")}</summary><div className="remote-host-pubkey-line"><code>{publicKey}</code><CopyButton getText={() => publicKey} label={t("remote.copyPublicKey")} /></div></details> : null}
          </section>
          <RunnerResourceSummary host={host} />
          <NpuDeviceSelector
            client={client}
            inventory={host.runnerStatus?.resources?.npu ?? (host.id === "local" ? npu?.local : undefined)}
            onError={onError}
            onSelected={(devices) => selectNpu(host.id, devices)}
            runnerId={host.id}
            selected={npuSelections[host.id] ?? []}
          />
        </div>
        </details>
        {host.id !== "local" ? <details className="remote-host-disclosure"><summary>{t("runnerCatalog.connectionSettings")}</summary><div className="remote-host-actions">
          <button className="secondary-button" disabled={Boolean(busyId)} onClick={() => void probe(host)} type="button">{t("remote.refreshProbe")}</button>
          {connected ? <button className="secondary-button" disabled={Boolean(busyId)} onClick={() => void toggleRunnerConnection(host, true)} type="button">{t("remote.disconnect")}</button> : null}
        </div></details> : null}
        {managingRunner === host.id ? <RunnerEnvironmentSettings key={host.id} client={client} initialRunnerId={host.id} onError={onError} /> : null}
        {renderHostKeyPrompt(host.id)}
        {editingCredentials === host.id ? credentialsEditor(host) : null}
      </article>;
    })}</div> : <p className="remote-host-empty">{t("remote.empty")}</p>}
    <div className="remote-host-add-row">
      <button aria-expanded={Boolean(adding)} className="secondary-button" onClick={() => setAdding(adding ? undefined : "ssh")} type="button">{t("runnerCatalog.addRunner")}</button>
      {adding ? <label><span>{t("runnerCatalog.connectionMethod")}</span><select aria-label={t("runnerCatalog.connectionMethod")} value={adding} onChange={(event) => setAdding(event.target.value as "ssh" | "direct")}><option value="ssh">{t("remote.addSshMachine")}</option><option value="direct">{t("remote.addDirectRunner")}</option></select></label> : null}
    </div>
    {adding === "ssh" ? <form className="remote-host-form remote-host-ssh-form" aria-label={t("remote.addSshMachine")} onSubmit={(event) => { event.preventDefault(); void submitSshForm(); }}>
      <div className="remote-host-form-heading"><strong>{t("remote.addSshMachine")}</strong><p className="remote-host-form-help">{t("remote.addSshHelp")}</p></div>
      <fieldset className="remote-host-form-section"><legend>{t("remote.legendConnection")}</legend>
      <div className="remote-host-form-extras">
        <button aria-expanded={configListOpen} className="secondary-button" disabled={Boolean(busyId)} onClick={() => void toggleConfigList()} type="button">{t("remote.importFromSshConfig")}</button>
        <small>{t("remote.importHelp")}</small>
      </div>
      {importNote ? <p className="remote-host-form-help" role="status">{importNote}</p> : null}
      <div className="remote-host-form-fields">
        <label><span>{t("remote.aliasLabel")}</span><input required value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="institution-hpc or 192.168.1.20" /></label>
        <label><span>{t("remote.portOptionalLabel")}</span><input inputMode="numeric" value={sshPort} onChange={(event) => setSshPort(event.target.value)} placeholder={t("remote.portPlaceholder")} /></label>
      </div>
      {configListOpen ? <div className="remote-host-import-list">
        {configHosts === undefined ? <small>{t("remote.loadingSshConfig")}</small>
          : configHosts.length === 0 ? <small>{t("remote.noSshConfigHosts")}</small>
          : configHosts.map((entry) => <button className="remote-host-import-entry" disabled={Boolean(busyId)} key={entry.alias} onClick={() => void importSshConfigHost(entry)} type="button">
            <strong>{entry.alias}</strong>
            <small>{[entry.hostName, entry.port ? t("remote.portPrefix", { port: entry.port }) : "", entry.username].filter(Boolean).join(" · ")}</small>
          </button>)}
      </div> : null}
      </fieldset>
      <fieldset className="remote-host-form-section"><legend>{t("remote.legendLogin")}</legend>
      <div className="remote-host-form-fields">
        <label><span>{t("remote.usernameLabel")}</span><input aria-describedby="ssh-add-username-help" autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("remote.usernameAddPlaceholder")} /></label>
        <label><span>{t("remote.passwordOptionalLabel")}</span><input autoComplete="new-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("remote.passwordAddPlaceholder")} /></label>
      </div>
      <p className="remote-host-form-help" id="ssh-add-username-help">{t("remote.usernameHelp")}</p>
      <p className="remote-host-form-help">{t("remote.secretHelp")}</p>
      <div className="remote-host-form-extras">
        <button aria-expanded={showCredentials} className="secondary-button" onClick={() => setShowCredentials(!showCredentials)} type="button">{t("remote.sshKeyOptional")}</button>
        {!showCredentials ? <small>{t("remote.chooseKeyHelp")}</small> : null}
      </div>
      {showCredentials ? <div className="remote-host-form-credentials">
        <div className="remote-host-form-fields">
          <SshKeyFileField client={client} label={t("remote.privateKeyFileOptionalLabel")} value={keyPath} disabled={Boolean(busyId)}
            onChange={(path) => { setKeyPath(path); setGeneratedKey(undefined); }} placeholder="~/.ssh/id_ed25519" />
          <label><span>{t("remote.keyPassphraseOptionalLabel")}</span><input autoComplete="new-password" type="password" value={keyPassphrase} onChange={(event) => setKeyPassphrase(event.target.value)} placeholder={t("remote.passphraseEncryptedPlaceholder")} /></label>
        </div>
        <div className="remote-host-form-extras">
          <button className="secondary-button" disabled={Boolean(busyId)} onClick={() => void generateKey()} type="button">{t("remote.generateKeyPair")}</button>
          <small>{t("remote.onlyPublicKeyNeverLeaves")}</small>
        </div>
        {generatedKey ? renderGeneratedKey(generatedKey, alias.trim(), username.trim()) : null}
      </div> : null}
      </fieldset>
      <fieldset className="remote-host-form-section"><legend>{t("remote.legendRunner")}</legend>
        <div className="remote-host-form-fields">
          <label><span>{t("remote.runnerNameLabel")}</span><input value={runnerName} onChange={(event) => setRunnerName(event.target.value)} placeholder={t("remote.runnerNamePlaceholder")} /></label>
          <label><span>{t("remote.descriptionLabel")}</span><input maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("remote.descriptionPlaceholder")} /></label>
        </div>
        <p className="remote-host-form-help">{t("remote.runnerDetailsHelp")}</p>
        <details className="remote-host-form-advanced"><summary>{t("remote.advancedSettings")}</summary>
          <label><span>{t("remote.runnerExecutableLabel")}</span><input required value={runnerCommand} onChange={(event) => setRunnerCommand(event.target.value)} placeholder="sciencediscovery-runner" /></label>
        </details>
      </fieldset>
      {renderHostKeyPrompt("add")}
      <div className="remote-host-form-actions">
        <button className="secondary-button" onClick={() => { clearSshForm(); setAdding(undefined); }} type="button">{t("common.cancel")}</button>
        <button className="primary-button" disabled={busyId === "new" || !alias.trim() || !runnerCommand.trim()} type="submit">{t("remote.probeAndAdd")}</button>
      </div>
    </form> : null}
    {adding === "direct" ? <form className="remote-host-form" onSubmit={(event) => void addDirectHost(event)}>
      <p className="remote-host-form-help">{t("remote.directHelpBefore")}<code>SCIENCE_AGENT_RUNNER_TOKEN</code>{t("remote.directHelpAfter")}</p>
      <div className="remote-host-form-fields">
        <label><span>{t("remote.descriptionLabel")}</span><input maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("remote.descriptionDirectPlaceholder")} /></label>
        <label><span>{t("remote.nameLabel")}</span><input required pattern="[A-Za-z0-9._-]+" value={directLabel} onChange={(event) => setDirectLabel(event.target.value)} placeholder="lab-workstation" /></label>
        <label><span>{t("remote.addressLabel")}</span><input required value={directAddress} onChange={(event) => setDirectAddress(event.target.value)} placeholder="192.168.1.20" /></label>
        <label><span>{t("remote.portLabel")}</span><input required inputMode="numeric" value={directPort} onChange={(event) => setDirectPort(event.target.value)} placeholder="4311" /></label>
        <label><span>{t("remote.tokenLabel")}</span><input required type="password" value={directToken} onChange={(event) => setDirectToken(event.target.value)} placeholder="SCIENCE_AGENT_RUNNER_TOKEN" /></label>
      </div>
      <div className="remote-host-form-actions">
        <button className="secondary-button" onClick={() => setAdding(undefined)} type="button">{t("common.cancel")}</button>
        <button className="primary-button" disabled={busyId === "new-direct" || !directLabel.trim() || !directAddress.trim() || !directToken.trim()} type="submit">{t("remote.connectAndAdd")}</button>
      </div>
    </form> : null}
    <div className="config-note">{t("remote.configNote")}</div>
  </div>;
}

/** Project-scoped allowlist, rendered inside the Project settings dialog. */
export function ProjectRemoteSettings({ client, onError, onProjectChange, project }: {
  client: ApiClient;
  onError: (message: string) => void;
  onProjectChange: (project: Project) => void;
  project: Project;
}) {
  const { t } = useLocale();
  const hosts = useRemoteHosts(client, onError);
  const [busyId, setBusyId] = useState<string>();
  const usable = (hosts ?? []).filter(runnerUsable);

  async function toggle(host: RemoteHostTarget): Promise<void> {
    setBusyId(host.id);
    try {
      const ids = effectiveRunnerIds(project).includes(host.id)
        ? effectiveRunnerIds(project).filter((id) => id !== host.id)
        : [...effectiveRunnerIds(project), host.id];
      onProjectChange(await client.updateProject(project.id, { runnerIds: ids }));
    } catch (error) {
      onError(error instanceof Error ? error.message : t("remote.errorUpdateProjectAllowlist"));
    } finally {
      setBusyId(undefined);
    }
  }

  return <section className="scoped-remote-settings">
    <div className="editor-heading"><strong>{t("remote.scopedTitle")}</strong><small>{t("remote.projectHelp")}</small></div>
    {!hosts ? <p className="muted">{t("remote.loading")}</p>
      : usable.length ? <div className="settings-choices">{usable.map((host) => <label key={host.id}>
        <input checked={effectiveRunnerIds(project).includes(host.id)} disabled={Boolean(busyId)} onChange={() => void toggle(host)} type="checkbox" />
        <span>{host.id === "local" ? t("remote.localRunner") : host.runnerName ?? host.alias}<small>{host.id} · {host.alias} · {hostKindLabel(host, t)}</small></span>
      </label>)}</div>
      : <p className="settings-choice-empty">{t("remote.noUsable", { title: t("remote.scopedTitle") })}</p>}
  </section>;
}

/**
 * Session-scoped override of Project defaults. Workspace and scientific
 * environment administration lives in system settings. Allowing a
 * remote machine only makes it available; local file access and local
 * file access stays in the Session workspace.
 */
export function SessionRemoteSettings({ client, disabled = false, onError, onSessionChange, project, session }: {
  client: ApiClient;
  disabled?: boolean;
  onError: (message: string) => void;
  onSessionChange: (session: Session) => void;
  project: Project;
  session: Session;
}) {
  const { t } = useLocale();
  const hosts = useRemoteHosts(client, onError);
  const [busyId, setBusyId] = useState<string>();

  const override = session.runnerIds ?? (session.remoteRunnerHostIds === undefined ? undefined : ["local", ...session.remoteRunnerHostIds]);
  const mode = override == null ? "inherit" : "override";
  const availableHosts = (hosts ?? []).filter(runnerUsable);
  const effectiveIds = effectiveRunnerIds(project, session);

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
    if (next === "inherit") await update({ runnerIds: null }, t("remote.errorRestoreProjectAllowlist"));
    // Start the override from what the Session may use today, so switching
    // modes never silently widens or drops machines.
    else await update({ runnerIds: effectiveIds }, t("remote.errorOverrideAllowlist"));
  }

  async function toggle(host: RemoteHostTarget): Promise<void> {
    const selected = override ?? effectiveRunnerIds(project);
    const ids = selected.includes(host.id)
      ? selected.filter((id) => id !== host.id)
      : [...selected, host.id];
    await update({ runnerIds: ids }, t("remote.errorUpdateSessionAllowlist"));
  }

  return <section className="scoped-remote-settings">
    <div className="editor-heading"><strong>{t("remote.scopedTitle")}</strong><small>{t("remote.sessionHelp")}</small></div>
    <label className="settings-field">
      <span>{t("remote.allowedRunners")}</span>
      <select disabled={disabled || Boolean(busyId)} value={mode} onChange={(event) => void setMode(event.target.value as "inherit" | "override")}>
        <option value="inherit">{t("remote.inheritOption", { count: effectiveRunnerIds(project).length })}</option>
        <option value="override">{t("remote.overrideOption", { count: mode === "override" ? (override?.length ?? 0) : effectiveIds.length })}</option>
      </select>
    </label>
    {mode === "override" ? (
      !hosts ? <p className="muted">{t("remote.loading")}</p>
        : availableHosts.length ? <div className="settings-choices">{availableHosts.map((host) => <label key={host.id}>
          <input checked={(override ?? []).includes(host.id)} disabled={disabled || Boolean(busyId)} onChange={() => void toggle(host)} type="checkbox" />
          <span>{host.id === "local" ? t("remote.localRunner") : host.runnerName ?? host.alias}<small>{host.id} · {host.alias} · {hostKindLabel(host, t)}</small></span>
        </label>)}</div>
        : <p className="settings-choice-empty">{t("remote.noUsable", { title: t("remote.scopedTitle") })}</p>
    ) : null}
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
  const { t } = useLocale();
  if (!jobs.length) return null;
  return <section aria-label={t("remote.jobsAria")} className="remote-jobs-panel"><div className="track-list-heading"><strong>{t("remote.jobsTitle")}</strong><span>{t("remote.jobsSummary", { count: jobs.length })}</span></div>{jobs.map((job) => {
    const cardId = activityCardId("remote-job", job.id);
    // A job waiting for approval is the only place to grant it, so it starts
    // expanded; an explicit toggle always wins, letting the user fold it away.
    const expanded = expandedCards[cardId] ?? job.state === "awaiting_approval";
    return <article className={`remote-job-card ${job.state}${["completed", "failed", "denied"].includes(job.state) ? " process-record" : ""}`} key={job.id}>
      <button aria-expanded={expanded} className="remote-job-heading" onClick={() => onToggleCard(cardId, !expanded)} type="button">
        <span className="card-chevron"><ChevronRightIcon size={15} /></span>
        <span><strong>{job.card.mode.toLocaleUpperCase()} · {job.card.targetAlias} · {job.state.replaceAll("_", " ")}</strong><small>{t("remote.jobResources", { cpus: job.card.resources.cpus, memoryMb: job.card.resources.memoryMb, gpus: job.card.resources.gpus, walltime: job.card.resources.walltimeMinutes })}</small></span>
        <i>{job.state.replaceAll("_", " ")}</i>
      </button>
      {expanded ? <div className="remote-job-body">
        <pre>{job.card.command}</pre>
        <p><strong>{t("remote.workingDirectory")}</strong>{job.card.remoteWorkingDirectory}</p>
        {job.card.inputPaths.length ? <p><strong>{t("remote.inPlaceInputs")}</strong>{job.card.inputPaths.join(" · ")}</p> : null}
        {job.card.outputs.length ? <ul>{job.card.outputs.map((output) => <li key={`${output.path}:${output.disposition}`}>{output.path} <em>{output.disposition === "pull" ? t("remote.outputPull") : t("remote.outputLeaveRemote")}</em></li>)}</ul> : null}
        <p>{t("remote.historicalJob")}</p>

        {job.remoteJobId ? <p><strong>{t("remote.schedulerJob")}</strong>{job.remoteJobId} · {job.scriptReference}</p> : null}
        {job.outputRecords.length ? <ul className="remote-output-list">{job.outputRecords.map((output) => <li key={output.path}>{output.localPath ?? output.path} <em>{output.status}</em></li>)}</ul> : null}
        {job.error ? <p className="environment-error">{job.error}</p> : null}
      </div> : null}
    </article>;
  })}</section>;
}

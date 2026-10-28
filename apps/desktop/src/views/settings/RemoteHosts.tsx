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

import { useEffect, useRef, useState } from "react";

import type { ApiClient } from "../../api/client.js";
import {
  deleteRemoteHost,
  generateRemoteHostKey,
  registerRemoteHost,
  runnerConnectLog,
  trustRemoteHostKey,
  updateRemoteHostCredentials,
  type RemoteHostKeyInfo,
} from "../../api/remote.js";
import { probeRunner, listRunnerNpuDevices, setRunnerConnected } from "../../api/settings.js";
import { setProjectRunnerIds } from "../../api/sessions.js";
import type {
  GeneratedRemoteHostKey,
  NpuRunnerSelectionsResponse,
  Project,
  RegisterRemoteHostRequest,
  RemoteConnectLogEntry,
  RemoteHostTarget,
  RunnerTarget,
  SshConfigHostImport,
} from "../../api/types.js";
import {
  allowlistHosts,
  hostDestination,
  hostKeyChanged,
  hostKeyFromError,
  hostKeyLine,
  hostKindLabel,
  projectRunnerIds,
  reachabilityHelp,
  reachabilityLabel,
  reachabilityTone,
  runnerUsable,
  storedCredentialLabels,
  toggleRunnerId,
  type HostKeyPrompt as HostKeyIssue,
} from "../../app/remote-format.js";
import { runnerStateLabel, runnerStateTone } from "../../app/settings-format.js";
import type { ConfirmRequest } from "../../app/use-workspace.js";
import { TEXT } from "../../text.js";
import { NpuDevicePanel, RunnerResourcePanel, SshConfigImport, SshKeyFileField } from "./RunnerResources.js";
import { Group, Tag } from "./rows.js";

/** How often the connect log is read while a connect is in flight. The request
 *  itself can take minutes; this is how the waiting is made visible. */
const LOG_POLL_MS = 800;

interface HostKeyPrompt extends HostKeyIssue {
  /** Runs the failed action again with the key accepted. */
  resume: () => Promise<void>;
}

/** Reports a failure and answers where to show it: `undefined` means it became
 *  a host-key question instead, and the caller has nothing left to display. */
type Reporter = (
  reason: unknown,
  target: string,
  resume: (hostKey: RemoteHostKeyInfo) => Promise<void>,
) => string | undefined;

type AddKind = "direct" | "ssh";

interface Props {
  client: ApiClient;
  hosts: RunnerTarget[];
  onConfirm: (request: ConfirmRequest) => void;
  /** Re-read the page after anything here changes it. */
  onReload: () => void;
}

/**
 * The machines this installation executes on.
 *
 * Every flow here is multi-step — register then probe, connect then poll, fail
 * then accept a key then try again — so the section owns its own busy and error
 * state instead of going through the page's one-shot `write`. What it does not
 * own is the catalog: the page reads it and hands it down, so a change made
 * here reaches the allowlist below in the same reload.
 *
 * Credentials never come back from the API. A field left empty therefore means
 * "keep what is stored", and the only evidence that something is stored is the
 * `已存密码` / `已存私钥` tag on the card.
 */
export function RunnerSection({ client, hosts, onConfirm, onReload }: Props) {
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [adding, setAdding] = useState<AddKind>();
  const [keyPrompt, setKeyPrompt] = useState<HostKeyPrompt>();
  const [connectLogs, setConnectLogs] = useState<Record<string, RemoteConnectLogEntry[]>>({});
  const [editingCredentials, setEditingCredentials] = useState<string>();
  /** A connect is reported per host rather than as one global busy key: the
   *  card it belongs to has to stay identifiable while it runs. */
  const [connecting, setConnecting] = useState<string>();
  /** Which NPU cards each machine may hand to a sandbox, keyed by Runner id.
   *  One map covers every machine, the local one included — it carries cards
   *  just as a registered machine does, and has no connection status to read
   *  its inventory from. */
  const [npu, setNpu] = useState<NpuRunnerSelectionsResponse>();

  // Read once for every Runner rather than per machine record, and separately
  // from the catalog, so a machine list still renders if this read fails.
  useEffect(() => {
    let cancelled = false;
    void listRunnerNpuDevices(client)
      .then((loaded) => {
        if (!cancelled) setNpu(loaded);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const selectNpu = (runnerId: string, devices: number[]) =>
    setNpu((current) => current && { ...current, selections: { ...current.selections, [runnerId]: devices } });

  const report: Reporter = (reason, target, resume) => {
    const issue = hostKeyFromError(reason, target);
    if (issue) {
      setKeyPrompt({ ...issue, resume: async () => { setKeyPrompt(undefined); await resume(issue.hostKey); } });
      return undefined;
    }
    return reason instanceof Error ? reason.message : TEXT.settings.saveFailed;
  };

  /** A probe that failed softly still carries the key it met: the same question,
   *  asked without an exception having been thrown. */
  const reportReturnedHost = (
    host: RemoteHostTarget,
    retry: (hostKey: RemoteHostKeyInfo) => Promise<void>,
  ): string | undefined => {
    if (host.hostKey?.trusted === false) {
      const hostKey = host.hostKey;
      setKeyPrompt({
        changed: hostKeyChanged(hostKey),
        hostKey,
        hostId: host.id,
        resume: async () => { setKeyPrompt(undefined); await retry(hostKey); },
        target: host.alias,
      });
      return undefined;
    }
    return host.error;
  };

  const probe = async (host: RemoteHostTarget, trust?: RemoteHostKeyInfo) => {
    setBusy(host.id);
    setFailure(undefined);
    try {
      if (trust) await trustRemoteHostKey(client, host.id, trust);
      const updated = await probeRunner(client, host.id);
      onReload();
      const message = reportReturnedHost(updated, (hostKey) => probe(host, hostKey));
      if (message) setFailure(message);
    } catch (reason) {
      const message = report(reason, host.alias, (hostKey) => probe(host, hostKey));
      if (message) setFailure(message);
    } finally {
      setBusy(undefined);
    }
  };

  /**
   * Connect or disconnect one machine.
   *
   * The connect request does not come back until the Runner is up or has
   * failed, so the log is polled while it is in flight. It is cleared on a
   * successful connect — a story with nothing left to say — and kept on a
   * failure, where its last lines usually name the cause.
   */
  const toggleConnection = async (host: RemoteHostTarget, connected: boolean, trust?: RemoteHostKeyInfo) => {
    setFailure(undefined);
    setConnecting(host.id);
    let stopPolling: (() => void) | undefined;
    const clearLog = () => setConnectLogs((current) => {
      const next = { ...current };
      delete next[host.id];
      return next;
    });
    if (connected) {
      clearLog();
    } else {
      setConnectLogs((current) => ({ ...current, [host.id]: [] }));
      const read = async () => {
        const log = await runnerConnectLog(client, host.id).catch(() => undefined);
        // A story already cleared (by a success that landed while this poll was
        // in flight) stays cleared.
        if (log) setConnectLogs((current) => (host.id in current ? { ...current, [host.id]: log.entries } : current));
      };
      const timer = setInterval(() => void read(), LOG_POLL_MS);
      stopPolling = () => clearInterval(timer);
    }
    try {
      if (!connected && trust) await trustRemoteHostKey(client, host.id, trust);
      await setRunnerConnected(client, host.id, !connected);
      if (!connected) clearLog();
      onReload();
    } catch (reason) {
      if (!connected) {
        const log = await runnerConnectLog(client, host.id).catch(() => undefined);
        if (log) setConnectLogs((current) => ({ ...current, [host.id]: log.entries }));
      }
      const message = report(reason, host.alias, (hostKey) => toggleConnection(host, connected, hostKey));
      if (message) setFailure(message);
      onReload();
    } finally {
      stopPolling?.();
      setConnecting(undefined);
    }
  };

  const askToTrust = (host: RemoteHostTarget, retry: (hostKey: RemoteHostKeyInfo) => Promise<void>) => {
    const hostKey = host.hostKey;
    if (!hostKey) return;
    setKeyPrompt({
      changed: hostKeyChanged(hostKey),
      hostKey,
      hostId: host.id,
      resume: async () => { setKeyPrompt(undefined); await retry(hostKey); },
      target: host.alias,
    });
  };

  const remove = (host: RemoteHostTarget) => {
    onConfirm({
      accept: TEXT.settings.runtime.runner.delete,
      body: TEXT.settings.runtime.runner.deleteBody,
      eyebrow: host.alias,
      onAccept: async () => {
        setBusy(host.id);
        setFailure(undefined);
        try {
          await deleteRemoteHost(client, host.id);
        } catch (reason) {
          setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
        } finally {
          setBusy(undefined);
          onReload();
        }
      },
      title: TEXT.settings.runtime.runner.deleteConfirm(host.runnerName ?? host.alias),
    });
  };

  return (
    <>
      {/* The section's own heading is the group's, so this row carries only the
          one action: registering another machine. */}
      <div className="machine-actions">
        <button
          className="secondary-button"
          disabled={busy !== undefined}
          onClick={() => setAdding(adding === undefined ? "ssh" : undefined)}
          type="button"
        >
          {adding === undefined ? TEXT.settings.runtime.runner.add : TEXT.settings.runtime.runner.cancel}
        </button>
      </div>

      {adding === undefined ? null : (
        <AddHostForm
          client={client}
          kind={adding}
          onCancel={() => setAdding(undefined)}
          onDone={() => {
            setAdding(undefined);
            onReload();
          }}
          onKind={setAdding}
          onReport={report}
          onRevealedHost={reportReturnedHost}
        />
      )}

      {keyPrompt ? <HostKeyCard onCancel={() => setKeyPrompt(undefined)} prompt={keyPrompt} /> : null}

      {hosts.length === 0 ? (
        <p className="settings-empty">{TEXT.settings.runtime.runner.empty}</p>
      ) : (
        <div className="settings-list">
          {hosts.map((host) => {
            const state = host.runnerStatus?.state;
            const connected = state === "ready";
            const untrusted = host.hostKey?.trusted === false;
            const log = connectLogs[host.id];
            const live = connecting === host.id;
            return (
              <div className={`settings-card is-machine${untrusted ? " is-off" : ""}`} key={host.id}>
                <span className="settings-card-mark">
                  {(host.runnerName ?? host.id).slice(0, 1).toUpperCase()}
                </span>
                <div className="settings-card-main">
                  <strong>
                    {host.id === "local" ? TEXT.settings.runtime.runner.local : host.runnerName ?? host.alias}
                    <Tag tone={runnerStateTone(state)}>{runnerStateLabel(state)}</Tag>
                    {/* No badge compares the two Runner versions: this card says
                        what the machine is, not whether it matches this build.
                        The remote version is still printed in the line below, so
                        a differing build stays readable without being turned into
                        a warning. */}
                    {/* A disconnected Runner says nothing about the machine, so
                        the machine's own answer is shown beside it. */}
                    {connected || !host.reachability ? null : (
                      <span title={reachabilityHelp(host.reachability.state)}>
                        <Tag tone={reachabilityTone(host.reachability.state)}>
                          {reachabilityLabel(host.reachability.state)}
                        </Tag>
                      </span>
                    )}
                    {untrusted ? <Tag tone="warn">{TEXT.settings.runtime.runner.untrusted}</Tag> : null}
                    {host.id !== "local" && !untrusted && !runnerUsable(host) ? (
                      <Tag tone="off">{TEXT.settings.runtime.runner.unusable}</Tag>
                    ) : null}
                  </strong>
                  <small>
                    {[
                      host.id === "local" ? TEXT.settings.runtime.runner.localHelp : hostKindLabel(host),
                      host.id === "local"
                        ? ""
                        : hostDestination(host) ?? TEXT.settings.runtime.runner.destinationUnknown,
                      host.runnerStatus?.remoteVersion ?? "",
                      host.runnerStatus?.resources?.cpuCores === undefined
                        ? ""
                        : TEXT.settings.runtime.runner.cpuCores(host.runnerStatus.resources.cpuCores),
                      ...storedCredentialLabels(host),
                    ]
                      .filter((part) => part !== "")
                      .join(" · ")}
                  </small>
                  {[...new Set([host.error, host.runnerStatus?.error].filter(Boolean))].map((error) => (
                    <small className="row-note is-error" key={error}>
                      {error}
                    </small>
                  ))}
                </div>
                <div className="settings-card-actions">
                  {host.id === "local" ? null : (
                    <button
                      className="secondary-button"
                      disabled={live || (!connected && !runnerUsable(host))}
                      onClick={() => void toggleConnection(host, connected)}
                      type="button"
                    >
                      {live
                        ? TEXT.settings.runtime.runner.connecting
                        : connected
                          ? TEXT.settings.runtime.runner.disconnect
                          : TEXT.settings.runtime.runner.connect}
                    </button>
                  )}
                  {untrusted ? (
                    <button
                      className="secondary-button"
                      disabled={busy === host.id || live}
                      onClick={() => askToTrust(host, (hostKey) => probe(host, hostKey))}
                      type="button"
                    >
                      {TEXT.settings.runtime.runner.trust.confirm}
                    </button>
                  ) : null}
                  {host.connectionKind === "ssh" && host.id !== "local" ? (
                    <button
                      aria-expanded={editingCredentials === host.id}
                      className="secondary-button"
                      disabled={busy === host.id || live}
                      onClick={() => setEditingCredentials(editingCredentials === host.id ? undefined : host.id)}
                      type="button"
                    >
                      {TEXT.settings.runtime.runner.credentials.heading}
                    </button>
                  ) : null}
                  {host.id === "local" ? null : (
                    <button
                      className="danger-button"
                      disabled={busy === host.id || live}
                      onClick={() => remove(host)}
                      type="button"
                    >
                      {TEXT.settings.runtime.runner.delete}
                    </button>
                  )}
                </div>

                {live || log?.length ? <ConnectLog entries={log ?? []} live={live} /> : null}

                {/* What the machine is, once it has answered. Folded away by
                    default: the card's job is the connection, and this is what
                    someone opens when the connection is not the question. */}
                <details className="machine-details">
                  <summary>{TEXT.settings.runtime.runner.machineDetails}</summary>
                  <RunnerResourcePanel host={host} />
                  <NpuDevicePanel
                    client={client}
                    inventory={host.runnerStatus?.resources?.npu ?? (host.id === "local" ? npu?.local : undefined)}
                    onError={setFailure}
                    onSelected={(devices) => selectNpu(host.id, devices)}
                    runnerId={host.id}
                    selected={npu?.selections[host.id] ?? []}
                  />
                </details>

                {editingCredentials === host.id ? (
                  <CredentialsForm
                    client={client}
                    host={host}
                    onCancel={() => setEditingCredentials(undefined)}
                    onDone={(updated) => {
                      setEditingCredentials(undefined);
                      onReload();
                      if (!updated) return;
                      const message = reportReturnedHost(updated, (hostKey) => probe(host, hostKey));
                      if (message) setFailure(message);
                    }}
                    onFailure={setFailure}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {failure ? <small className="row-note is-error">{failure}</small> : null}
    </>
  );
}

/**
 * Ask the API for a key pair, and show the half that has to be installed.
 *
 * This is the way out of the one dead end the form would otherwise have: key
 * authentication needs a private key *this API host* can read, and somebody
 * whose keys live on their laptop has none to point at. The generated private
 * half never reaches the browser — it is staged in the data directory and
 * consumed when the machine's record stores it — so what is shown here is the
 * public line, which is the part the machine must be given.
 *
 * The prompt to re-test afterwards is not decoration: until the line is in the
 * machine's `authorized_keys`, the probe fails with a permission error, and
 * nothing about the key on screen would explain why.
 */
function KeyPairField({
  client,
  onPath,
  onFailure,
}: {
  client: ApiClient;
  onFailure: (message: string) => void;
  onPath: (path: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pair, setPair] = useState<GeneratedRemoteHostKey>();
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    setBusy(true);
    try {
      const generated = await generateRemoteHostKey(client);
      setPair(generated);
      setCopied(false);
      onPath(generated.privateKeyPath);
    } catch (reason) {
      onFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!pair) return;
    void navigator.clipboard.writeText(pair.publicKey).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <>
      <div className="settings-card-actions">
        <button className="secondary-button" disabled={busy} onClick={() => void generate()} type="button">
          {TEXT.settings.runtime.runner.keyPair.generate}
        </button>
      </div>
      {pair ? (
        <div className="connect-log">
          <div className="connect-log-body">
            <small className="row-note">{TEXT.settings.runtime.runner.keyPair.note}</small>
            <small className="field-help">{TEXT.settings.runtime.runner.keyPair.title}</small>
            <code className="path-chip">{pair.publicKey}</code>
          </div>
          <div className="settings-card-actions">
            <button className="secondary-button" onClick={copy} type="button">
              {copied ? TEXT.settings.runtime.runner.keyPair.copied : TEXT.settings.runtime.runner.keyPair.copy}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * The question an unknown host key asks, in the place the action was taken.
 *
 * The fingerprint is the whole point: without it, "trust this machine" is
 * asking for a blind yes. It is a card rather than a dialog because it belongs
 * to one action, and cancelling it has to leave the rest of the page usable.
 */
function HostKeyCard({ onCancel, prompt }: { onCancel: () => void; prompt: HostKeyPrompt }) {
  return (
    <div className="host-key-card" role="alert">
      <strong>
        {prompt.changed
          ? TEXT.settings.runtime.runner.trust.changed(prompt.target)
          : TEXT.settings.runtime.runner.trust.unknown(prompt.target)}
      </strong>
      <p>
        {prompt.changed
          ? TEXT.settings.runtime.runner.trust.changedBody
          : TEXT.settings.runtime.runner.trust.unknownBody}
      </p>
      <code className="path-chip">{hostKeyLine(prompt.hostKey)}</code>
      <div className="settings-card-actions">
        <button className="secondary-button" onClick={onCancel} type="button">
          {TEXT.settings.runtime.runner.trust.cancel}
        </button>
        <button className="primary-button" onClick={() => void prompt.resume()} type="button">
          {TEXT.settings.runtime.runner.trust.confirm}
        </button>
      </div>
    </div>
  );
}

/** The connect story as the API recorded it: lines are operator-facing
 *  diagnostics in English, like the errors they sit beside, so they are shown
 *  as they arrived and only the frame around them is translated. */
function ConnectLog({ entries, live }: { entries: RemoteConnectLogEntry[]; live: boolean }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [entries.length]);
  return (
    <div aria-label={TEXT.settings.runtime.runner.connectLog.heading} className="connect-log" role="log">
      <div className="connect-log-head">
        <strong>{TEXT.settings.runtime.runner.connectLog.heading}</strong>
        {live ? <small>{TEXT.settings.runtime.runner.connectLog.live}</small> : null}
      </div>
      <div className="connect-log-body" ref={bodyRef}>
        {entries.length === 0 ? (
          <small className="row-note">{TEXT.settings.runtime.runner.connectLog.empty}</small>
        ) : (
          entries.map((entry, index) => (
            <div className="connect-log-line" key={`${entry.at}:${index}`}>
              {entry.line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Register one machine.
 *
 * Two ways in, and they are two forms rather than one with a mode switch
 * because they share nothing but the name: an SSH machine is reached by the
 * product and needs login credentials, a self-deployed one is already running
 * and needs its address and the token it was started with. `connectionKind` is
 * what the server stores, and it decides everything downstream — credentials,
 * host keys, reachability.
 *
 * Nothing typed here goes to the machine directly: the credentials are sent
 * once to the API, which stores them encrypted and probes with them, so a wrong
 * password surfaces as a failed probe rather than as a login attempt from here.
 */
function AddHostForm({
  client,
  kind,
  onCancel,
  onDone,
  onKind,
  onReport,
  onRevealedHost,
}: {
  client: ApiClient;
  kind: AddKind;
  onCancel: () => void;
  onDone: () => void;
  onKind: (kind: AddKind) => void;
  onReport: Reporter;
  onRevealedHost: (host: RemoteHostTarget, retry: (hostKey: RemoteHostKeyInfo) => Promise<void>) => string | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [alias, setAlias] = useState("");
  const [port, setPort] = useState("");
  const [runnerCommand, setRunnerCommand] = useState("sciencediscovery-runner");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [address, setAddress] = useState("");
  const [directPort, setDirectPort] = useState("4311");
  const [token, setToken] = useState("");

  const ssh = kind === "ssh";
  const ready = ssh
    ? alias.trim() !== "" && runnerCommand.trim() !== ""
    : alias.trim() !== "" && address.trim() !== "" && token.trim() !== "";

  const buildRequest = (): RegisterRemoteHostRequest => (ssh
    ? {
      alias: alias.trim(),
      connectionKind: "ssh",
      // An omitted port lets the user's own SSH configuration answer, which is
      // also where an imported entry's port comes from.
      ...(port.trim() ? { port: Number(port) } : {}),
      runnerCommand: runnerCommand.trim(),
      ...(username.trim() ? { username: username.trim() } : {}),
      ...(password ? { password } : {}),
      ...(keyPath.trim() ? { privateKeyPath: keyPath.trim() } : {}),
      ...(passphrase ? { passphrase } : {}),
    }
    : {
      alias: alias.trim(),
      connectionKind: "direct",
      endpoint: { host: address.trim(), port: Number(directPort), protocol: "http" },
      token,
    });

  /** Copy an imported entry into the form.
   *
   *  The product's SSH client does not consult `ssh_config` after an import, so
   *  the resolved destination goes into the same fields a hand-typed one would;
   *  an entry naming a host is what `alias` holds, since that is what the
   *  connection is addressed by. */
  const applyImportedHost = (entry: SshConfigHostImport) => {
    setAlias(entry.hostName ?? entry.alias);
    setPort(entry.port === undefined ? "" : String(entry.port));
    setUsername(entry.username ?? "");
    setKeyPath(entry.identityFile ?? "");
  };

  /** One attempt. `trust` is set only on the retry that follows the card, and
   *  the id it addresses is the record the first attempt created. */
  const submit = async (trust?: RemoteHostKeyInfo, hostId?: string) => {
    setBusy(true);
    setFailure(undefined);
    try {
      const host = hostId && trust
        ? await trustRemoteHostKey(client, hostId, trust)
        : await registerRemoteHost(client, buildRequest());
      const message = onRevealedHost(host, (hostKey) => submit(hostKey, host.id));
      if (message) {
        setFailure(message);
        return;
      }
      onDone();
    } catch (reason) {
      const message = onReport(reason, alias.trim(), (hostKey) => submit(hostKey, hostKeyOwner(reason, hostId)));
      if (message) setFailure(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-card is-form">
      <div aria-label={TEXT.settings.runtime.runner.kindLabel} className="seg-pills" role="group">
        <button aria-pressed={ssh} className={ssh ? "active" : ""} onClick={() => onKind("ssh")} type="button">
          {TEXT.settings.runtime.runner.kind.ssh}
        </button>
        <button aria-pressed={!ssh} className={!ssh ? "active" : ""} onClick={() => onKind("direct")} type="button">
          {TEXT.settings.runtime.runner.kind.direct}
        </button>
      </div>

      <label className="machine-field">
        <span>{TEXT.settings.runtime.runner.alias}</span>
        <input
          className="field-input"
          onChange={(event) => setAlias(event.target.value)}
          placeholder={TEXT.settings.runtime.runner.aliasPlaceholder}
          spellCheck={false}
          value={alias}
        />
      </label>

      {ssh ? (
        <>
          <SshConfigImport
            client={client}
            onFailure={(message) => setFailure(message)}
            onImported={applyImportedHost}
          />
          <label className="machine-field">
            <span>{TEXT.settings.runtime.runner.port}</span>
            <input
              className="field-input"
              inputMode="numeric"
              onChange={(event) => setPort(event.target.value)}
              placeholder={TEXT.settings.runtime.runner.portPlaceholder}
              value={port}
            />
          </label>
          <label className="machine-field">
            <span>{TEXT.settings.runtime.runner.username}</span>
            <input
              autoComplete="off"
              className="field-input"
              onChange={(event) => setUsername(event.target.value)}
              placeholder={TEXT.settings.runtime.runner.usernamePlaceholder}
              value={username}
            />
          </label>
          <label className="machine-field">
            <span>{TEXT.settings.runtime.runner.secret}</span>
            <input
              autoComplete="new-password"
              className="field-input"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </label>
          <SshKeyFileField
            client={client}
            disabled={busy}
            label={TEXT.settings.runtime.runner.keyFile}
            onChange={setKeyPath}
            placeholder={TEXT.settings.runtime.runner.keyPlaceholder}
            value={keyPath}
          />
          <KeyPairField client={client} onFailure={setFailure} onPath={setKeyPath} />
          <label className="machine-field">
            <span>{TEXT.settings.runtime.runner.passphrase}</span>
            <input
              autoComplete="new-password"
              className="field-input"
              onChange={(event) => setPassphrase(event.target.value)}
              type="password"
              value={passphrase}
            />
          </label>
          <label className="machine-field">
            <span>{TEXT.settings.runtime.runner.runnerCommand}</span>
            <input
              className="field-input"
              onChange={(event) => setRunnerCommand(event.target.value)}
              spellCheck={false}
              value={runnerCommand}
            />
          </label>
        </>
      ) : (
        <>
          <label className="machine-field">
            <span>{TEXT.settings.runtime.runner.endpoint}</span>
            <input
              className="field-input"
              onChange={(event) => setAddress(event.target.value)}
              placeholder={TEXT.settings.runtime.runner.endpointPlaceholder}
              spellCheck={false}
              value={address}
            />
          </label>
          <label className="machine-field">
            <span>{TEXT.settings.runtime.runner.portLabel}</span>
            <input
              className="field-input"
              inputMode="numeric"
              onChange={(event) => setDirectPort(event.target.value)}
              value={directPort}
            />
          </label>
          <label className="machine-field">
            <span>{TEXT.settings.runtime.runner.token}</span>
            <input
              autoComplete="new-password"
              className="field-input"
              onChange={(event) => setToken(event.target.value)}
              placeholder={TEXT.settings.runtime.runner.tokenPlaceholder}
              type="password"
              value={token}
            />
          </label>
        </>
      )}

      {failure ? <small className="row-note is-error">{failure}</small> : null}

      <div className="settings-card-actions">
        <button className="secondary-button" onClick={onCancel} type="button">
          {TEXT.settings.runtime.runner.cancel}
        </button>
        <button
          className="primary-button"
          disabled={busy || !ready}
          onClick={() => void submit()}
          type="button"
        >
          {ssh ? TEXT.settings.runtime.runner.register : TEXT.settings.runtime.runner.registerDirect}
        </button>
      </div>
    </div>
  );
}

/** Which machine record a failed registration belongs to. The API names it when
 *  it can — the trust retry has to address the record, not the attempt. */
function hostKeyOwner(reason: unknown, fallback?: string): string | undefined {
  return hostKeyFromError(reason, "")?.hostId ?? fallback;
}

/**
 * Replace the login credentials of a machine already registered.
 *
 * Every field is empty on open, including the ones the API confirmed it has:
 * a stored password cannot be read back, so pre-filling is impossible, and an
 * empty box is the honest way to say "leave this alone". The card above is
 * where the fact that one is stored gets stated.
 */
function CredentialsForm({
  client,
  host,
  onCancel,
  onDone,
  onFailure,
}: {
  client: ApiClient;
  host: RemoteHostTarget;
  onCancel: () => void;
  onDone: (updated?: RemoteHostTarget) => void;
  onFailure: (message: string) => void;
}) {
  const [username, setUsername] = useState(host.username ?? "");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [saving, setSaving] = useState(false);
  const [forgetCredentials, setForgetCredentials] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      // Absent fields keep their stored value; there is no way to read them back
      // to verify, which is why the response is a fresh probe.
      const updated = await updateRemoteHostCredentials(client, host.id, {
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(forgetCredentials
          ? { password: null, privateKeyPath: null, passphrase: null }
          : {
            ...(password ? { password } : {}),
            ...(keyPath.trim() ? { privateKeyPath: keyPath.trim() } : {}),
            ...(passphrase ? { passphrase } : {}),
          }),
      });
      onDone(updated);
    } catch (reason) {
      onFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="connect-log">
      <div className="connect-log-body">
        <small className="row-note">{TEXT.settings.runtime.runner.credentials.note}</small>
        <label className="runner-choice">
          <input
            checked={forgetCredentials}
            disabled={saving}
            onChange={(event) => setForgetCredentials(event.target.checked)}
            type="checkbox"
          />
          <span>{TEXT.settings.runtime.runner.credentials.forget}</span>
        </label>
        <label className="machine-field">
          <span>{TEXT.settings.runtime.runner.username}</span>
          <input
            autoComplete="off"
            className="field-input"
            onChange={(event) => setUsername(event.target.value)}
            spellCheck={false}
            value={username}
          />
        </label>
        <label className="machine-field">
          <span>{TEXT.settings.runtime.runner.secret}</span>
          <input
            autoComplete="new-password"
            className="field-input"
            onChange={(event) => setPassword(event.target.value)}
            placeholder={TEXT.settings.runtime.runner.credentials.secretKeep}
            disabled={saving || forgetCredentials}
            type="password"
            value={password}
          />
        </label>
        <SshKeyFileField
          client={client}
          disabled={saving || forgetCredentials}
          label={TEXT.settings.runtime.runner.keyFile}
          onChange={setKeyPath}
          placeholder={host.hasPrivateKey
            ? TEXT.settings.runtime.runner.credentials.keyKeep
            : TEXT.settings.runtime.runner.keyPlaceholder}
          value={keyPath}
        />
        <label className="machine-field">
          <span>{TEXT.settings.runtime.runner.passphrase}</span>
          <input
            autoComplete="new-password"
            className="field-input"
            onChange={(event) => setPassphrase(event.target.value)}
            placeholder={host.hasPrivateKey
              ? TEXT.settings.runtime.runner.credentials.passphraseKeep
              : TEXT.settings.runtime.runner.credentials.passphrasePlaceholder}
            disabled={saving || forgetCredentials}
            type="password"
            value={passphrase}
          />
        </label>
      </div>
      <div className="settings-card-actions">
        <button className="secondary-button" onClick={onCancel} type="button">
          {TEXT.settings.runtime.runner.credentials.cancel}
        </button>
        <button className="primary-button" disabled={saving} onClick={() => void save()} type="button">
          {TEXT.settings.runtime.runner.credentials.save}
        </button>
      </div>
    </div>
  );
}

/**
 * Which machines a Project's Sessions may use.
 *
 * This is the whole permission, not a default: the API refuses a run whose
 * runner is not in this list, and an empty list forbids everything including
 * the local machine. Only usable remote machines are offered, because the only
 * thing a checkbox for an unusable one could produce is a run that fails at the
 * last step; that machine stays in the list above, where the reason is stated.
 * The local Runner has no checkbox for the same reason it has no card: it is
 * always there, and this page manages machines other than this one.
 *
 * The list on screen comes back from the server on every toggle rather than
 * being updated in place — the page re-reads, which is how the box the API
 * refused cannot linger as if it had been accepted.
 */
export function ProjectRunnerAllowlist({
  client,
  hosts,
  onReload,
  project,
}: {
  client: ApiClient;
  hosts: RunnerTarget[];
  onReload: () => void;
  project: Project;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const allowed = projectRunnerIds(project);
  const usable = allowlistHosts(hosts);

  const toggle = async (host: RemoteHostTarget) => {
    setBusy(true);
    setFailure(undefined);
    try {
      await setProjectRunnerIds(client, project.id, toggleRunnerId(allowed, host.id));
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
      onReload();
    }
  };

  return (
    <Group heading={TEXT.settings.runtime.allowlist.heading}>
      {usable.length === 0 ? (
        <p className="settings-empty">{TEXT.settings.runtime.allowlist.empty}</p>
      ) : (
        <div className="runner-choices">
          {usable.map((host) => (
            <label className="runner-choice" key={host.id}>
              <input
                checked={allowed.includes(host.id)}
                disabled={busy}
                onChange={() => void toggle(host)}
                type="checkbox"
              />
              <span>
                {host.runnerName ?? host.alias}
                <small>
                  {[hostKindLabel(host), hostDestination(host) ?? TEXT.settings.runtime.runner.destinationUnknown].join(" · ")}
                </small>
              </span>
            </label>
          ))}
        </div>
      )}
      {failure ? <small className="row-note is-error">{failure}</small> : null}
    </Group>
  );
}

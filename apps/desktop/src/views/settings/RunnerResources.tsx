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

/**
 * What a machine looks like once it is connected: its disk, its memory, and the
 * Ascend cards it may hand to a sandbox.
 *
 * Split out of `RemoteHosts.tsx` because that file is about *reaching* a
 * machine — registering it, trusting its key, connecting — and this one is
 * about *reading* it. The two meet at the machine card and nowhere else.
 *
 * Nothing here is inferred. A reading that did not arrive is stated as unknown
 * rather than drawn as a zero, and the CPU/GPU columns are left empty rather
 * than guessed at, which is the difference between "this machine is idle" and
 * "this machine did not answer".
 */

import { useEffect, useRef, useState } from "react";

import type { ApiClient } from "../../api/client.js";
import { browseSshKeyFiles, listSshConfigHosts, resolveSshConfigHost } from "../../api/remote.js";
import { setRunnerNpuDevices } from "../../api/settings.js";
import type {
  NpuDeviceStatus,
  NpuInventory,
  RemoteHostTarget,
  SshConfigHostImport,
  SshKeyFileListing,
} from "../../api/types.js";
import {
  diskMeter,
  isDiskLow,
  multiChipCards,
  npuAiCoreHigh,
  npuAiCorePercent,
  npuCardLabel,
  npuMemory,
  npuMemoryPercent,
  npuTemperatureTone,
  REMOTE_DISK_REQUIRED_BYTES,
  resourceBytes,
  resourceMeter,
  type ResourceMeter,
  uptimeHours,
  usableNpuCards,
} from "../../app/resource-format.js";
import { TEXT } from "../../text.js";
import { Tag } from "./rows.js";

/** One labelled reading: what it is, how much of it is in use, and how full
 *  that makes the bar. An absent reading says so in words. */
function Meter({ label, meter }: { label: string; meter: ResourceMeter | undefined }) {
  if (!meter) return <small className="row-note">{TEXT.settings.runtime.runner.resources.meterUnknown(label)}</small>;
  return (
    <div className={`resource-meter is-${meter.tone}`}>
      <div className="resource-meter-head">
        <span>{label}</span>
        <strong>
          {resourceBytes(meter.value)} / {resourceBytes(meter.total)}
        </strong>
      </div>
      <div
        aria-label={label}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={meter.percent}
        className="resource-meter-track"
        role="meter"
      >
        <span style={{ width: `${meter.percent}%` }} />
      </div>
    </div>
  );
}

/** A thin bar with no reading attached: an NPU row keeps its columns even when
 *  the machine reported nothing for one of them. */
function Bar({ percent, tone }: { percent: number | undefined; tone?: string }) {
  if (percent === undefined) return <span className="npu-bar is-empty" />;
  return (
    <span className={`npu-bar${tone === undefined ? "" : ` is-${tone}`}`}>
      <span className="npu-bar-track">
        <span style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}

/**
 * The machine behind a connected Runner.
 *
 * Shown only for a Runner that answered: while nothing is connected the product
 * knows nothing about the machine, and a disk drawn from no data at all would
 * be a lie that only looks like an answer.
 */
export function RunnerResourcePanel({ host }: { host: RemoteHostTarget }) {
  const status = host.runnerStatus;
  const resources = status?.resources;
  const text = TEXT.settings.runtime.runner.resources;
  if (status?.state !== "ready" || !resources) {
    return (
      <section aria-label={text.aria} className="resource-panel">
        <small className="row-note">
          {status?.state !== "ready"
            ? text.diskUnknown
            : (status.resourcesError ?? text.noMetrics)}
        </small>
      </section>
    );
  }
  const disk = resources.workspaceDisk;
  const low = isDiskLow(resources);
  return (
    <section aria-label={text.aria} className="resource-panel">
      <div className="resource-tile">
        <Meter label={text.diskUsed} meter={diskMeter(resources)} />
        {disk ? <small className="resource-path">{disk.path}</small> : null}
        {disk === null ? <small className="row-note is-error">{resources.workspaceDiskError}</small> : null}
        {low && disk ? (
          <div className="resource-alert" role="alert">
            {text.lowDisk(resourceBytes(disk.availableBytes), resourceBytes(REMOTE_DISK_REQUIRED_BYTES))}
          </div>
        ) : null}
      </div>
      <div className="resource-tile">
        <Meter
          label={text.memoryUsed}
          meter={resourceMeter(
            resources.memoryTotalBytes - resources.memoryFreeBytes,
            resources.memoryTotalBytes,
            "info",
          )}
        />
      </div>
      <div className="resource-stats">
        <div>
          <small>{text.cores}</small>
          <strong>{resources.cpuCores}</strong>
        </div>
        <div>
          <small>{text.load1m}</small>
          <strong>{resources.loadAverage1m.toFixed(2)}</strong>
        </div>
        <div>
          <small>{text.uptime}</small>
          <strong>
            {uptimeHours(resources.uptimeSeconds)} <small>{text.hours}</small>
          </strong>
        </div>
      </div>
      {host.capabilities?.gpu ? <small className="row-note">{text.gpu(host.capabilities.gpu)}</small> : null}
      <small className="resource-captured">
        {text.updated} <time dateTime={resources.capturedAt}>{new Date(resources.capturedAt).toLocaleString(TEXT.languageTag)}</time>
      </small>
      {status.resourcesError ? (
        <small className="row-note is-error">{status.resourcesError}</small>
      ) : null}
    </section>
  );
}

/**
 * A Runner's NPU cards and which of them may be handed to its sandboxes.
 *
 * Runner-agnostic on purpose: the local machine can carry the NPUs just as a
 * registered one can, and an operator must be able to tick either without the
 * two behaving differently. Every card is listed, including the ones that
 * cannot be used — hiding them would leave someone wondering where NPU 0 went.
 * An unusable card carries the driver's own reason on its row, so the refusal
 * is understood while ticking rather than during an execution. Its checkbox is
 * disabled only while it is unticked: a card that was usable when it was ticked
 * and has since been claimed by someone else must still be removable, and
 * disabling the whole row would leave the operator stuck with a selection every
 * execution then refuses.
 */
export function NpuDevicePanel({
  client,
  inventory,
  onError,
  onSelected,
  runnerId,
  selected,
}: {
  client: ApiClient;
  inventory: NpuInventory | null | undefined;
  onError: (message: string) => void;
  onSelected: (devices: number[]) => void;
  runnerId: string;
  selected: readonly number[];
}) {
  const [saving, setSaving] = useState(false);
  /** Ticks are edited locally until they are saved. Picking cards is a plan —
   *  "these four for the next run" — and saving each box on its own turned a
   *  four-card plan into four writes, each re-probing the machine and each able
   *  to fail on its own, with the first three already stored. */
  const [draft, setDraft] = useState<number[]>();
  if (!inventory) return null;
  const text = TEXT.settings.runtime.runner.npu;
  const ticked = new Set(draft ?? selected);
  const usable = usableNpuCards(inventory).length;
  const multi = multiChipCards(inventory);
  const dirty =
    draft !== undefined &&
    (draft.length !== selected.length
      || draft.some((hostIndex, position) => hostIndex !== selected[position]));

  const toggle = (hostIndex: number, checked: boolean) => {
    const next = new Set(ticked);
    if (checked) next.add(hostIndex);
    else next.delete(hostIndex);
    setDraft([...next].sort((left, right) => left - right));
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      onSelected((await setRunnerNpuDevices(client, runnerId, draft)).devices);
      setDraft(undefined);
    } catch (reason) {
      // The draft survives a rejected save: the Runner refusing one card must
      // not throw away the rest of what the operator picked.
      onError(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label={text.title} className="npu-panel">
      <div className="npu-head">
        <strong>{text.title}</strong>
        <small>{text.count(inventory.devices.length, usable)}</small>
      </div>
      {inventory.error ? (
        <small className="row-note is-error" role="alert">
          {inventory.error}
        </small>
      ) : null}
      {inventory.devices.length === 0 ? (
        <small className="row-note">{text.none}</small>
      ) : (
        <ul className="npu-list">
          {inventory.devices.map((device) => (
            <NpuRow
              device={device}
              disabled={saving}
              key={device.hostIndex}
              multiChip={multi.has(device.cardId ?? device.hostIndex)}
              onToggle={toggle}
              ticked={ticked.has(device.hostIndex)}
            />
          ))}
        </ul>
      )}
      {usable === 0 && inventory.devices.length > 0 ? (
        <small className="row-note is-error" role="alert">
          {text.noneUsable}
        </small>
      ) : null}
      <div className="npu-foot">
        <small>{text.renumbered}</small>
        {dirty ? (
          <div className="settings-card-actions">
            <small className="npu-unsaved">{text.unsaved}</small>
            <button className="secondary-button" disabled={saving} onClick={() => setDraft(undefined)} type="button">
              {text.discard}
            </button>
            <button className="primary-button" disabled={saving} onClick={() => void save()} type="button">
              {saving ? text.saving : text.save}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** One card: the box, its name, and whatever the machine said about it. */
function NpuRow({
  device,
  disabled,
  multiChip,
  onToggle,
  ticked,
}: {
  device: NpuDeviceStatus;
  disabled: boolean;
  multiChip: boolean;
  onToggle: (hostIndex: number, checked: boolean) => void;
  ticked: boolean;
}) {
  const text = TEXT.settings.runtime.runner.npu;
  const memoryPercent = npuMemoryPercent(device);
  const aiCore = npuAiCorePercent(device);
  return (
    <li className={`npu-row${device.sandboxUsable ? "" : " is-unusable"}`}>
      <label className="npu-pick">
        <input
          checked={ticked}
          disabled={disabled || (!device.sandboxUsable && !ticked)}
          onChange={(event) => onToggle(device.hostIndex, event.target.checked)}
          type="checkbox"
        />
        <span className="npu-name">{npuCardLabel(device, multiChip)}</span>
        {device.health ? <Tag tone={device.health === "OK" ? "off" : "warn"}>{device.health}</Tag> : null}
      </label>
      {/* Every cell renders even when its reading is missing, so the columns
          stay aligned from card to card. */}
      <span className="npu-cell" title={text.memoryLabel}>
        <span className="npu-cell-caption">{text.memoryCaption}</span>
        <Bar percent={memoryPercent} />
        <small className="npu-cell-value">
          {memoryPercent === undefined
            ? ""
            : (npuMemory(device.hbmUsedMb, device.hbmTotalMb) ?? `${Math.round(memoryPercent)}%`)}
        </small>
      </span>
      <span className="npu-cell" title={text.aiCoreLabel}>
        <Bar percent={aiCore} tone={npuAiCoreHigh(device) ? "high" : undefined} />
        <small className="npu-cell-value">{aiCore === undefined ? "" : text.aiCore(aiCore)}</small>
      </span>
      <span
        className={`npu-chip${npuTemperatureTone(device) === "" ? "" : ` is-${npuTemperatureTone(device)}`}`}
        title={text.temperatureLabel}
      >
        {device.temperatureCelsius === undefined ? "" : text.temperature(device.temperatureCelsius)}
      </span>
      <span className="npu-chip" title={text.powerLabel}>
        {device.powerWatts === undefined ? "" : text.power(Math.round(device.powerWatts))}
      </span>
      {device.sandboxUsable ? null : (
        // The driver's own wording stays as the machine reported it; only what
        // the product says around it is translated.
        <small className="npu-reason">
          {device.sandboxUnusableReason ?? text.unusable}
          {ticked ? ` ${text.unusableSelected}` : null}
        </small>
      )}
    </li>
  );
}

/**
 * Start an SSH registration from an entry the user already has.
 *
 * The product does not connect through `ssh_config` — it speaks SSH itself with
 * its own stored credentials — so this is strictly a convenience: the resolved
 * values are copied into the form's fields, and from then on the product's copy
 * is what is used. An `identityFile` this API host cannot read is worth saying
 * out loud, because the key would otherwise fail at connect time with a
 * permission error and nothing on screen would explain it.
 */
export function SshConfigImport({
  client,
  onFailure,
  onImported,
}: {
  client: ApiClient;
  onFailure: (message: string) => void;
  onImported: (entry: SshConfigHostImport) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [entries, setEntries] = useState<SshConfigHostImport[]>();
  const [note, setNote] = useState("");
  const text = TEXT.settings.runtime.runner.sshConfig;

  /** The list is loaded once per visit: it is the user's own file, and the only
   *  thing that changes it is the user editing it in another window. */
  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (entries !== undefined) return;
    setBusy("list");
    try {
      setEntries(await listSshConfigHosts(client));
    } catch (reason) {
      setOpen(false);
      onFailure(reason instanceof Error ? reason.message : text.listFailed);
    } finally {
      setBusy(undefined);
    }
  };

  /** The list response leaves out key paths on purpose, so one entry has to be
   *  resolved before its fields can be filled in. */
  const importEntry = async (selected: SshConfigHostImport) => {
    setBusy(selected.alias);
    try {
      const entry = await resolveSshConfigHost(client, selected.alias);
      onImported(entry);
      setOpen(false);
      setNote(
        text.note(
          entry.alias,
          entry.hostName ? text.noteTarget(entry.hostName) : "",
          entry.identityFile && !entry.identityKeyReadable ? text.noteKeyUnreadable : "",
        ),
      );
    } catch (reason) {
      onFailure(reason instanceof Error ? reason.message : text.importFailed(selected.alias));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      {/* The import is an action on the alias field above, so the row holds the
          button alone: a line of copy here put it inside a second, wrapping
          column and pushed it off the action edge every other row of this card
          ends on. */}
      <div className="machine-actions">
        <button
          aria-expanded={open}
          className="secondary-button"
          disabled={busy !== undefined}
          onClick={() => void toggle()}
          type="button"
        >
          {text.import}
        </button>
      </div>
      {note === "" ? null : (
        <p className="field-help" role="status">
          {note}
        </p>
      )}
      {open ? (
        <div className="ssh-config-list">
          {entries === undefined ? (
            <small className="row-note">{text.loading}</small>
          ) : entries.length === 0 ? (
            <small className="row-note">{text.none}</small>
          ) : (
            entries.map((entry) => (
              <button
                className="ssh-config-entry"
                disabled={busy !== undefined}
                key={entry.alias}
                onClick={() => void importEntry(entry)}
                type="button"
              >
                <strong>{entry.alias}</strong>
                <small>
                  {[
                    entry.hostName,
                    entry.port === undefined ? "" : text.portPrefix(entry.port),
                    entry.username,
                  ]
                    .filter((part) => part !== undefined && part !== "")
                    .join(" · ")}
                </small>
              </button>
            ))
          )}
        </div>
      ) : null}
    </>
  );
}

/**
 * A private key path, with a way to find one.
 *
 * The browser cannot open it — an SSH key has to be readable on the machine the
 * API runs on, which is neither this browser nor the SSH target — so the field
 * is a text box plus a browse dialog over that machine's own filesystem. Only
 * the chosen path is filled in; no key material ever crosses the wire.
 */
export function SshKeyFileField({
  client,
  disabled,
  label,
  onChange,
  placeholder,
  value,
}: {
  client: ApiClient;
  disabled?: boolean;
  label: string;
  onChange: (path: string) => void;
  placeholder: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [location, setLocation] = useState("");
  const [listing, setListing] = useState<SshKeyFileListing>();
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  /** Bumped on every navigation and on close, so a slow listing that lands
   *  after the dialog moved on cannot overwrite what is on screen. */
  const generation = useRef(0);
  const text = TEXT.settings.runtime.runner.keyBrowser;

  const close = () => {
    generation.current += 1;
    setOpen(false);
    setLoading(false);
    setListing(undefined);
    setError("");
  };

  const browse = async (path?: string, page = 0) => {
    const request = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await browseSshKeyFiles(client, path, page);
      if (request !== generation.current) return;
      setListing(result);
      setLocation(result.directory);
      setOffset(page);
    } catch (reason) {
      if (request !== generation.current) return;
      setListing(undefined);
      setError(reason instanceof Error ? reason.message : text.browseFailed);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  };

  return (
    <div className="machine-field">
      <span>{label}</span>
      <div className="key-path-row">
        <input
          autoComplete="off"
          className="field-input"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          value={value}
        />
        <button
          aria-haspopup="dialog"
          className="secondary-button"
          disabled={disabled}
          onClick={() => {
            if (open) close();
            else {
              setOpen(true);
              setLocation(value);
              void browse(value || undefined);
            }
          }}
          type="button"
        >
          {text.browse}
        </button>
      </div>

      {open ? (
        <div className="modal-backdrop" onMouseDown={(event) => event.stopPropagation()}>
          <div aria-busy={loading} aria-label={text.aria} className="modal-panel key-browser" role="dialog">
            <div className="key-browser-head">
              <strong>{text.title}</strong>
              <button aria-label={TEXT.settings.close} className="icon-button" onClick={close} type="button">
                ×
              </button>
            </div>
            <p className="field-help">{text.help}</p>
            <label className="machine-field">
              <span>{text.pathLabel}</span>
              <div className="key-path-row">
                <input
                  className="field-input"
                  disabled={disabled || loading}
                  onChange={(event) => setLocation(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void browse(location || undefined);
                  }}
                  placeholder="~/.ssh"
                  spellCheck={false}
                  value={location}
                />
                <button
                  className="secondary-button"
                  disabled={disabled || loading}
                  onClick={() => void browse(location || undefined)}
                  type="button"
                >
                  {text.go}
                </button>
              </div>
            </label>
            <div className="key-browser-actions">
              <button
                className="secondary-button"
                disabled={disabled || loading || !listing?.parentDirectory}
                onClick={() => void browse(listing?.parentDirectory ?? undefined)}
                type="button"
              >
                {text.up}
              </button>
              <button className="secondary-button" disabled={disabled || loading} onClick={() => void browse("~")} type="button">
                {text.home}
              </button>
            </div>
            {error === "" ? null : (
              <small className="row-note is-error" role="alert">
                {error}
              </small>
            )}
            {loading ? (
              <small className="row-note" role="status">
                {text.loading}
              </small>
            ) : listing === undefined ? null : (
              <>
                <small className="key-browser-directory">{listing.directory}</small>
                {listing.entries.length === 0 ? (
                  <small className="row-note">{text.empty}</small>
                ) : (
                  <ul className="key-browser-list">
                    {listing.entries.map((entry) => (
                      <li key={entry.path}>
                        <button
                          className="secondary-button"
                          disabled={disabled || entry.kind === "unavailable"}
                          onClick={() => {
                            if (entry.kind === "directory") void browse(entry.path);
                            else {
                              onChange(entry.path);
                              close();
                            }
                          }}
                          type="button"
                        >
                          <span>{entry.name}</span>
                          <small>
                            {entry.kind === "directory" ? text.folder : entry.kind === "file" ? text.selectFile : text.unavailable}
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {offset > 0 || listing.nextOffset !== null ? (
                  <div className="key-browser-actions">
                    <button
                      className="secondary-button"
                      disabled={disabled || offset === 0}
                      onClick={() => void browse(listing.directory, Math.max(0, offset - 100))}
                      type="button"
                    >
                      {text.previousPage}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={disabled || listing.nextOffset === null}
                      onClick={() => void browse(listing.directory, listing.nextOffset ?? 0)}
                      type="button"
                    >
                      {text.nextPage}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

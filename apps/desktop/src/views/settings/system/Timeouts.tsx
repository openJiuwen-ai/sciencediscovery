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

import type { ApiClient } from "../../../api/client.js";
import { getTimeoutSettings, updateTimeoutSettings } from "../../../api/settings.js";
import type { SystemTimeoutSettings } from "../../../api/types.js";
import { useLoaded } from "../../../app/use-loaded.js";
import { TEXT } from "../../../text.js";
import { Group, LoadGate, Row, Switch } from "../rows.js";

type TimeoutField = keyof SystemTimeoutSettings;

function fields(): { field: TimeoutField; hint: string; label: string }[] {
  const text = TEXT.settings.system.timeouts;
  return [
    { field: "gatewayIdleTimeoutMs", label: text.gatewayIdle, hint: text.gatewayIdleHint },
    { field: "gatewayTurnTimeoutMs", label: text.gatewayTurn, hint: text.gatewayTurnHint },
    { field: "kernelIdleTimeoutMs", label: text.kernelIdle, hint: text.kernelIdleHint },
    { field: "permissionWaitTimeoutMs", label: text.permissionWait, hint: text.permissionWaitHint },
    { field: "runnerExecTimeoutMs", label: text.runnerExec, hint: text.runnerExecHint },
  ];
}

function seconds(ms: number): string {
  return String(Math.round((ms / 1000) * 1000) / 1000);
}

/**
 * 设置 › 超时: the wall-clock limits, where zero means 不限.
 *
 * This page used to stage a draft and wait for the footer's 保存, which made it
 * the one page in 设置 that did not write on the press. The footer is gone, so
 * the draft commits itself: a switch the moment it flips, a number when its
 * field is left or Enter is pressed. The write is a whole-object PUT, so edits
 * that arrive while one is in flight are coalesced into the latest draft
 * rather than racing each other.
 */
export function TimeoutSettings({ client }: { client: ApiClient }) {
  const loaded = useLoaded<SystemTimeoutSettings>(async () => getTimeoutSettings(client));
  const [draft, setDraft] = useState<SystemTimeoutSettings>();
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<string>();
  const [failure, setFailure] = useState<string>();

  /** The draft as of this instant: a field's blur has to send what was typed,
   *  not what the last render happened to capture. */
  const latest = useRef<SystemTimeoutSettings | undefined>(undefined);
  /** What the server last confirmed — where a refused write falls back to. */
  const stored = useRef<SystemTimeoutSettings | undefined>(undefined);
  /** At most one write on the wire; a newer draft replaces anything queued. */
  const queued = useRef<SystemTimeoutSettings | undefined>(undefined);
  const writing = useRef(false);

  useEffect(() => {
    if (loaded.value === undefined) return;
    stored.current = loaded.value;
    latest.current = loaded.value;
    setDraft(loaded.value);
  }, [loaded.value]);

  const update = (next: SystemTimeoutSettings) => {
    latest.current = next;
    setDraft(next);
  };

  const flush = async () => {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    try {
      while (queued.current !== undefined) {
        const next = queued.current;
        queued.current = undefined;
        try {
          await updateTimeoutSettings(client, next);
          stored.current = next;
          setSavedAt(new Date().toLocaleTimeString());
          setFailure(undefined);
        } catch (reason) {
          // The fields go back to what the server has; anything queued behind
          // a write that did not land was written against that same draft.
          queued.current = undefined;
          update(stored.current ?? next);
          setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
          return;
        }
      }
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };

  const commit = (next: SystemTimeoutSettings) => {
    queued.current = next;
    void flush();
  };

  const setMilliseconds = (field: TimeoutField, value: string) => {
    const text = value.trim();
    // An empty box is a field mid-edit, not a request to disable the timeout:
    // Number("") is 0, and 0 means 不限.
    if (text === "") return;
    const parsed = Number(text);
    const base = latest.current;
    if (base === undefined || !Number.isFinite(parsed) || parsed < 0) return;
    update({ ...base, [field]: Math.round(parsed * 1000) } as SystemTimeoutSettings);
  };

  const setUnlimited = (field: TimeoutField, unlimited: boolean) => {
    const base = latest.current;
    if (base === undefined) return;
    const next = {
      ...base,
      [field]: unlimited ? 0 : (base[field] || 60_000),
    } as SystemTimeoutSettings;
    update(next);
    commit(next);
  };

  return (
    <LoadGate loaded={loaded}>
      {(settings) => {
        const current = draft ?? settings;
        return (
          <Group>
            <p className="settings-note">{TEXT.settings.system.timeouts.help}</p>
            {fields().map(({ field, hint, label }) => {
              const unlimited = current[field] === 0;
              return (
                <Row hint={hint} key={field} title={label}>
                  <div className="row-inline-control">
                    <input
                      aria-label={label}
                      className="field-input is-number"
                      disabled={unlimited}
                      min="0.001"
                      onBlur={() => {
                        // Leaving the field commits it, unless nothing changed.
                        const next = latest.current;
                        if (next !== undefined && next !== stored.current) commit(next);
                      }}
                      onChange={(event) => setMilliseconds(field, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        event.currentTarget.blur();
                      }}
                      step="0.001"
                      type="number"
                      value={unlimited ? "" : seconds(current[field])}
                    />
                    <small>{TEXT.settings.system.timeouts.seconds}</small>
                    <label className="settings-toggle-line">
                      <span>{TEXT.settings.system.timeouts.unlimited}</span>
                      <Switch
                        label={`${label} · ${TEXT.settings.system.timeouts.unlimited}`}
                        onChange={(next) => setUnlimited(field, next)}
                        value={unlimited}
                      />
                    </label>
                  </div>
                </Row>
              );
            })}
            <small aria-live="polite" className="settings-detail-meta">
              {busy
                ? TEXT.settings.system.saving
                : savedAt === undefined
                  ? null
                  : `${TEXT.settings.system.timeouts.saved} · ${savedAt}`}
            </small>
            {failure ? <small className="row-note is-error">{failure}</small> : null}
          </Group>
        );
      }}
    </LoadGate>
  );
}

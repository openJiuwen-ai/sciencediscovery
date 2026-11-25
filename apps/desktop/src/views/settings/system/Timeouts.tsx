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

import { commitsOnEnter } from "../../../app/ime-enter.js";
import type { ApiClient } from "../../../api/client.js";
import { getTimeoutSettings, updateTimeoutSettings } from "../../../api/settings.js";
import type { SystemTimeoutSettings } from "../../../api/types.js";
import { useLoaded } from "../../../app/use-loaded.js";
import { formatClock, TEXT } from "../../../text.js";
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
 * The one cross-field rule this page has: with both gateway limits finite, the
 * turn limit cannot be shorter than the idle limit.
 *
 * It mirrors `normalizeTimeoutSettings` in services/api/src/store/settings.ts,
 * where a zero means 不限 and lifts the rule on whichever side has it. The
 * service stays the owner of the rule; this copy exists so the field can say
 * so before a write instead of letting the store refuse it afterwards.
 */
function orderingProblem(next: SystemTimeoutSettings): TimeoutField | undefined {
  if (next.gatewayIdleTimeoutMs > 0
    && next.gatewayTurnTimeoutMs > 0
    && next.gatewayTurnTimeoutMs < next.gatewayIdleTimeoutMs) {
    return "gatewayTurnTimeoutMs";
  }
  return undefined;
}

/** The store's refusal in the reader's language, or undefined for any other
 *  failure.
 *
 * `normalizeTimeoutSettings` throws a sentence naming both wire fields; it is
 * a server diagnosis, not form copy. Only this refusal is translated — every
 * other failure keeps the service's own words. */
function localizedRefusal(message: string): string | undefined {
  return /gatewayTurnTimeoutMs/u.test(message) && /gatewayIdleTimeoutMs/u.test(message)
    ? TEXT.settings.system.timeouts.orderError
    : undefined;
}

/**
 * The value an 不限 switch restores when it is turned off.
 *
 * The fixed 60 s this used to seed was below the shipped 240 s idle limit, so
 * the first press on 超时 produced a pair the service refuses without the
 * reader typing anything. Seeding from the other limit keeps the pair valid on
 * both sides: a turn limit is raised to the idle limit, an idle limit is
 * capped at a finite turn limit.
 */
function seedMilliseconds(field: TimeoutField, base: SystemTimeoutSettings): number {
  const seed = base[field] || 60_000;
  if (field === "gatewayTurnTimeoutMs" && base.gatewayIdleTimeoutMs > 0) {
    return Math.max(seed, base.gatewayIdleTimeoutMs);
  }
  if (field === "gatewayIdleTimeoutMs" && base.gatewayTurnTimeoutMs > 0) {
    return Math.min(seed, base.gatewayTurnTimeoutMs);
  }
  return seed;
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
 *
 * The two gateway limits are ordered: a finite 一轮对话 cannot be shorter than
 * a finite 网关空闲, the rule `normalizeTimeoutSettings` enforces in
 * services/api/src/store/settings.ts. This page states the rule on the field,
 * refuses the pair there before the PUT, and never answers a refusal by
 * restoring fields the reader did not touch.
 */
export function TimeoutSettings({ client }: { client: ApiClient }) {
  const loaded = useLoaded<SystemTimeoutSettings>(async () => getTimeoutSettings(client));
  const [draft, setDraft] = useState<SystemTimeoutSettings>();
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<string>();
  const [failure, setFailure] = useState<string>();
  /** The field a refusal names, marked until its pair is edit-able again. */
  const [refusedField, setRefusedField] = useState<TimeoutField>();

  /** The draft as of this instant: a field's blur has to send what was typed,
   *  not what the last render happened to capture. */
  const latest = useRef<SystemTimeoutSettings | undefined>(undefined);
  /** What the server last confirmed. Kept for the "nothing changed" test on
   *  blur; a refusal no longer restores it over the reader's draft. */
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
    // Correcting either side of the pair clears the mark; the next commit
    // decides afresh whether the draft may be written.
    if (orderingProblem(next) === undefined) setRefusedField(undefined);
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
          setFailure(undefined);
          // A success describes the current draft only while that draft is
          // still valid. If the reader produced an invalid pair while this
          // write was on the wire, the refusal already cleared the timestamp
          // and it must not come back beside an unsaved value.
          if (latest.current === undefined || orderingProblem(latest.current) === undefined) {
            setSavedAt(formatClock());
            setRefusedField(undefined);
          }
        } catch (reason) {
          // A correction that arrived while this write was on the wire is the
          // reader's next attempt, not part of the refusal: validate and send
          // it rather than dropping it with the failed draft.
          if (queued.current !== undefined) continue;
          // A refused write keeps the draft. The fields the reader did not
          // touch are still theirs to correct, so only the field the refusal
          // names is marked; nothing is restored behind their back.
          const message = reason instanceof Error ? reason.message : "";
          const localized = localizedRefusal(message);
          if (localized !== undefined) {
            // The explanation belongs to the field rather than to the page:
            // the same sentence twice would read as two separate problems.
            setRefusedField("gatewayTurnTimeoutMs");
            setFailure(undefined);
            setSavedAt(undefined);
            return;
          }
          setFailure(message || TEXT.settings.saveFailed);
          setSavedAt(undefined);
          return;
        }
      }
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };

  const commit = (next: SystemTimeoutSettings) => {
    const problem = orderingProblem(next);
    if (problem !== undefined) {
      // Refused at the field: nothing is sent, and the draft stays so the
      // reader can correct either side of the pair instead of losing it.
      latest.current = next;
      setDraft(next);
      setRefusedField(problem);
      setFailure(undefined);
      // The previous 已保存 timestamp no longer describes what is on screen.
      setSavedAt(undefined);
      return;
    }
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
      [field]: unlimited ? 0 : seedMilliseconds(field, base),
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
              const refused = refusedField === field;
              return (
                <Row
                  hint={hint}
                  key={field}
                  note={refused
                    ? <small className="row-note is-error" id="timeout-order-error" role="alert">
                      {TEXT.settings.system.timeouts.orderError}
                    </small>
                    : undefined}
                  title={label}
                >
                  <div className="row-inline-control">
                    <input
                      aria-describedby={refused ? "timeout-order-error" : undefined}
                      aria-invalid={refused}
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
                        if (!commitsOnEnter(event)) return;
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

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
import { commitsOnEnter } from "../../app/ime-enter.js";
import { TEXT } from "../../text.js";

/** One mutation at a time, including the interval before React paints busy. */
export function useSettingsWrite() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [savedAt, setSavedAt] = useState<string>();
  const [saving, setSaving] = useState(true);
  const writing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (operation: () => Promise<void>, markSaved = true) => {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true); setSaving(markSaved); setFailure(undefined); setSavedAt(undefined);
    try {
      await operation();
      if (mounted.current && markSaved) setSavedAt(new Date().toLocaleTimeString());
      return true;
    } catch (reason) {
      if (mounted.current) setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
      return false;
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return { busy, failure, saved: savedAt !== undefined, savedAt, saving, run };
}

export function WriteStatus({ state, pendingLabel, successLabel, quiet = false }: {
  state: ReturnType<typeof useSettingsWrite>;
  pendingLabel?: string;
  successLabel?: string | null;
  /** Quiet writes still report failures. */
  quiet?: boolean;
}) {
  const success = successLabel === undefined ? TEXT.settings.system.migrated.common.saved : successLabel;
  const message = state.busy
    ? pendingLabel ?? (state.saving ? TEXT.settings.system.saving : TEXT.settings.system.migrated.common.working)
    : state.saved && success ? `${success} · ${state.savedAt}` : null;
  return <>
    <small className="settings-detail-meta" aria-live="polite">{!quiet && !state.failure ? message : null}</small>
    {state.failure ? <small className="row-note is-error" role="alert">{state.failure}</small> : null}
  </>;
}

/** Keep empty and fractional input as text until the user finishes editing. */
export function SettingsNumber({ value, label, disabled, min, max, scale = 1, precision, onCommit }: {
  value: number; label: string; disabled?: boolean; min: number; max?: number;
  scale?: number; precision?: number; onCommit: (value: number) => void;
}) {
  const displayed = precision === undefined ? String(value / scale) : (value / scale).toFixed(precision);
  const [draft, setDraft] = useState(displayed);
  const edited = useRef(false);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(displayed); setInvalid(false); edited.current = false; }, [value, displayed]);
  const commit = () => {
    if (disabled || !edited.current) return;
    const parsed = Number(draft);
    const number = precision === undefined ? parsed : Number(parsed.toFixed(precision));
    const stored = Math.round(number * scale);
    if (!draft.trim() || !Number.isFinite(number) || number < min || (max !== undefined && number > max)
      || !Number.isSafeInteger(stored) || (scale === 1 && !Number.isInteger(number))) {
      setInvalid(true); return;
    }
    setInvalid(false);
    setDraft(precision === undefined ? String(number) : number.toFixed(precision));
    if (stored !== value) onCommit(stored);
    else edited.current = false;
  };
  return <div className="settings-number">
    <input aria-label={label} aria-invalid={invalid} className="field-input is-number"
      disabled={disabled} min={min} max={max} step={precision === undefined ? scale === 1 ? 1 : "any" : 10 ** -precision} type="number"
      value={disabled && value === 0 ? "" : draft}
      onChange={event => { edited.current = true; setDraft(event.target.value); setInvalid(false); }} onBlur={commit}
      onKeyDown={event => { if (commitsOnEnter(event)) { event.preventDefault(); event.currentTarget.blur(); } }} />
    {invalid ? <small className="row-note is-error" role="alert">{TEXT.settings.system.migrated.common.invalidNumber}</small> : null}
  </div>;
}

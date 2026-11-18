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
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(true);
  const writing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (operation: () => Promise<void>, markSaved = true) => {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true); setSaving(markSaved); setFailure(undefined); setSaved(false);
    try {
      await operation();
      if (mounted.current) setSaved(markSaved);
      return true;
    } catch (reason) {
      if (mounted.current) setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
      return false;
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return { busy, failure, saved, saving, run };
}

export function WriteStatus({ state, pendingLabel, successLabel, quiet = false }: {
  state: ReturnType<typeof useSettingsWrite>;
  pendingLabel?: string;
  successLabel?: string | null;
  /** Quiet writes still report failures. */
  quiet?: boolean;
}) {
  const message = state.busy
    ? pendingLabel ?? (state.saving ? TEXT.settings.system.saving : TEXT.settings.system.migrated.common.working)
    : state.saved ? successLabel === undefined ? TEXT.settings.system.migrated.common.saved : successLabel : null;
  return <div className="settings-write-status" aria-live="polite">
    {state.failure ? <p className="row-note is-error" role="alert">{state.failure}</p>
      : !quiet && message ? <small>{message}</small> : null}
  </div>;
}

/** Keep empty and fractional input as text until the user finishes editing. */
export function SettingsNumber({ value, label, disabled, min, max, scale = 1, onCommit }: {
  value: number; label: string; disabled?: boolean; min: number; max?: number;
  scale?: number; onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value / scale));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(String(value / scale)); setInvalid(false); }, [value, scale]);
  const commit = () => {
    if (disabled) return;
    const number = Number(draft);
    const stored = Math.round(number * scale);
    if (!draft.trim() || !Number.isFinite(number) || number < min || (max !== undefined && number > max)
      || !Number.isSafeInteger(stored) || (scale === 1 && !Number.isInteger(number))) {
      setInvalid(true); return;
    }
    setInvalid(false);
    if (stored !== value) onCommit(stored);
  };
  return <div className="settings-number">
    <input aria-label={label} aria-invalid={invalid} className="field-input is-number"
      disabled={disabled} min={min} max={max} step={scale === 1 ? 1 : "any"} type="number"
      value={disabled && value === 0 ? "" : draft}
      onChange={event => { setDraft(event.target.value); setInvalid(false); }} onBlur={commit}
      onKeyDown={event => { if (commitsOnEnter(event)) { event.preventDefault(); event.currentTarget.blur(); } }} />
    {invalid ? <small className="row-note is-error" role="alert">{TEXT.settings.system.migrated.common.invalidNumber}</small> : null}
  </div>;
}

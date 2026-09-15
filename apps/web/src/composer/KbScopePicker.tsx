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
import type { RuntimeSettingsDetails, RuntimeSettingsSource } from "@sciencediscovery/schema";
import type { KeKb } from "../api/knowledge-engine.js";
import { NotebookIcon } from "../icons.js";
import { useLocale } from "../i18n/index.js";

/**
 * Composer picker for the session knowledge-base scope (kbScopeKbIds /
 * kbScopeWebSearch runtime settings). Writes go through the caller's
 * read-modify-write on the session settings overrides; a present-but-
 * undefined value means "drop the override, inherit again". DeepAnalyze
 * parity: the collapsed trigger doubles as the always-visible badge that
 * shows the conversation is bound to N knowledge bases.
 */
/**
 * Exactly one field per call; a value of `undefined` drops the override
 * (inherit again) while an array/boolean pins it on the session layer.
 */
export type KbScopeUpdate =
  | { kbScopeKbIds: string[] | undefined; kbScopeWebSearch?: never }
  | { kbScopeKbIds?: never; kbScopeWebSearch: boolean | undefined };

function scopeSourceLabel(source: RuntimeSettingsSource | undefined): string {
  if (!source || source === "unset") return "";
  return `${source[0]!.toUpperCase()}${source.slice(1)} setting`;
}

export function KbScopePicker({
  details,
  disabled = false,
  kbs,
  onChange,
}: {
  details?: RuntimeSettingsDetails;
  disabled?: boolean;
  kbs: readonly KeKb[];
  onChange: (update: KbScopeUpdate) => Promise<void> | void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const overriding = details?.overrides.kbScopeKbIds !== undefined;
  const boundIds = overriding
    ? details?.overrides.kbScopeKbIds ?? []
    : details?.effective.kbScopeKbIds ?? [];
  const webInheritedDenied = details?.effective.kbScopeWebSearch === false;
  const webDenied = details?.overrides.kbScopeWebSearch !== undefined
    ? details.overrides.kbScopeWebSearch === false
    : webInheritedDenied;
  const boundCount = boundIds.length;
  const summary = boundCount
    ? t("composer.kbScopeBound", { bound: boundCount, total: kbs.length })
    : t("composer.kbScopeUnbound");

  function toggleKb(kbId: string): void {
    // In inherit mode a click enters override seeded from the effective set,
    // so toggling never silently drops an inherited binding.
    const base = boundIds;
    const next = base.includes(kbId)
      ? base.filter((item) => item !== kbId)
      : [...base, kbId];
    void onChange({ kbScopeKbIds: next });
  }

  /**
   * One control, three outcomes: flip the denied state; when the flipped
   * state equals what inheritance already provides, drop the override —
   * otherwise pin it (including an explicit session-layer `true` that
   * re-allows web search shadowed off by a project layer).
   */
  function toggleWebOnly(): void {
    const nextDenied = !webDenied;
    if (nextDenied === webInheritedDenied) void onChange({ kbScopeWebSearch: undefined });
    else void onChange({ kbScopeWebSearch: !nextDenied });
  }

  return <div className="connector-picker kb-scope-picker" ref={rootRef}>
    <button
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={`${t("composer.kbScopeTitle")}: ${summary}`}
      className={boundCount ? "connector-picker-trigger has-enabled" : "connector-picker-trigger"}
      data-testid="kb-scope-trigger"
      disabled={disabled || !details}
      onClick={() => setOpen((current) => !current)}
      title={summary}
      type="button"
    >
      <NotebookIcon size={15} />
      <span className="connector-picker-count">{boundCount}</span>
    </button>
    {open ? <div aria-label={t("composer.kbScopeTitle")} className="connector-picker-popover" role="dialog">
      <div className="connector-picker-heading">
        <strong>{t("composer.kbScopeTitle")}</strong>
        <span>{summary}</span>
      </div>
      <select
        aria-label={t("composer.kbScopeModeAria")}
        data-testid="kb-scope-mode"
        disabled={disabled}
        onChange={(event) => {
          if (event.target.value === "override") void onChange({ kbScopeKbIds: [...boundIds] });
          else void onChange({ kbScopeKbIds: undefined });
        }}
        value={overriding ? "override" : "inherit"}
      >
        <option value="inherit">
          {overriding || !boundCount
            ? t("composer.kbScopeInheritEmpty")
            : t("composer.kbScopeInherit", { count: boundCount, source: scopeSourceLabel(details?.sources.kbScopeKbIds) })}
        </option>
        <option value="override">{t("composer.kbScopeOverride")}</option>
      </select>
      {kbs.length ? <ul>
        {kbs.map((kb) => {
          const bound = boundIds.includes(kb.id);
          return <li key={kb.id}>
            <label>
              <input
                aria-label={t("composer.kbScopeKbAria", { name: kb.name })}
                checked={bound}
                data-testid={`kb-scope-kb-${kb.id}`}
                disabled={disabled}
                onChange={() => toggleKb(kb.id)}
                title={overriding ? undefined : t("composer.kbScopeOverride")}
                type="checkbox"
              />
              <span>
                <strong>{kb.name}</strong>
                <small>{t("composer.kbScopeKbStats", {
                  documents: kb.stats?.documents ?? 0,
                  entities: kb.stats?.entities ?? 0,
                })}</small>
              </span>
            </label>
          </li>;
        })}
      </ul> : <p className="connector-picker-note">{t("composer.kbScopeEmpty")}</p>}
      {!kbs.length ? null : boundCount ? <label className="kb-scope-web">
        <input
          checked={webDenied}
          data-testid="kb-scope-web-only"
          disabled={disabled}
          onChange={() => toggleWebOnly()}
          type="checkbox"
        />
        <span>{t("composer.kbScopeWebOnly")}</span>
      </label> : null}
      <p className="connector-picker-note">{t("composer.kbScopeNote")}</p>
    </div> : null}
  </div>;
}

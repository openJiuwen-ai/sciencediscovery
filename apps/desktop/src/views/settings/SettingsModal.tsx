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

import { useEffect, useRef, type ReactNode } from "react";

import { TEXT } from "../../text.js";
import { claimsEscape } from "../dialog-escape.js";

/**
 * The open settings modals, bottom to top.
 *
 * A picker opens over the specialist form on the same `document`, and that
 * form's listener was registered first. `preventDefault` alone would therefore
 * arrive too late, so each modal also asks whether it is the top one. The
 * stack is what makes one Escape close one dialog when both listen on the same
 * node.
 */
const modalStack: symbol[] = [];

interface Props {
  children: ReactNode;
  closeDisabled?: boolean;
  /** One line under the title that says what the form is for. Optional: a
   *  dialog whose title already says it renders without one. */
  hint?: ReactNode;
  /** The dialog's title, and what a screen reader announces it as. */
  label: string;
  onClose: () => void;
  /** Forms with stacked choices (the specialist form) need more room than the
   *  model form's five fields. */
  wide?: boolean;
  /** Specialist capability selection uses a right-side drawer. */
  side?: boolean;
}

/**
 * The shell 设置 uses for a form that opens over a page: 添加模型, 新增/编辑专家,
 * and the capability picker inside the specialist form.
 *
 * Escape belongs to the topmost settings dialog. The settings surface listens
 * on `window` and would otherwise close together with the modal; claiming the
 * key here first is what keeps only the modal from closing. Between two
 * settings modals the stack above decides which one is on top.
 */
export function SettingsModal({ children, closeDisabled = false, hint, label, onClose, wide = false, side = false }: Props) {
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!side) return;
    const previous = document.activeElement;
    const controls = () => Array.from(surface.current?.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex='0']") ?? [])
      .filter(node => !node.hasAttribute("disabled") && node.getClientRects().length > 0);
    controls()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const nodes = controls(), first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => { document.removeEventListener("keydown", trap); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [side]);
  // Re-registering on every new callback would move this dialog back on top of
  // a picker that opened after it, so the listener reads the current callback
  // through a ref and registers once.
  const close = () => {
    if (!closeDisabled) onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const id = Symbol("settings-modal");
    modalStack.push(id);
    const onKey = (event: KeyboardEvent) => {
      if (!claimsEscape(event)) return;
      if (modalStack[modalStack.length - 1] !== id) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      const index = modalStack.indexOf(id);
      if (index !== -1) modalStack.splice(index, 1);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div
      className={`modal-scrim${side ? " specialist-drawer-scrim" : ""}`}
      onPointerDown={(event) => {
        // A nested picker draws over this scrim; closing this dialog too would
        // close both on one click.
        event.stopPropagation();
        close();
      }}
    >
      <div
        aria-label={label}
        aria-modal="true"
        className={`settings-modal${wide ? " is-wide" : ""}${side ? " specialist-drawer" : ""}`}
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
        ref={surface}
      >
        <div className="settings-modal-head">
          <div className="settings-modal-heading">
            <h2>{label}</h2>
            {hint ? <p className="settings-modal-hint">{hint}</p> : null}
          </div>
          <button
            aria-label={TEXT.settings.close}
            className="settings-modal-close"
            disabled={closeDisabled}
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

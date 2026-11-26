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
  className?: string;
  returnFocus?: HTMLElement | null;
  heading?: ReactNode;
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
export function McpModal({ children, closeDisabled = false, hint, label, onClose, wide = false, className = "", returnFocus, heading }: Props) {
  const panel = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    const previous = returnFocus ?? document.activeElement as HTMLElement | null;
    node.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]):not([hidden]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]'))
        .filter((item) => !item.matches(":disabled") && item.getClientRects().length > 0);
      const first = items[0], last = items.at(-1);
      if (!first || !last) { event.preventDefault(); node.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === node)) {
        event.preventDefault(); first.focus();
      }
    };
    node.addEventListener("keydown", trap);
    return () => { node.removeEventListener("keydown", trap); if (previous?.isConnected) previous.focus(); };
  }, [className, returnFocus]);

  useEffect(() => {
    // Disabling the focused submit button can move focus to the document body.
    // Keep a pending MCP operation inside its modal keyboard boundary.
    if (closeDisabled) panel.current?.focus();
  }, [closeDisabled, className]);

  return (
    <div
      className="modal-scrim"
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
        className={`settings-modal${wide ? " is-wide" : ""} ${className}`.trim()}
        onPointerDown={(event) => event.stopPropagation()}
        ref={panel}
        role="dialog"
        tabIndex={-1}
      >
        <div className="settings-modal-head">
          <div className="settings-modal-heading">
            {heading ?? <><h2>{label}</h2>{hint ? <p className="settings-modal-hint">{hint}</p> : null}</>}
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

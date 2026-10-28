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
  /** The dialog's title, and what a screen reader announces it as. */
  label: string;
  onClose: () => void;
  /** Forms with stacked choices (the specialist form) need more room than the
   *  model form's five fields. */
  wide?: boolean;
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
export function SettingsModal({ children, label, onClose, wide = false }: Props) {
  // Re-registering on every new callback would move this dialog back on top of
  // a picker that opened after it, so the listener reads the current callback
  // through a ref and registers once.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

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
      className="modal-scrim"
      onPointerDown={(event) => {
        // A nested picker draws over this scrim; closing this dialog too would
        // close both on one click.
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        aria-label={label}
        aria-modal="true"
        className={`settings-modal${wide ? " is-wide" : ""}`}
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="settings-modal-head">
          <h2>{label}</h2>
          <button
            aria-label={TEXT.settings.close}
            className="settings-modal-close"
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

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

/**
 * One 技能 dialog over the settings surface, as the handoff draws both ways in.
 *
 * The dialog is drawn in the tree rather than portalled: the settings surface
 * is itself a fixed layer, so the backdrop has to sit above it, and staying in
 * the tree keeps the dialog testable without a document body.
 *
 * Escape is claimed in the capture phase. 设置 also listens for Escape on
 * `window` and closes itself; without this, one press would close the dialog
 * and the settings surface behind it.
 */
export function SkillDialog({
  children,
  onClose,
  title,
}: {
  children: ReactNode;
  onClose: () => void;
  title: string;
}) {
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    root.current?.focus();
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="skill-dialog-backdrop">
      <section
        aria-label={title}
        aria-modal="true"
        className="skill-dialog"
        ref={root}
        role="dialog"
        tabIndex={-1}
      >
        <header className="skill-dialog-head">
          <h3>{title}</h3>
          <button
            aria-label={TEXT.settings.skills.closeDialog}
            className="skill-dialog-close"
            onClick={onClose}
            type="button"
          >
            <svg
              aria-hidden="true"
              fill="none"
              height="14"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.6"
              viewBox="0 0 24 24"
              width="14"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <div className="skill-dialog-body">{children}</div>
      </section>
    </div>
  );
}

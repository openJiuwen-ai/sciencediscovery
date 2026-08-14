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

// Generic modal shell shared by artifact and node-detail viewers. Lifts the
// backdrop/panel/header chrome out of ArtifactModal so evidence (and other
// non-artifact nodes) get the same surface without being called "artifact".

import type { ReactNode } from "react";

export interface DetailModalProps {
  /** Small label above the title (e.g. "Evidence", "markdown"). */
  eyebrow: string;
  /** Clicking the backdrop or the close button calls this. */
  onClose: () => void;
  /** Controls shown in the header right of the title (optional). */
  controls?: ReactNode;
  /** Panel title. */
  title: string;
  /** Body content. */
  children: ReactNode;
}

export function DetailModal({ children, controls, eyebrow, onClose, title }: DetailModalProps) {
  return (
    <div className="artifact-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-label={`Detail: ${title}`} aria-modal="true" className="artifact-modal-panel" role="dialog">
        <header className="artifact-modal-header">
          <div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>
          <div className="artifact-modal-controls">
            {controls}
            <button aria-label="Close detail viewer" className="icon-button" onClick={onClose} title="Close detail viewer" type="button">✕</button>
          </div>
        </header>
        <div className="artifact-modal-body">
          {children}
        </div>
      </section>
    </div>
  );
}

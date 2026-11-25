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

import { TEXT } from "../../text.js";

export interface SkillToastItem {
  detail?: string;
  /** Stable across re-renders, so a replacement keeps its place in the stack. */
  id: string;
  kind: "error" | "progress" | "success";
  message: string;
  onClose: () => void;
  /** Offered only where repeating the operation is meaningful. */
  onRetry?: () => void;
}

const ICON_PROPS = {
  "aria-hidden": true as const,
  fill: "none",
  height: 16,
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  strokeWidth: 1.8,
  viewBox: "0 0 24 24",
  width: 16,
};

const CheckGlyph = () => (
  <svg {...ICON_PROPS}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12 2.4 2.4 4.6-4.8" />
  </svg>
);

const AlertGlyph = () => (
  <svg {...ICON_PROPS}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.2M12 16.4v.2" />
  </svg>
);

const Spinner = () => (
  <svg {...ICON_PROPS} className="skill-toast-spinner">
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);

function icon(kind: SkillToastItem["kind"]) {
  if (kind === "success") return <CheckGlyph />;
  if (kind === "error") return <AlertGlyph />;
  return <Spinner />;
}

/**
 * The 技能 page's own notices, as the handoff draws them: one column at the
 * top-right of the window, a 320px row per notice.
 *
 * They are drawn above the settings surface and outside its scroll area, so a
 * long list cannot carry a result away, and they carry their own close control
 * because a failed import is worth reading at the reader's pace, not for a
 * fixed number of seconds.
 */
export function SkillToasts({ items }: { items: readonly SkillToastItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="skill-toasts">
      {items.map((item) => (
        <div
          className={`skill-toast is-${item.kind}`}
          key={item.id}
          role={item.kind === "error" ? "alert" : "status"}
        >
          <span className="skill-toast-icon">{icon(item.kind)}</span>
          <span className="skill-toast-copy">
            <strong>{item.message}</strong>
            {item.detail ? <small>{item.detail}</small> : null}
          </span>
          {item.onRetry ? (
            <button className="skill-toast-retry" onClick={item.onRetry} type="button">
              {TEXT.settings.skills.toastRetry}
            </button>
          ) : null}
          <button
            aria-label={TEXT.settings.skills.toastClose}
            className="skill-toast-close"
            onClick={item.onClose}
            type="button"
          >
            <svg
              aria-hidden="true"
              fill="none"
              height="12"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
              width="12"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

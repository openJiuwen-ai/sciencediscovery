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

import type { PermissionDecision, PermissionRequest } from "../api/types.js";
import { TEXT } from "../text.js";

/** The three answers, in the order the server ranks them: least to most.
 *
 * The label is read when a card renders, not when this module loads. `TEXT` is
 * a proxy over the language store, so a string captured here at import time
 * would stay in the language the app started in — the buttons would keep
 * saying 仅允许一次 after the interface had been switched to English. */
const DECISIONS: Array<{ decision: PermissionDecision; label: () => string; tone: "danger" | "secondary" }> = [
  { decision: "allow_once", label: () => TEXT.permission.allowOnce, tone: "secondary" },
  { decision: "allow_matching", label: () => TEXT.permission.allowMatching, tone: "secondary" },
  { decision: "deny", label: () => TEXT.permission.deny, tone: "danger" },
];

/**
 * A decision the run is waiting on.
 *
 * Rendered only while the request is pending: once it has an answer the card is
 * gone, because the tool card below it already says what happened and a settled
 * authorization is not something to keep re-reading. A request that is still
 * pending when the run has ended keeps its card — the question was asked, and
 * dropping it silently would leave the transcript claiming a decision that
 * never came — but its buttons are disabled, since nothing is left to unblock.
 */
export function PermissionCard({
  busy,
  interactive,
  onDecision,
  request,
}: {
  /** A decision for this request, or for a sibling an `allow_matching` answer
   *  would cover, is already in flight. */
  busy: boolean;
  interactive: boolean;
  onDecision: (request: PermissionRequest, decision: PermissionDecision) => void;
  request: PermissionRequest;
}) {
  if (request.state !== "pending") return null;
  return (
    <article className="permission-card">
      <div className="permission-body">
        <span className="permission-eyebrow">{TEXT.permission.required}</span>
        <h4>{request.summary}</h4>
        <code>{request.resource}</code>
        <details className="permission-details">
          <summary>{TEXT.permission.details}</summary>
          <dl>
            <dt>{TEXT.permission.action}</dt>
            <dd>
              <code>{request.action}</code>
            </dd>
            <dt>{TEXT.permission.resource}</dt>
            <dd>
              <code>{request.resource}</code>
            </dd>
            <dt>{TEXT.permission.requested}</dt>
            <dd>{new Date(request.createdAt).toLocaleString()}</dd>
            {request.toolCallId === undefined ? null : (
              <>
                <dt>{TEXT.permission.toolCall}</dt>
                <dd>
                  <code>{request.toolCallId}</code>
                </dd>
              </>
            )}
          </dl>
        </details>
      </div>
      <div className="permission-actions">
        {DECISIONS.map((entry) => (
          <button
            className={`${entry.tone}-button`}
            disabled={busy || !interactive}
            key={entry.decision}
            onClick={() => onDecision(request, entry.decision)}
            type="button"
          >
            {entry.label()}
          </button>
        ))}
      </div>
    </article>
  );
}

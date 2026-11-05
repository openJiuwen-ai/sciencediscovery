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

import { formatErrorDiagnostic } from "@sciencediscovery/operational-logging/diagnostics";

import { openFeedback } from "../feedback/open.js";
import { TEXT } from "../text.js";

interface Props {
  onRetry: () => void;
  /** `auth` when the health probe reached the server but the app has no token
   *  it can use, so the two very different causes are not merged into one. */
  reason: "auth" | "unreachable";
}

/** Hand the failure to the feedback dialog with the diagnostic block already
 *  filled in, so the report carries what the shell could see. */
function reportProblem(reason: Props["reason"]): void {
  const detail = [
    `boot: offline (${reason})`,
    "app: desktop",
    `origin: ${window.location.origin}`,
    `user agent: ${navigator.userAgent}`,
  ].join("\n");
  openFeedback({
    kind: "bug",
    title: TEXT.boot.offlineTitle,
    body: `${TEXT.boot.offlineTitle}\n\n${TEXT.boot.offlineBody}`,
    diagnostics: formatErrorDiagnostic({
      title: TEXT.boot.offlineTitle,
      detail,
      version: "desktop",
      os: navigator.platform || navigator.userAgent,
      locale: TEXT.languageTag,
    }),
  });
}

/**
 * What the app shows when it cannot talk to the backend at all.
 *
 * There is no offline mode: every screen is a view of server state, so a
 * disconnected shell would be a shell showing stale answers. This says why and
 * offers the one thing worth doing.
 */
export function OfflineScreen({ onRetry, reason }: Props) {
  return (
    <div className="boot-page">
      <div className="boot-card is-offline">
        <div className="boot-mark" aria-hidden="true">
          ⚠
        </div>
        <h1 className="boot-title">{TEXT.boot.offlineTitle}</h1>
        <p className="boot-body">{TEXT.boot.offlineBody}</p>
        {reason === "auth" ? <p className="boot-hint">{TEXT.boot.noTokenBody}</p> : null}
        <div className="boot-actions">
          <button className="primary-button" onClick={onRetry} type="button">
            {TEXT.boot.retry}
          </button>
          <button className="secondary-button" onClick={() => reportProblem(reason)} type="button">
            {TEXT.feedback.entry}
          </button>
        </div>
      </div>
    </div>
  );
}

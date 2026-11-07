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

import type { ChatMessage } from "../api/types.js";
import { formatRunFailure, formatRunFailureTitle } from "../run-failure.js";
import { TEXT } from "../text.js";

/** One failure, with recovery guidance first and the complete evidence on demand. */
export function RunFailureCard({ code, message, timeout, scope = "run" }: { code?: string; message: string; timeout?: ChatMessage["timeout"]; scope?: "run" | "notice" }) {
  return (
    <div className="message assistant run-failure-row">
      <section className="run-failure" role="status">
        <div className="run-failure-heading">
          <svg aria-hidden="true" className="run-failure-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5m0 4h.01" />
          </svg>
          <h3>{formatRunFailureTitle(code, message, timeout, scope)}</h3>
        </div>
        <p className="run-failure-summary">{formatRunFailure(code, message, timeout, scope)}</p>
        <details className="run-failure-details">
          <summary>{TEXT.runFailure.technicalDetails}</summary>
          <div className="run-failure-diagnostics">
            {code !== undefined && <p className="run-failure-code"><code>{code}</code></p>}
            <pre>{message}</pre>
          </div>
        </details>
      </section>
    </div>
  );
}

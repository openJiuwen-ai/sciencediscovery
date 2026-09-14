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

import type { RuntimeNotice } from "@sciencediscovery/schema";
import { useLocale } from "./i18n/index.js";
import { InfoIcon } from "./icons.js";

/** A turn the runtime started for itself after background work finished. It is
 * shown as a system record, never as something the researcher typed; the raw
 * model-facing text stays collapsed because it is diagnostic, not a message. */
export function WakeNotice({ notice }: { notice: RuntimeNotice }) {
  const { t } = useLocale();
  const summary = notice.executions && notice.timers
    ? t("chat.wakeNoticeBoth", { executions: notice.executions, timers: notice.timers })
    : notice.timers
      ? t("chat.wakeNoticeTimers", { count: notice.timers })
      : t("chat.wakeNoticeExecutions", { count: notice.executions });
  return (
    // Deliberately not `.message.assistant`: this is a system record, so it must
    // not join the conversation's assistant turns for styling or selection.
    <article aria-label={t("app.roleRuntimeNotice")} className="message wake-notice">
      <div className="avatar"><InfoIcon size={16} /></div>
      <div>
        <span className="message-role">{t("app.roleRuntimeNotice")}</span>
        <details className="wake-notice-records">
          <summary>{summary}</summary>
          <pre>{notice.prompt}</pre>
        </details>
      </div>
    </article>
  );
}

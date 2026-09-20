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

import type { RuntimeNotice, RuntimeNoticeRecord } from "@sciencediscovery/schema";
import { useLocale, type MessageKey } from "./i18n/index.js";
import { InfoIcon } from "./icons.js";

/** Where a notice record lives in the activity panel. */
export interface ActivityRecordTarget {
  id: string;
  kind: "executions" | "timers";
}

const STATE_KEYS: Record<NonNullable<RuntimeNoticeRecord["state"]>, MessageKey> = {
  cancelled: "chat.wakeNoticeState.cancelled",
  completed: "chat.wakeNoticeState.completed",
  failed: "chat.wakeNoticeState.failed",
  queued: "chat.wakeNoticeState.running",
  running: "chat.wakeNoticeState.running",
  unknown: "chat.wakeNoticeState.unknown",
};

/** A turn the runtime started for itself after background work finished. It is
 * shown as a system record, never as something the researcher typed. The body
 * is what finished and how, each entry opening the matching activity record;
 * the model-facing prompt is diagnostic data and stays out of the transcript. */
export function WakeNotice({ agentLabel, notice, onOpenRecord }: {
  /** Human name for an owner id; the main Agent and a SubAgent's description, never a raw id. */
  agentLabel?: (agentId: string) => string;
  notice: RuntimeNotice;
  onOpenRecord?: (target: ActivityRecordTarget) => void;
}) {
  const { t } = useLocale();
  const ownerLabel = (agentId: string) => agentId === "main" ? t("chat.wakeNoticeMainAgent") : agentLabel?.(agentId) ?? agentId;
  const summary = notice.executions && notice.timers
    ? t("chat.wakeNoticeBoth", { executions: notice.executions, timers: notice.timers })
    : notice.timers
      ? t("chat.wakeNoticeTimers", { count: notice.timers })
      : t("chat.wakeNoticeExecutions", { count: notice.executions });
  const records = notice.records ?? [];
  const executions = records.filter((record) => record.kind === "execution");
  const outcomes = [
    [executions.filter((record) => record.state === "completed").length, "chat.wakeNoticeCompleted"],
    [executions.filter((record) => record.state === "failed").length, "chat.wakeNoticeFailed"],
    [executions.filter((record) => record.state !== "completed" && record.state !== "failed").length, "chat.wakeNoticeUnconfirmed"],
  ] as const;
  const outcome = outcomes.filter(([count]) => count > 0).map(([count, key]) => t(key, { count })).join(" · ");
  return (
    // Deliberately not `.message.assistant`: this is a system record, so it must
    // not join the conversation's assistant turns for styling or selection.
    <article aria-label={t("app.roleRuntimeNotice")} className="message wake-notice">
      <div className="avatar"><InfoIcon size={16} /></div>
      <div>
        <span className="message-role">{t("app.roleRuntimeNotice")}</span>
        <p className="wake-notice-summary">{summary}{outcome ? <span className="wake-notice-outcome">{outcome}</span> : null}</p>
        {records.length ? <ul className="wake-notice-records">
          {records.map((record) => {
            const target: ActivityRecordTarget = { id: record.sourceId, kind: record.kind === "execution" ? "executions" : "timers" };
            const state = record.kind === "timer" ? "fired" : record.state ?? "unknown";
            return <li key={`${record.kind}:${record.sourceId}`}>
              <span className={`activity-badge ${state}`}>{t(record.kind === "timer" ? "chat.wakeNoticeState.fired" : STATE_KEYS[record.state ?? "unknown"])}</span>
              <span className="wake-notice-record-label">{record.kind === "timer"
                ? t("chat.wakeNoticeTimerLabel", { message: record.message ?? "" })
                : t("chat.wakeNoticeExecutionLabel", { agent: ownerLabel(record.agentId), runner: record.runnerId ?? "?" })}</span>
              {onOpenRecord ? <button className="wake-notice-open" type="button" onClick={() => onOpenRecord(target)}>
                {t(record.kind === "timer" ? "chat.wakeNoticeOpenTimer" : "chat.wakeNoticeOpenExecution")}
              </button> : null}
            </li>;
          })}
        </ul> : null}
      </div>
    </article>
  );
}

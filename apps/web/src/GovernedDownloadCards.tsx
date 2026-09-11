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

import { ProcessRecord } from "./ProcessRecord.js";
import { useState } from "react";

import type { ArtifactJob, ArtifactPlan } from "@sciencediscovery/schema";

import { translateActive, useLocale, type MessageKey } from "./i18n/index.js";
import { ChevronRightIcon } from "./icons.js";
import {
  activityCardId,
  type ActivityCardDisclosure,
  type GovernedDownloadCandidate,
} from "./session/run-activity.js";

const ACTIVE_STATES: ReadonlySet<ArtifactJob["state"]> = new Set([
  "queued",
  "retrying",
  "running",
  "verifying",
]);

function downloadSummary(jobs: ArtifactJob[], actionable: number): string {
  const active = jobs.filter((job) => ACTIVE_STATES.has(job.state)).length;
  const failed = jobs.filter((job) => job.state === "failed").length;
  const completed = jobs.filter((job) => job.state === "completed").length;
  return [
    active ? translateActive("downloads.summaryActive", { count: active }) : undefined,
    failed ? translateActive("downloads.summaryFailed", { count: failed }) : undefined,
    completed ? translateActive("downloads.summaryCompleted", { count: completed }) : undefined,
    actionable
      ? translateActive(actionable === 1 ? "downloads.summaryActionNeededOne" : "downloads.summaryActionNeeded", { count: actionable })
      : undefined,
  ].filter(Boolean).join(" · ") || translateActive("downloads.summaryRecorded");
}

const JOB_STATE_KEYS: Record<ArtifactJob["state"], MessageKey> = {
  cancelled: "downloads.stateCancelled",
  completed: "downloads.stateCompleted",
  failed: "downloads.stateFailed",
  queued: "downloads.stateQueued",
  retrying: "downloads.stateRetrying",
  running: "downloads.stateRunning",
  verifying: "downloads.stateVerifying",
};

export function GovernedDownloadCards({
  candidates,
  expandedCards,
  groupId,
  jobs,
  onAction,
  onPrepare,
  onToggleCard,
  plans,
}: ActivityCardDisclosure & {
  candidates: GovernedDownloadCandidate[];
  groupId: string;
  jobs: ArtifactJob[];
  onAction: (job: ArtifactJob, action: "cancel" | "retry") => Promise<void>;
  onPrepare: (item: GovernedDownloadCandidate) => Promise<void>;
  plans: ArtifactPlan[];
}) {
  const { t } = useLocale();
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const plannedCandidateIds = new Set(plans.flatMap((plan) => plan.candidates.map((candidate) => candidate.id)));
  const unplanned = candidates.filter((item) => !plannedCandidateIds.has(item.candidate.id));
  const awaitingApproval = plans.filter((plan) => plan.state === "awaiting_approval");
  if (!unplanned.length && !awaitingApproval.length && !jobs.length) return null;

  const cardId = activityCardId("governed-downloads", groupId);
  const actionable = unplanned.length + awaitingApproval.length + jobs.filter((job) => job.state === "failed").length;
  const pending = unplanned.length + awaitingApproval.length > 0 || jobs.some((job) => ACTIVE_STATES.has(job.state));
  const expanded = expandedCards[cardId] ?? (pending && actionable > 0);

  async function runAction(id: string, action: () => Promise<void>): Promise<void> {
    setBusyIds((current) => new Set([...current, id]));
    try {
      await action();
    } finally {
      setBusyIds((current) => new Set([...current].filter((item) => item !== id)));
    }
  }

  return <section aria-label={t("downloads.title")} className="governed-downloads-panel">
    <article className={`governed-downloads-card${pending ? "" : " process-record"}${jobs.some((job) => job.state === "failed") ? " failed" : ""}`}>
      <button aria-expanded={expanded} className="governed-downloads-heading" onClick={() => onToggleCard(cardId, !expanded)} type="button">
        <span className="card-chevron"><ChevronRightIcon size={15} /></span>
        <span><strong>{t("downloads.title")}{!pending ? ` · ${downloadSummary(jobs, actionable)}` : ""}</strong><small>{downloadSummary(jobs, actionable)}</small></span>
        <i>{unplanned.length + awaitingApproval.length + jobs.length}</i>
      </button>
      {expanded ? <div className="governed-downloads-body">
        {unplanned.map((item) => <article className="governed-download-item candidate" key={`${item.invocationId}:${item.candidate.id}`}>
          <span><strong>{item.candidate.logicalName}</strong><small>{item.candidate.sourceId} · {item.candidate.format}{item.candidate.expectedBytes ? ` · ${t("downloads.bytes", { count: item.candidate.expectedBytes.toLocaleString() })}` : ""}</small></span>
          <button className="secondary-button" disabled={busyIds.has(item.candidate.id)} onClick={() => void runAction(item.candidate.id, () => onPrepare(item))} type="button">{busyIds.has(item.candidate.id) ? t("downloads.preparing") : t("downloads.prepare")}</button>
        </article>)}
        {awaitingApproval.map((plan) => <article className="governed-download-item awaiting-approval" key={plan.id}>
          <span><strong>{plan.candidates.find((item) => item.id === plan.selectedCandidateId)?.logicalName ?? plan.sourceRecordId}</strong><small>{plan.sourceId} → {plan.destination.path}</small></span>
          <em>{t("downloads.waitingApproval")}</em>
        </article>)}
        {jobs.toReversed().map((job) => <ProcessRecord active={ACTIVE_STATES.has(job.state)} failed={job.state === "failed"} key={job.id} label={`${job.sourceId} · ${job.sourceRecordId} · ${t(JOB_STATE_KEYS[job.state])}`}><article className={`governed-download-item ${job.state}`}>
          <span><strong>{job.sourceId} · {job.sourceRecordId}</strong><small>{JOB_STATE_KEYS[job.state] ? t(JOB_STATE_KEYS[job.state]) : job.state.replaceAll("_", " ")} · {job.progress.percent ?? 0}% · {t("downloads.bytes", { count: job.progress.bytesDownloaded.toLocaleString() })}</small>{job.finalPath ? <small>{job.finalPath}</small> : null}{job.error ? <small className="governed-download-error" role="alert">{job.error.message}</small> : null}</span>
          {ACTIVE_STATES.has(job.state) ? <button className="secondary-button" disabled={busyIds.has(job.id)} onClick={() => void runAction(job.id, () => onAction(job, "cancel"))} type="button">{t("common.cancel")}</button> : null}
          {job.state === "failed" ? <button className="secondary-button" disabled={busyIds.has(job.id)} onClick={() => void runAction(job.id, () => onAction(job, "retry"))} type="button">{busyIds.has(job.id) ? t("downloads.retrying") : t("downloads.retry")}</button> : null}
        </article></ProcessRecord>)}
      </div> : null}
    </article>
  </section>;
}

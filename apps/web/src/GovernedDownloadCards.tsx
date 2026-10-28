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

import type { ArtifactJob, ArtifactPlan, PermissionDecision, PermissionRequest } from "@sciencediscovery/schema";

import { translateActive, useLocale, type MessageKey } from "./i18n/index.js";
import { ChevronRightIcon } from "./icons.js";
import { PermissionDecisionActions } from "./PermissionDecisionActions.js";
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

/**
 * A plan stays `awaiting_approval` after its permission was decided, so the
 * card must follow the linked permission: a decided download is reported as
 * decided instead of waiting forever for an approval that already happened.
 */
function approvalState(request: PermissionRequest | undefined): "granted" | "pending" | "denied" {
  if (!request) return "pending";
  if (request.state === "allowed") return "granted";
  if (request.state === "pending") return "pending";
  return "denied";
}

export function GovernedDownloadCards({
  candidates,
  expandedCards,
  groupId,
  jobs,
  onAction,
  onDecision,
  onPrepare,
  onToggleCard,
  permissionRequests,
  plans,
}: ActivityCardDisclosure & {
  candidates: GovernedDownloadCandidate[];
  groupId: string;
  jobs: ArtifactJob[];
  onAction: (job: ArtifactJob, action: "cancel" | "retry") => Promise<void>;
  onDecision: (request: PermissionRequest, decision: PermissionDecision) => Promise<void>;
  onPrepare: (item: GovernedDownloadCandidate) => Promise<void>;
  permissionRequests: PermissionRequest[];
  plans: ArtifactPlan[];
}) {
  const { t } = useLocale();
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const plannedCandidateIds = new Set(plans.flatMap((plan) => plan.candidates.map((candidate) => candidate.id)));
  const unplanned = candidates.filter((item) => !plannedCandidateIds.has(item.candidate.id));
  const awaitingApproval = plans.filter((plan) => plan.state === "awaiting_approval");
  // Session-wide, not group-wide: a permission raised by a manual click is
  // attributed by time while its plan is attributed by its MCP invocation, so
  // the two can land in different activity groups. The card still has to offer
  // the decision for the download it is showing.
  const approvalByRequestId = new Map(permissionRequests
    .filter((request) => request.action === "artifact_download")
    .map((request) => [request.id, request]));
  // A decided approval is history, not something still waiting on the user.
  const pendingApprovals = awaitingApproval.filter((plan) => approvalState(approvalByRequestId.get(plan.permissionRequestId)) === "pending");
  if (!unplanned.length && !awaitingApproval.length && !jobs.length) return null;

  const cardId = activityCardId("governed-downloads", groupId);
  const actionable = unplanned.length + pendingApprovals.length + jobs.filter((job) => job.state === "failed").length;
  const pending = unplanned.length + pendingApprovals.length > 0 || jobs.some((job) => ACTIVE_STATES.has(job.state));
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
        {awaitingApproval.map((plan) => {
          const request = approvalByRequestId.get(plan.permissionRequestId);
          const state = approvalState(request);
          const name = plan.candidates.find((item) => item.id === plan.selectedCandidateId)?.logicalName ?? plan.sourceRecordId;
          return <article className={`governed-download-item ${state === "pending" ? "awaiting-approval" : `approval-${state}`}`} key={plan.id}>
            <span><strong>{name}</strong><small>{plan.sourceId} → {plan.destination.path}</small>
              <small className="governed-download-approval">{state === "pending"
                ? t("downloads.approvalRequired", { name, path: plan.destination.path })
                : t(state === "granted" ? "downloads.approvalGranted" : "downloads.approvalDenied")}</small>
            </span>
            {state === "pending" && request
              ? <PermissionDecisionActions action={request.action} resource={request.resource} busy={busyIds.has(plan.id)} onDecision={(decision) => void runAction(plan.id, () => onDecision(request, decision))} />
              : state === "pending" ? <em>{t("downloads.approvalLoading")}</em> : null}
          </article>;
        })}
        {jobs.toReversed().map((job) => <ProcessRecord active={ACTIVE_STATES.has(job.state)} failed={job.state === "failed"} key={job.id} label={`${job.sourceId} · ${job.sourceRecordId} · ${t(JOB_STATE_KEYS[job.state])}`}><article className={`governed-download-item ${job.state}`}>
          <span><strong>{job.sourceId} · {job.sourceRecordId}</strong><small>{JOB_STATE_KEYS[job.state] ? t(JOB_STATE_KEYS[job.state]) : job.state.replaceAll("_", " ")} · {job.progress.percent ?? 0}% · {t("downloads.bytes", { count: job.progress.bytesDownloaded.toLocaleString() })}</small>{job.finalPath ? <small>{job.finalPath}</small> : null}{job.error ? <small className="governed-download-error" role="alert">{job.error.message}</small> : null}</span>
          {ACTIVE_STATES.has(job.state) ? <button className="secondary-button" disabled={busyIds.has(job.id)} onClick={() => void runAction(job.id, () => onAction(job, "cancel"))} type="button">{t("common.cancel")}</button> : null}
          {job.state === "failed" ? <button className="secondary-button" disabled={busyIds.has(job.id)} onClick={() => void runAction(job.id, () => onAction(job, "retry"))} type="button">{busyIds.has(job.id) ? t("downloads.retrying") : t("downloads.retry")}</button> : null}
        </article></ProcessRecord>)}
      </div> : null}
    </article>
  </section>;
}

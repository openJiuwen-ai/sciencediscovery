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

import { useState } from "react";

import type { ArtifactJob, ArtifactPlan } from "@science-agent/schema";

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
    active ? `${active} active` : undefined,
    failed ? `${failed} failed` : undefined,
    completed ? `${completed} completed` : undefined,
    actionable ? `${actionable} action${actionable === 1 ? "" : "s"} needed` : undefined,
  ].filter(Boolean).join(" · ") || "Recorded";
}

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
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const plannedCandidateIds = new Set(plans.flatMap((plan) => plan.candidates.map((candidate) => candidate.id)));
  const unplanned = candidates.filter((item) => !plannedCandidateIds.has(item.candidate.id));
  const awaitingApproval = plans.filter((plan) => plan.state === "awaiting_approval");
  if (!unplanned.length && !awaitingApproval.length && !jobs.length) return null;

  const cardId = activityCardId("governed-downloads", groupId);
  const actionable = unplanned.length + awaitingApproval.length + jobs.filter((job) => job.state === "failed").length;
  const expanded = expandedCards[cardId] ?? actionable > 0;

  async function runAction(id: string, action: () => Promise<void>): Promise<void> {
    setBusyIds((current) => new Set([...current, id]));
    try {
      await action();
    } finally {
      setBusyIds((current) => new Set([...current].filter((item) => item !== id)));
    }
  }

  return <section aria-label="Governed downloads" className="governed-downloads-panel">
    <article className="governed-downloads-card">
      <button aria-expanded={expanded} className="governed-downloads-heading" onClick={() => onToggleCard(cardId, !expanded)} type="button">
        <span className="card-chevron"><ChevronRightIcon size={15} /></span>
        <span><strong>Governed downloads</strong><small>{downloadSummary(jobs, actionable)}</small></span>
        <i>{unplanned.length + awaitingApproval.length + jobs.length}</i>
      </button>
      {expanded ? <div className="governed-downloads-body">
        {unplanned.map((item) => <article className="governed-download-item candidate" key={`${item.invocationId}:${item.candidate.id}`}>
          <span><strong>{item.candidate.logicalName}</strong><small>{item.candidate.sourceId} · {item.candidate.format}{item.candidate.expectedBytes ? ` · ${item.candidate.expectedBytes.toLocaleString()} bytes` : ""}</small></span>
          <button className="secondary-button" disabled={busyIds.has(item.candidate.id)} onClick={() => void runAction(item.candidate.id, () => onPrepare(item))} type="button">{busyIds.has(item.candidate.id) ? "Preparing…" : "Prepare download"}</button>
        </article>)}
        {awaitingApproval.map((plan) => <article className="governed-download-item awaiting-approval" key={plan.id}>
          <span><strong>{plan.candidates.find((item) => item.id === plan.selectedCandidateId)?.logicalName ?? plan.sourceRecordId}</strong><small>{plan.sourceId} → {plan.destination.path}</small></span>
          <em>Waiting for approval</em>
        </article>)}
        {jobs.toReversed().map((job) => <article className={`governed-download-item ${job.state}`} key={job.id}>
          <span><strong>{job.sourceId} · {job.sourceRecordId}</strong><small>{job.state.replaceAll("_", " ")} · {job.progress.percent ?? 0}% · {job.progress.bytesDownloaded.toLocaleString()} bytes</small>{job.finalPath ? <small>{job.finalPath}</small> : null}{job.error ? <small className="governed-download-error" role="alert">{job.error.message}</small> : null}</span>
          {ACTIVE_STATES.has(job.state) ? <button className="secondary-button" disabled={busyIds.has(job.id)} onClick={() => void runAction(job.id, () => onAction(job, "cancel"))} type="button">Cancel</button> : null}
          {job.state === "failed" ? <button className="secondary-button" disabled={busyIds.has(job.id)} onClick={() => void runAction(job.id, () => onAction(job, "retry"))} type="button">{busyIds.has(job.id) ? "Retrying…" : "Retry"}</button> : null}
        </article>)}
      </div> : null}
    </article>
  </section>;
}

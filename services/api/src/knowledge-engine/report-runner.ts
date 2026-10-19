// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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

/**
 * V2-Z1 community report generation. One job PER COMMUNITY (the runner is
 * deliberately serial — a batched all-communities job would monopolize the
 * queue and starve extract/grow for minutes). Jobs carry the graph
 * fingerprint of the partition they were enqueued against; if the graph
 * moved meanwhile, the report is still written (tagged with its fingerprint,
 * served as history until superseded) — community ids are only promises
 * within one fingerprint.
 */

import {
  buildCommunityReportPrompt,
  COMMUNITY_REPORT_SYSTEM_PROMPT,
  normalizeCommunityReport,
  type CommunityReportContext,
} from "@sciencediscovery/knowledge-engine";
import type { ModelEndpoint } from "@sciencediscovery/model";

import { callPipelineLlmJson, type PipelineInvoke } from "./llm.js";
import type { KeJobRow, KnowledgeEngineStore } from "./store.js";

export const KE_COMMUNITY_REPORT_JOB = "ke_community_report";

export interface ReportRunDeps {
  readonly store: KnowledgeEngineStore;
  /** Pipeline model endpoint (the report author). */
  readonly resolveEndpoint?: () => ModelEndpoint | undefined;
  /** Test seam: replace the model transport. */
  readonly llmInvoke?: PipelineInvoke;
  readonly onWarn?: (message: string, detail?: unknown) => void;
}

/** Communities smaller than this get a deterministic stub report (an LLM
 *  call cannot say anything a member list doesn't already say). */
export const REPORT_MIN_MEMBERS_FOR_LLM = 3;

export class ReportNonRetryableError extends Error {
  readonly nonRetryable = true as const;
}

/**
 * Enqueue one job per community of the given roots partition. Communities
 * that already have a ready (or error) report at this fingerprint are
 * skipped; ready reports are never regenerated for the same fingerprint.
 */
export function enqueueCommunityReports(
  store: KnowledgeEngineStore,
  input: {
    kbId: string;
    fingerprint: string;
    communities: ReadonlyArray<{ id: number; size: number; name?: string | null }>;
  },
): { fingerprint: string; enqueued: number; skipped: number; jobIds: string[] } {
  const jobIds: string[] = [];
  let enqueued = 0;
  let skipped = 0;
  for (const community of input.communities) {
    const existing = store.getCommunityReport(input.kbId, input.fingerprint, community.id);
    if (existing) {
      skipped++;
      continue;
    }
    const { job, enqueued: did } = store.enqueueJob({
      type: KE_COMMUNITY_REPORT_JOB,
      payload: {
        kbId: input.kbId,
        fingerprint: input.fingerprint,
        communityId: community.id,
        ...(community.name ? { communityName: community.name } : {}),
      },
      dedupKey: `report|${input.kbId}|${input.fingerprint}|${community.id}`,
      maxAttempts: 2,
    });
    jobIds.push(job.id);
    if (did) enqueued++;
    else skipped++;
  }
  return { fingerprint: input.fingerprint, enqueued, skipped, jobIds };
}

/** One community's report: gather context from the store, author via the
 *  pipeline LLM, normalize, persist. Small communities get a stub. */
export async function runCommunityReport(
  deps: ReportRunDeps,
  job: KeJobRow,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const { store } = deps;
  const kbId = String(job.payload["kbId"] ?? "");
  const fingerprint = String(job.payload["fingerprint"] ?? "");
  const communityId = Number(job.payload["communityId"] ?? -1);
  if (!kbId || !fingerprint || !Number.isInteger(communityId) || communityId < 0) {
    throw new ReportNonRetryableError("community report job payload is missing kbId/fingerprint/communityId");
  }

  const members = store.listEntitiesByCommunity(kbId, communityId);
  if (members.length === 0) {
    // The partition moved under us (or the KB was purged) — nothing to
    // report on; do not burn retries.
    throw new ReportNonRetryableError(`community ${communityId} has no members (partition moved?)`);
  }

  const context: CommunityReportContext = {
    kbId,
    fingerprint,
    communityId,
    communityName: typeof job.payload["communityName"] === "string" ? job.payload["communityName"] : null,
    memberCount: members.length,
    members: members.map((m) => ({
      name: m.name,
      type: m.type,
      support: m.supportCount,
      definition: m.description,
    })),
    relations: store
      .listEdgesWithinCommunity(kbId, communityId)
      .map((e) => ({
        source: store.getEntity(e.srcId)?.name ?? e.srcId,
        target: store.getEntity(e.dstId)?.name ?? e.dstId,
        type: e.type,
        support: e.supportCount,
        evidence: e.evidenceQuote,
      })),
  };

  // Small communities: deterministic stub, no LLM spend.
  if (members.length < REPORT_MIN_MEMBERS_FOR_LLM) {
    const row = store.upsertCommunityReport({
      kbId,
      fingerprint,
      communityId,
      title: members[0]!.name,
      summary: `Small community (${members.length} member${members.length === 1 ? "" : "s"}): ${members
        .map((m) => m.name)
        .join(", ")}. Below the report threshold — see the member list.`,
      rating: null,
      ratingExplanation: null,
      findings: JSON.stringify([]),
      status: "ready",
      error: null,
      model: null,
    });
    return { kbId, communityId, fingerprint, stub: true, id: row.id };
  }

  const endpoint = deps.resolveEndpoint?.();
  if (!endpoint) {
    throw new Error("no pipeline model configured (community reports are LLM-authored)");
  }

  const raw = await callPipelineLlmJson<unknown>(
    { endpoint, ...(deps.llmInvoke ? { invoke: deps.llmInvoke } : {}) },
    COMMUNITY_REPORT_SYSTEM_PROMPT,
    buildCommunityReportPrompt(context),
    signal ?? new AbortController().signal,
  );
  const draft = normalizeCommunityReport(raw, context);
  if (!draft) {
    throw new Error(`pipeline LLM returned no usable community report for community ${communityId}`);
  }
  const row = store.upsertCommunityReport({
    kbId,
    fingerprint,
    communityId,
    title: draft.title,
    summary: draft.summary,
    rating: draft.rating,
    ratingExplanation: draft.ratingExplanation || null,
    findings: JSON.stringify(draft.findings),
    status: "ready",
    error: null,
    model: endpoint.model,
  });
  return { kbId, communityId, fingerprint, title: row.title, findings: draft.findings.length };
}

// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { apiBaseUrl, authorizationHeader } from "../e2e-auth.js";
import { drbApi } from "./deepresearchbench.ts";
import { mainRunChain } from "./run-chain.ts";
import { deliveryStatus, finalAnswer, selectFinalOutputs } from "./real-delivery.mjs";

export interface DeliveredArtifact { id: string; logicalName: string; version: string; text: string; bytes: number;
  producerAnswer?: string; producerRunOrder?: number }
export async function collectFinalDelivery(page: Page, sessionId: string, runId: string, rootRunId = runId) {
  const prefix = `/api/sessions/${encodeURIComponent(sessionId)}`;
  const [runs, session, outputs, subagents] = await Promise.all([
    drbApi<any[]>(page, `${prefix}/runs`), drbApi<any>(page, prefix),
    drbApi<any[]>(page, `${prefix}/artifact-outputs`), drbApi<any[]>(page, `${prefix}/subagents`),
  ]);
  const run = runs.find(r => r.id === runId);
  if (!run) throw new Error("Final delivery run not found");
  // Keep the final chat reply for diagnostics. Declared Artifact versions determine delivery.
  const answer = finalAnswer(run, session.messages ?? []);
  const chain = mainRunChain(runs, rootRunId);
  if (!chain.some(({ id }) => id === runId)) throw new Error("Final delivery run is outside the main Run chain");
  const selected = selectFinalOutputs(outputs, chain.map(({ id }) => id), subagents);
  const producerRun = chain.find(({ id }) => id === selected.producerRunId);
  const producerAnswer = producerRun ? finalAnswer(producerRun, session.messages ?? []) : "";
  const artifacts: DeliveredArtifact[] = [];
  const errors: string[] = [...selected.errors];
  for (const { artifact, version } of selected.selected) {
    try {
      const content = await page.request.get(`${apiBaseUrl()}${prefix}/artifact-versions/${encodeURIComponent(version.id)}/content`, { headers: authorizationHeader() });
      if (!content.ok()) throw new Error(`Content HTTP ${content.status()}`);
      const bytes = await content.body();
      const logicalName = artifact.name ?? artifact.logicalName;
      if (!bytes.length || (/\.(md|txt|json|csv|py)$/i.test(logicalName) && !bytes.toString("utf8").trim())) throw new Error("Empty final artifact");
      const artifactProducer = chain.find(({ id }) => id === selected.producerRunIds[version.id]);
      artifacts.push({ id: artifact.id, logicalName, version: version.id, text: bytes.toString("utf8"),
        bytes: bytes.length, producerAnswer: artifactProducer ? finalAnswer(artifactProducer, session.messages ?? []) : "",
        producerRunOrder: chain.findIndex(({ id }) => id === artifactProducer?.id) });
    } catch (error) { errors.push(`${artifact.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  // A broken supplementary file remains diagnostic; required output checks decide whether it blocks the E2E.
  const status = deliveryStatus(run.status, artifacts);
  return { status, run_status: run.status, answer, producer_answer: producerAnswer, artifacts, errors };
}

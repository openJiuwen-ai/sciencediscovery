// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import type { Page } from "@playwright/test";
import { apiBaseUrl, authorizationHeader } from "../e2e-auth.js";
import { drbApi } from "./deepresearchbench.ts";
import { deliveryStatus, finalReferences } from "./real-delivery.mjs";

export interface DeliveredArtifact { id: string; logicalName: string; version: string; text: string; bytes: number }
export async function collectFinalDelivery(page: Page, sessionId: string, runId: string) {
  const prefix = `/api/sessions/${encodeURIComponent(sessionId)}`;
  const [runs, session, catalog] = await Promise.all([
    drbApi<any[]>(page, `${prefix}/runs`), drbApi<any>(page, prefix), drbApi<any[]>(page, `${prefix}/artifacts`),
  ]);
  const run = runs.find(r => r.id === runId);
  if (!run) throw new Error("Final delivery run not found");
  const withVersions = await Promise.all(catalog.map(async a => ({ ...a,
    versions: await drbApi<any[]>(page, `${prefix}/artifacts/${encodeURIComponent(a.id)}/versions`).catch(() => []),
  })));
  const { answer, selected } = finalReferences(run, session.messages ?? [], withVersions);
  const artifacts: DeliveredArtifact[] = [];
  const errors: string[] = [];
  for (const a of selected) {
    try {
      const versions: Array<{ id: string; version: number }> = a.versions;
      const explicitlyReferenced = versions.filter(v => answer.includes(v.id));
      const version = explicitlyReferenced.length === 1 ? explicitlyReferenced[0]
        : explicitlyReferenced.length > 1 ? undefined : versions.sort((x, y) => y.version - x.version)[0];
      if (!version) throw new Error("No unambiguous persisted version");
      const content = await page.request.get(`${apiBaseUrl()}${prefix}/artifact-versions/${encodeURIComponent(version.id)}/content`, { headers: authorizationHeader() });
      if (!content.ok()) throw new Error(`Content HTTP ${content.status()}`);
      const bytes = await content.body();
      if (!bytes.length || (/\.(md|txt|json|csv|py)$/i.test(a.logicalName) && !bytes.toString("utf8").trim())) throw new Error("Empty final artifact");
      artifacts.push({ id: a.id, logicalName: a.logicalName, version: version.id, text: bytes.toString("utf8"), bytes: bytes.length });
    } catch (error) { errors.push(`${a.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { status: deliveryStatus(run.status, artifacts), run_status: run.status, answer, artifacts, errors };
}

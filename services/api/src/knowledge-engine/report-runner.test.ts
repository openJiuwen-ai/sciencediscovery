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

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { KnowledgeEngineStore } from "./store.js";
import {
  enqueueCommunityReports,
  runCommunityReport,
  KE_COMMUNITY_REPORT_JOB,
  ReportNonRetryableError,
} from "./report-runner.js";
import type { PipelineInvoke } from "./llm.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

const STUB_ENDPOINT = () =>
  ({ baseUrl: "http://stub.local/v1", model: "stub-reporter", apiToken: "stub-token" }) as never;

function fakeJob(payload: Record<string, unknown>) {
  return {
    id: "job-1",
    type: KE_COMMUNITY_REPORT_JOB,
    payload,
    status: "running",
    attempts: 1,
    maxAttempts: 2,
    runAfter: new Date().toISOString(),
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Seed a KB with one 4-member community (id 0) and one 2-member community (id 1). */
function seedGraph(store: KnowledgeEngineStore): string {
  const kb = store.createKnowledgeBase({ name: "Report KB", description: "test" });
  const a = store.upsertEntity({ kbId: kb.id, name: "mAb114", type: "antibody" });
  const b = store.upsertEntity({ kbId: kb.id, name: "Ebola virus glycoprotein", type: "protein" });
  const c = store.upsertEntity({ kbId: kb.id, name: "REGN3471", type: "antibody" });
  const d = store.upsertEntity({ kbId: kb.id, name: "GP1,2", type: "protein" });
  const e = store.upsertEntity({ kbId: kb.id, name: "Lone Entity A", type: "gene" });
  const f = store.upsertEntity({ kbId: kb.id, name: "Lone Entity B", type: "gene" });
  store.setCommunityIds(kb.id, new Map([[a.id, 0], [b.id, 0], [c.id, 0], [d.id, 0], [e.id, 1], [f.id, 1]]));
  store.upsertEdge({
    kbId: kb.id,
    srcId: a.id,
    dstId: b.id,
    type: "neutralizes",
    evidenceQuote: "localized on the virus spike glycoprotein leading to neutralization",
  });
  store.upsertEdge({ kbId: kb.id, srcId: c.id, dstId: d.id, type: "binds", evidenceQuote: null });
  // Cross-community edge must NOT enter community 0's prompt input.
  store.upsertEdge({ kbId: kb.id, srcId: a.id, dstId: e.id, type: "mentions", evidenceQuote: null });
  return kb.id;
}

const CANNED_REPORT = JSON.stringify({
  title: "Antibody response to the Ebola glycoprotein",
  summary: "Antibodies targeting the Ebola virus glycoprotein and its GP1,2 precursor dominate this community.",
  rating: 8,
  rating_explanation: "Highest-support protein hub with two neutralizing antibody binders.",
  findings: [
    {
      summary: "mAb114 neutralizes GP",
      explanation: "Evidence links the antibody to the spike glycoprotein.",
      evidence: "localized on the virus spike glycoprotein leading to neutralization",
    },
  ],
});

test("runCommunityReport authors, grounds and persists one community report", async (context) => {
  const root = tempRoot("ke-report-run");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kbId = seedGraph(store);

  const invokes: string[] = [];
  const invoke: PipelineInvoke = async (_endpoint, _system, user, _signal) => {
    invokes.push(user);
    return CANNED_REPORT;
  };

  const result = (await runCommunityReport(
    { store, resolveEndpoint: STUB_ENDPOINT, llmInvoke: invoke },
    fakeJob({ kbId, fingerprint: "f1", communityId: 0, communityName: "Antibody response" }),
  )) as Record<string, unknown>;

  assert.equal(result.title, "Antibody response to the Ebola glycoprotein");
  assert.equal(invokes.length, 1);
  // Prompt grounding: members of community 0 in, the cross-community edge out.
  assert.match(invokes[0]!, /mAb114/);
  assert.match(invokes[0]!, /neutralizes/);
  assert.doesNotMatch(invokes[0]!, /Lone Entity/);

  const row = store.getCommunityReport(kbId, "f1", 0);
  assert.ok(row);
  assert.equal(row.status, "ready");
  assert.equal(row.rating, 8);
  const findings = JSON.parse(row.findings) as Array<{ evidence?: string }>;
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.evidence, "localized on the virus spike glycoprotein leading to neutralization");
});

test("runCommunityReport writes a deterministic stub below the member threshold", async (context) => {
  const root = tempRoot("ke-report-stub");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kbId = seedGraph(store);

  let invoked = 0;
  const invoke: PipelineInvoke = async () => {
    invoked++;
    return CANNED_REPORT;
  };
  const result = (await runCommunityReport(
    { store, resolveEndpoint: STUB_ENDPOINT, llmInvoke: invoke },
    fakeJob({ kbId, fingerprint: "f1", communityId: 1 }),
  )) as Record<string, unknown>;

  assert.equal(result.stub, true);
  assert.equal(invoked, 0);
  const row = store.getCommunityReport(kbId, "f1", 1);
  assert.ok(row);
  assert.equal(row.status, "ready");
  assert.match(row.summary, /Small community \(2 members\)/);
});

test("runCommunityReport dead-letters when the community vanished", async (context) => {
  const root = tempRoot("ke-report-vanished");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kbId = store.createKnowledgeBase({ name: "Empty", description: "" });

  await assert.rejects(
    runCommunityReport(
      { store, resolveEndpoint: STUB_ENDPOINT },
      fakeJob({ kbId, fingerprint: "f1", communityId: 7 }),
    ),
    ReportNonRetryableError,
  );
});

test("enqueueCommunityReports enqueues per community and skips ready reports", async (context) => {
  const root = tempRoot("ke-report-enqueue");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kbId = seedGraph(store);

  const first = enqueueCommunityReports(store, {
    kbId,
    fingerprint: "f1",
    communities: [
      { id: 0, size: 4, name: "Antibody response" },
      { id: 1, size: 2 },
    ],
  });
  assert.equal(first.enqueued, 2);

  // Dedup while active: same fingerprint + community never double-enqueues.
  const second = enqueueCommunityReports(store, {
    kbId,
    fingerprint: "f1",
    communities: [{ id: 0, size: 4 }],
  });
  assert.equal(second.enqueued, 0);
  assert.equal(second.skipped, 1);

  // A new fingerprint is a new generation: fresh jobs.
  const third = enqueueCommunityReports(store, {
    kbId,
    fingerprint: "f2",
    communities: [{ id: 0, size: 4 }],
  });
  assert.equal(third.enqueued, 1);
  assert.equal(third.jobIds[0] !== first.jobIds[0], true);

  // Complete one, purge stale fingerprints, keep the keeper.
  store.completeJob(first.jobIds[0]!);
  store.upsertCommunityReport({
    kbId,
    fingerprint: "f2",
    communityId: 0,
    title: "t",
    summary: "s",
    rating: 1,
    ratingExplanation: null,
    findings: "[]",
    status: "ready",
    error: null,
    model: "m",
  });
  const removed = store.deleteCommunityReports(kbId, "f2");
  assert.equal(removed, 0);
  assert.equal(store.listCommunityReports(kbId, "f2").length, 1);
  assert.equal(store.listCommunityReports(kbId, "f1").length, 0);
});

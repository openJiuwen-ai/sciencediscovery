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

import assert from "node:assert/strict";
import test from "node:test";

import type { RemoteJob } from "@science-agent/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ApiClient } from "../src/api.js";
import { RemoteHostManager, RemoteJobsPanel } from "../src/RemoteCompute.js";
import { activityCardId } from "../src/session/run-activity.js";

const timestamp = "2026-07-15T00:00:00.000Z";
const noopToggle = () => undefined;

test("remote host creation uses the primary action button skeleton", () => {
  const html = renderToStaticMarkup(createElement(RemoteHostManager, {
    client: {} as ApiClient,
    onError: () => undefined,
    onPermissionRequest: () => undefined,
    sessionId: "session-1",
  }));

  assert.match(html, /class="primary-button"[^>]*>Probe and add</);
});

function buildJob(overrides: Partial<RemoteJob> = {}): RemoteJob {
  return {
    card: {
      command: "python analysis.py --input /scratch/raw.parquet",
      inputPaths: ["/scratch/raw.parquet"],
      mode: "slurm",
      outputs: [{ disposition: "remote", path: "/scratch/model.bin" }],
      remoteWorkingDirectory: "/scratch/project",
      resources: { cpus: 8, gpus: 1, memoryMb: 32768, walltimeMinutes: 60 },
      targetAlias: "institution-hpc",
      targetId: "host-1",
    },
    createdAt: timestamp,
    id: "job-1",
    outputRecords: [{ disposition: "remote", path: "/scratch/model.bin", status: "pending" }],
    scriptReference: "pending:job-1",
    sessionId: "session-1",
    state: "awaiting_approval",
    updatedAt: timestamp,
    version: 1,
    ...overrides,
  };
}

function renderPanel(job: RemoteJob, expandedCards: Record<string, boolean> = {}) {
  return renderToStaticMarkup(createElement(RemoteJobsPanel, {
    busy: false,
    expandedCards,
    jobs: [job],
    onDecision: () => undefined,
    onRefresh: () => undefined,
    onToggleCard: noopToggle,
  }));
}

test("a job awaiting approval starts expanded so its decision buttons are visible", () => {
  const html = renderPanel(buildJob());

  assert.match(html, /SLURM · institution-hpc/);
  assert.match(html, /awaiting approval/);
  assert.match(html, /aria-expanded="true"/);
  // The approval entry point must not be folded away while the run is blocked.
  assert.match(html, /Allow once/);
  assert.match(html, /Allow same type/);
  assert.match(html, />Deny</);
  assert.equal(html.match(/class="secondary-button"/g)?.length, 2);
  assert.match(html, /class="danger-button"[^>]*>Deny</);
  assert.match(html, /python analysis\.py/);
});

test("an explicit collapse wins over the awaiting-approval default", () => {
  const job = buildJob();
  const html = renderPanel(job, { [activityCardId("remote-job", job.id)]: false });

  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Allow once/);
});

test("finished jobs default to a collapsed summary", () => {
  const html = renderPanel(buildJob({ state: "completed" }));

  assert.match(html, /SLURM · institution-hpc/);
  assert.match(html, /8 CPU · 32768 MiB · 1 GPU/);
  assert.match(html, /aria-expanded="false"/);
  // Command and outputs stay folded away until expanded.
  assert.doesNotMatch(html, /python analysis\.py/);
  assert.doesNotMatch(html, /leave remote/);
});

test("an explicitly expanded finished job shows its details", () => {
  const job = buildJob({ state: "completed" });
  const html = renderPanel(job, { [activityCardId("remote-job", job.id)]: true });

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /\/scratch\/raw\.parquet/);
  assert.match(html, /leave remote/);
  assert.doesNotMatch(html, /Allow once/);
});

test("running SLURM jobs use the secondary refresh action skeleton", () => {
  const job = buildJob({ state: "running" });
  const html = renderPanel(job, { [activityCardId("remote-job", job.id)]: true });

  assert.match(html, /class="secondary-button"[^>]*>Refresh SLURM status</);
});

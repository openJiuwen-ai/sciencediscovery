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
import { createTest } from "../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

import { renderCoverageJobSummary } from "./coverage-job-summary.mjs";

function metric(covered, total, percentage) {
  return { covered, percentage, total };
}

test("renders full and incremental coverage without a threshold", () => {
  const output = renderCoverageJobSummary({
    node: {
      document: {
        authoritative: true,
        files: 12,
        mode: "full",
        scope: "Built Node.js sources.",
        selected_groups: ["packages/agent-core", "scripts"],
        totals: {
          branches: metric(30, 40, 75),
          functions: metric(18, 20, 90),
          lines: metric(80, 100, 80),
        },
      },
      outcome: "success",
      skip: false,
    },
    python: {
      document: {
        authoritative: false,
        files: 4,
        mode: "incremental",
        scope: "Maintained Python services.",
        selected_groups: ["services/gateway"],
        totals: {
          branches: metric(6, 10, 60),
          lines: metric(45, 50, 90),
        },
      },
      outcome: "success",
      skip: false,
    },
  });

  assert.match(output, /Coverage is informational\. \*\*No minimum percentage is enforced\.\*\*/);
  assert.match(output, /\| Node\.js \| Full \| 12 \| 2 \| 80\.00% \(80\/100\) \| 75\.00% \(30\/40\) \|/);
  assert.match(output, /\| Python \| Incremental \| 4 \| 1 \| 90\.00% \(45\/50\) \| 60\.00% \(6\/10\) \|/);
  assert.doesNotMatch(output, /Functions/);
  assert.match(output, /`packages\/agent-core`, `scripts`/);
  assert.match(output, /`services\/gateway`/);
});

test("shows skipped and unavailable scans without inventing percentages", () => {
  const output = renderCoverageJobSummary({
    node: {
      reason: "no covered Node group changed",
      skip: true,
    },
    python: {
      error: "coverage generation failed before a readable summary was produced",
      outcome: "failure",
      skip: false,
    },
  });

  assert.match(output, /\| Node\.js \| Skipped \| — \| — \| n\/a \| n\/a \|/);
  assert.match(output, /\| Python \| Unavailable \| — \| — \| n\/a \| n\/a \|/);
  assert.match(output, /Skipped — no covered Node group changed/);
  assert.match(output, /Unavailable — coverage generation failed/);
});

test("labels a partial report from a failing scan", () => {
  const output = renderCoverageJobSummary({
    node: {
      document: {
        files: 1,
        mode: "incremental",
        selected_groups: ["scripts"],
        totals: {
          branches: metric(1, 2, 50),
          functions: metric(1, 1, 100),
          lines: metric(3, 4, 75),
        },
      },
      outcome: "failure",
      skip: false,
    },
    python: { reason: "no covered Python service changed", skip: true },
  });

  assert.match(output, /\| Node\.js \| Incremental \(failed\) \|/);
  assert.match(output, /\| Python \| Skipped \|/);
});

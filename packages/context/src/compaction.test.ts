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

import { isSummaryCheckpointMessage, summaryCheckpointMessage } from "./compaction.js";

test("a freshly written checkpoint carries the current product spelling", () => {
  const checkpoint = summaryCheckpointMessage("earlier turns");
  assert.ok(checkpoint);
  assert.match(String(checkpoint.content), /\[ScienceDiscovery summary checkpoint\]/);
  assert.equal(
    (checkpoint.additional_kwargs as Record<string, unknown>).sciencediscovery_summary_checkpoint,
    true,
  );
  assert.equal(isSummaryCheckpointMessage(checkpoint), true);
});

test("checkpoints stored under the former product name are still recognized", () => {
  // Histories written before the rename must keep chaining instead of being
  // summarized a second time, so both the marker and the flag stay readable.
  assert.equal(isSummaryCheckpointMessage({
    role: "user",
    name: "summary",
    content: "[ScienceAgent summary checkpoint]\n<durable_context_data>\n</durable_context_data>",
  }), true);
  assert.equal(isSummaryCheckpointMessage({
    role: "user",
    name: "summary",
    content: "an opaque body with no marker",
    additional_kwargs: { hide_from_ui: true, science_agent_summary_checkpoint: true },
  }), true);
});

test("an ordinary message is not mistaken for a checkpoint", () => {
  assert.equal(isSummaryCheckpointMessage({
    role: "user",
    content: "[ScienceDiscovery summary checkpoint]",
  }), false);
});

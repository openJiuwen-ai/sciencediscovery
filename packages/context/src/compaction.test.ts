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

import {
  buildSummaryPrompt,
  isSummaryCheckpointMessage,
  summaryCheckpointMessage,
  validateSummaryCheckpoint,
} from "./compaction.js";

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

test("summary input preserves bounded tool evidence and requests a scientific checkpoint", () => {
  const evidence = `DOI:10.1000/example\n${"finding ".repeat(200)}`;
  const prompt = buildSummaryPrompt({
    preserved: [],
    previousSummary: "",
    toSummarize: [{ role: "tool", name: "web_fetch", tool_call_id: "call-1", content: evidence }],
  });
  assert.match(prompt, /## Primary request and intent/u);
  assert.match(prompt, /## Evidence, artifacts, and references/u);
  assert.match(prompt, /Pending requirements contains only explicit user requirements/u);
  assert.match(prompt, /retryable=false results/u);
  assert.match(prompt, /Next step contains exactly one action/u);
  assert.match(prompt, /DOI:10\.1000\/example/u);
  assert.match(prompt, /call_id=call-1/u);
  assert.ok(prompt.length > 1_000, "the summary input is no longer silently clipped to a 600-character tool excerpt");
});

test("checkpoint validation fills missing structural sections without making semantic decisions", () => {
  const result = validateSummaryCheckpoint([
    "## Primary request and intent",
    "- Write a report.",
    "## Completed work and verified findings",
    "- Found a source at tool-output-abcdef12.",
    "## Next step",
    "- Draft the report.",
  ].join("\n"), new Set(["tool-output-abcdef12"]));
  assert.match(result.normalized, /## Failed or abandoned leads\n\(none\)/u);
  assert.match(result.normalized, /## Optional leads\n\(none\)/u);
  assert.equal(result.warnings.some((warning) => warning.includes("missing section")), true);
  assert.equal(result.warnings.some((warning) => warning.includes("unverified tool output")), false);
});

test("checkpoint validation reports duplicate next actions and unknown refs", () => {
  const result = validateSummaryCheckpoint([
    "## Pending requirements",
    "- User requested a report.",
    "## Next step",
    "- Search again.",
    "- Write later using tool-output-deadbeef.",
  ].join("\n"));
  assert.equal(result.warnings.includes("Next step contains more than one list item"), true);
  assert.equal(result.warnings.includes("unverified tool output ref: tool-output-deadbeef"), true);
});

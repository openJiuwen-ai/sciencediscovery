// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTest } from "../test/support/tagged/compat.mjs";
import { finalAnswer, deliveryStatus, selectFinalOutputs, scoringArtifact,
  requiredArtifacts, finalReportArtifact } from "../test/helpers/real-delivery.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });
const artifacts = [{ id: "report-id", logicalName: "results/research.md", versions: [{ id: "version-id" }] }, { id: "scratch-id", logicalName: "scratch.txt" }];
const run = { assistantMessageId: "final", status: "completed" };
const messages = answer => [{ id: "previous", role: "assistant", content: "scratch.txt" }, { id: "final", role: "assistant", content: answer }];
const outputs = [
  { artifact: artifacts[0], version: { id: "old-version", version: 1, turnId: "r" } },
  { artifact: artifacts[0], version: { id: "version-id", version: 2, turnId: "r" } },
  { artifact: artifacts[1], version: { id: "scratch-version", version: 1, turnId: "r" } },
];

test("delivery uses the latest declared output, even when the final reply only acknowledges completion", () => {
  assert.equal(finalAnswer(run, messages("Done")), "Done");
  assert.deepEqual(selectFinalOutputs(outputs, ["r"], []), {
    selected: [outputs[1], outputs[2]], producerRunId: "r",
    producerRunIds: { "version-id": "r", "scratch-version": "r" }, errors: [],
  });
  assert.equal(deliveryStatus("completed", []), "failed");
  assert.equal(deliveryStatus("failed", [artifacts[0]]), "partial");
  assert.equal(deliveryStatus("cancelled", [artifacts[0]]), "partial");
  assert.equal(deliveryStatus("completed", [artifacts[0]]), "passed");
  for (const status of ["queued", "running", "blocked"]) {
    assert.equal(deliveryStatus(status, []), "running");
    assert.equal(deliveryStatus(status, [artifacts[0]]), "running");
  }
});
test("the final reply does not override the newest declared version", () => {
  assert.equal(finalAnswer(run, messages("[report](/artifact-versions/old-version/content)")), "[report](/artifact-versions/old-version/content)");
  assert.deepEqual(selectFinalOutputs(outputs, ["r"], []).selected[0], outputs[1]);
});
test("a renamed Artifact ID selects only its newest declaration", () => {
  const renamed = [
    { artifact: { id: "same", name: "draft.md" }, version: { id: "draft-v1", version: 1, turnId: "root" } },
    { artifact: { id: "same", name: "final.md" }, version: { id: "final-v2", version: 2, turnId: "wake" } },
  ];
  assert.deepEqual(selectFinalOutputs(renamed, ["root", "wake"], []).selected, [renamed[1]]);
});

test("ambiguous basenames and substrings do not silently choose an artifact", () => {
  const duplicates = [...outputs, { artifact: { id: "other", logicalName: "other/research.md" },
    version: { id: "other-version", version: 1, turnId: "r" } }];
  const selected = selectFinalOutputs(duplicates, ["r"], []).selected.map(({ artifact, version }) =>
    ({ id: artifact.id, logicalName: artifact.logicalName, version: version.id }));
  assert.deepEqual(requiredArtifacts(selected, ["research.md"]).missing, ["research.md"]);
  assert.equal(finalReportArtifact(selected, "missing.md", "Done"), undefined);
  assert.deepEqual(selectFinalOutputs(outputs, ["unrelated"], []).selected, []);
  assert.equal(scoringArtifact(artifacts, "missing.md"), undefined);
  assert.equal(scoringArtifact([artifacts[0]], "legacy-name.md"), artifacts[0]);
});

test("TC rubric validation and bounded judge recovery pass without model calls", () => {
  execFileSync(process.env.SCIENCE_TEST_PYTHON ?? "python3", ["-m", "unittest", "discover", "-s", "test/benchmarks/research-team", "-p", "test_*.py"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 30_000, stdio: "pipe",
  });
});

test("Biomni and PUCT judge retries preserve evidence and scoring contracts", () => {
  execFileSync(process.env.SCIENCE_TEST_PYTHON ?? "python3", ["-m", "unittest", "discover", "-s", "test/benchmarks", "-p", "test_judge_retry.py"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 30_000, stdio: "pipe",
  });
});

test("Biomni local clarified rubric registry pins da-13-3 without touching official", () => {
  execFileSync(process.env.SCIENCE_TEST_PYTHON ?? "python3", ["-m", "unittest", "discover", "-s", "test/benchmarks/biomnibench-da", "-p", "test_local_rubrics.py"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 30_000, stdio: "pipe",
  });
});

test("Biomni offline repeat grading preserves all eight inputs and reports criterion noise", () => {
  execFileSync(process.env.SCIENCE_TEST_PYTHON ?? "python3", ["-m", "unittest", "discover", "-s", "test/benchmarks/biomnibench-da", "-p", "test_repeat_grade.py"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 30_000, stdio: "pipe",
  });
});

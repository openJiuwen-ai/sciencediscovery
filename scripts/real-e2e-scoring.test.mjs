// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTest } from "../test/support/tagged/compat.mjs";
import { finalReferences, deliveryStatus, scoringArtifact } from "../test/helpers/real-delivery.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });
const artifacts = [{ id: "report-id", logicalName: "results/research.md", versions: [{ id: "version-id" }] }, { id: "scratch-id", logicalName: "scratch.txt" }];
const run = { assistantMessageId: "final", status: "completed" };
const messages = answer => [{ id: "previous", role: "assistant", content: "scratch.txt" }, { id: "final", role: "assistant", content: answer }];

test("delivery uses this run's final handoff, not merely an existing intermediate artifact", () => {
  assert.deepEqual(finalReferences(run, messages("Done"), artifacts).selected, []);
  assert.equal(deliveryStatus("completed", []), "failed");
  assert.equal(deliveryStatus("failed", [artifacts[0]]), "partial");
  assert.equal(deliveryStatus("cancelled", [artifacts[0]]), "partial");
  assert.equal(deliveryStatus("completed", [artifacts[0]]), "passed");
});
test("final handoffs accept nested names, IDs and encoded version links", () => {
  for (const answer of ["`research.md`", "[report](/workspace/results/research.md)", "artifact report-id", "[report](/artifact-versions/version-id/content)", "[report](results%2Fresearch.md)"]) {
    assert.deepEqual(finalReferences(run, messages(answer), artifacts).selected, [artifacts[0]]);
  }
});
test("ambiguous basenames and substrings do not silently choose an artifact", () => {
  const duplicates = [...artifacts, { id: "other", logicalName: "other/research.md" }];
  assert.deepEqual(finalReferences(run, messages("research.md"), duplicates).selected, []);
  assert.deepEqual(finalReferences(run, messages("notresearch.md"), artifacts).selected, []);
  assert.equal(scoringArtifact(artifacts, "missing.md"), undefined);
  assert.equal(scoringArtifact([artifacts[0]], "legacy-name.md"), artifacts[0]);
});

test("TC rubric validation and bounded judge recovery pass without model calls", () => {
  execFileSync(process.env.SCIENCE_TEST_PYTHON ?? "python3", ["-m", "unittest", "discover", "-s", "test/benchmarks/research-team", "-p", "test_*.py"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 30_000, stdio: "pipe",
  });
});

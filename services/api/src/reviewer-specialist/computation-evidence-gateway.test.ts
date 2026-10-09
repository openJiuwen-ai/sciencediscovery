// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import type { ExecutionRun, ScientificArtifact, ScientificArtifactVersion } from "@sciencediscovery/schema";

import { ReviewerComputationEvidenceGateway } from "./computation-evidence-gateway.js";

const ref = (hash: string, value: string) => ({ hash, size: Buffer.byteLength(value) });

test("Reviewer computation evidence gateway issues E4 material only for a successful pinned run", async () => {
  const data = new Map([["data", "metric,rate\nresponse,42%"], ["code", "print('42%')"], ["stdout", "42%\n"]]);
  const artifact = { createdInSessionId: "session-1", id: "data-artifact" } as ScientificArtifact;
  const version = {
    artifactId: artifact.id, content: ref("data", "metric,rate\nresponse,42%"), executionRunIds: ["run-1"], id: "data-v2",
    mediaType: "text/csv", sessionId: "session-1", sourcePath: "outputs/rates.csv", version: 2,
  } as ScientificArtifactVersion;
  const run = {
    code: ref("code", "print('42%')"), finishedAt: "2026-09-10T00:00:00.000Z", id: "run-1",
    sessionId: "session-1", status: "succeeded", stdout: ref("stdout", "42%\n"),
  } as ExecutionRun;
  const gateway = new ReviewerComputationEvidenceGateway({
    getArtifact: () => artifact,
    getArtifactVersion: () => undefined,
    listArtifactVersions: () => [version],
    listExecutionRuns: async () => [run],
  } as never, {
    read: async (hash: string) => Buffer.from(data.get(hash) ?? ""),
    verify: async (hash: string) => data.has(hash),
  } as never);

  const result = await gateway.resolve("session-1", { alias: "artifact1", artifactId: artifact.id, artifactVersion: 2, excerpt: "Rate was 42% [artifact1].", values: ["42%"] });
  assert.equal(result.status, "available");
  assert.deepEqual(result.materials?.map((item) => item.sourceType), ["artifact", "code", "execution"]);
  assert.equal(result.materials?.[0]?.locator.executionId, "run-1");
  assert.equal(result.materials?.[0]?.locator.outputPath, "outputs/rates.csv");
  assert.deepEqual(result.materials?.[0]?.locator, { column: "rate", executionId: "run-1", outputPath: "outputs/rates.csv", row: "2", table: "data" });
});

test("Reviewer computation evidence gateway refuses a numeric claim absent from a locked data Artifact", async () => {
  const data = new Map([["data", "metric,rate\nresponse,42%"], ["code", "print('42%')"], ["stdout", "42%\n"]]);
  const artifact = { createdInSessionId: "session-1", id: "data-artifact" } as ScientificArtifact;
  const version = { artifactId: artifact.id, content: ref("data", "metric,rate\nresponse,42%"), executionRunIds: ["run-1"], id: "data-v2", mediaType: "text/csv", sessionId: "session-1", version: 2 } as ScientificArtifactVersion;
  const run = { code: ref("code", "print('42%')"), finishedAt: "2026-09-10T00:00:00.000Z", id: "run-1", sessionId: "session-1", status: "succeeded", stdout: ref("stdout", "42%\n") } as ExecutionRun;
  const gateway = new ReviewerComputationEvidenceGateway({ getArtifact: () => artifact, getArtifactVersion: () => undefined, listArtifactVersions: () => [version], listExecutionRuns: async () => [run] } as never, {
    read: async (hash: string) => Buffer.from(data.get(hash) ?? ""), verify: async (hash: string) => data.has(hash),
  } as never);
  const result = await gateway.resolve("session-1", { alias: "artifact1", artifactId: artifact.id, artifactVersion: 2, excerpt: "Rate was 50% [artifact1].", values: ["50%"] });
  assert.equal(result.status, "unavailable");
  assert.match(result.message ?? "", /could not be located exactly/u);
});

test("Reviewer computation evidence gateway accepts only the unit-safe 0.42 to 42% normalization", async () => {
  const data = new Map([["data", "metric,value\nresponse,0.42"], ["code", "print(0.42)"], ["stdout", "0.42\n"]]);
  const artifact = { createdInSessionId: "session-1", id: "data-artifact" } as ScientificArtifact;
  const version = { artifactId: artifact.id, content: ref("data", "metric,value\nresponse,0.42"), executionRunIds: ["run-1"], id: "data-v2", mediaType: "text/csv", sessionId: "session-1", version: 2 } as ScientificArtifactVersion;
  const run = { code: ref("code", "print(0.42)"), finishedAt: "2026-09-10T00:00:00.000Z", id: "run-1", sessionId: "session-1", status: "succeeded", stdout: ref("stdout", "0.42\n") } as ExecutionRun;
  const gateway = new ReviewerComputationEvidenceGateway({ getArtifact: () => artifact, getArtifactVersion: () => undefined, listArtifactVersions: () => [version], listExecutionRuns: async () => [run] } as never, {
    read: async (hash: string) => Buffer.from(data.get(hash) ?? ""), verify: async (hash: string) => data.has(hash),
  } as never);
  const result = await gateway.resolve("session-1", { alias: "artifact1", artifactId: artifact.id, artifactVersion: 2, excerpt: "Response was 42% [artifact1].", values: ["42%"] });
  assert.equal(result.status, "available");
  const mismatch = await gateway.resolve("session-1", { alias: "artifact1", artifactId: artifact.id, artifactVersion: 2, excerpt: "Dose was 42 mg/L [artifact1].", values: ["42 mg/L"] });
  assert.equal(mismatch.status, "unavailable");
});

test("Reviewer computation evidence gateway refuses numeric substring matches", async () => {
  const cases: Array<[cell: string, claim: string]> = [["142%", "42%"], ["0.42", "0.4"]];
  for (const [cell, value] of cases) {
    const content = `metric,value\nresponse,${cell}`;
    const data = new Map([["data", content], ["code", "print('locked')"], ["stdout", "locked\n"]]);
    const artifact = { createdInSessionId: "session-1", id: "data-artifact" } as ScientificArtifact;
    const version = { artifactId: artifact.id, content: ref("data", content), executionRunIds: ["run-1"], id: "data-v2", mediaType: "text/csv", sessionId: "session-1", version: 2 } as ScientificArtifactVersion;
    const run = { code: ref("code", "print('locked')"), finishedAt: "2026-09-10T00:00:00.000Z", id: "run-1", sessionId: "session-1", status: "succeeded", stdout: ref("stdout", "locked\n") } as ExecutionRun;
    const gateway = new ReviewerComputationEvidenceGateway({ getArtifact: () => artifact, getArtifactVersion: () => undefined, listArtifactVersions: () => [version], listExecutionRuns: async () => [run] } as never, {
      read: async (hash: string) => Buffer.from(data.get(hash) ?? ""), verify: async (hash: string) => data.has(hash),
    } as never);
    const result = await gateway.resolve("session-1", { alias: "artifact1", artifactId: artifact.id, artifactVersion: 2, excerpt: `Reported ${value} [artifact1].`, values: [value] });
    assert.equal(result.status, "unavailable", `${value} must not match a substring of ${cell}`);
  }
});

test("Reviewer computation evidence gateway never accepts failed or unrecorded executions", async () => {
  const artifact = { createdInSessionId: "session-1", id: "data-artifact" } as ScientificArtifact;
  const version = { artifactId: artifact.id, executionRunIds: ["failed-run"], id: "data-v1", sessionId: "session-1", version: 1 } as ScientificArtifactVersion;
  const gateway = new ReviewerComputationEvidenceGateway({
    getArtifact: () => artifact,
    getArtifactVersion: () => undefined,
    listArtifactVersions: () => [version],
    listExecutionRuns: async () => [{ id: "failed-run", sessionId: "session-1", status: "failed" }],
  } as never, { read: async () => Buffer.alloc(0), verify: async () => false } as never);
  const result = await gateway.resolve("session-1", { alias: "artifact1", artifactId: artifact.id, artifactVersion: 1, excerpt: "Rate was 42% [artifact1].", values: ["42%"] });
  assert.equal(result.status, "unavailable");
  assert.match(result.message ?? "", /no successful recorded ExecutionRun/u);
});

#!/usr/bin/env node
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

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

export function planIdentitySet(plan) {
  return plan.entries.map((entry) => entry.key).sort();
}

export function comparePlans(first, second) {
  const problems = [];
  if (first.revision !== second.revision) problems.push("revision changed");
  if (first.catalogDigest !== second.catalogDigest) problems.push("catalog digest changed");
  if (first.digest !== second.digest) problems.push("plan digest changed");
  const firstKeys = planIdentitySet(first);
  const secondKeys = planIdentitySet(second);
  if (JSON.stringify(firstKeys) !== JSON.stringify(secondKeys)) problems.push("plan identity set changed");
  if (first.entries.length !== second.entries.length) problems.push("planned count changed");
  return problems;
}

function runList({ root, profile, slice, output }) {
  const shared = resolve(root, "test/support/tagged/shared.mjs");
  const result = spawnSync(process.execPath, [shared, "list", "--profile", profile, "--slice", slice, "--output", output], {
    cwd: root,
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    const outputText = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`PLAN_COLLECTION_FAILED (${profile}/${slice})${outputText ? `: ${outputText}` : ""}`);
  }
  const planPath = join(output, "plan.json");
  if (!existsSync(planPath)) throw new Error(`PLAN_ARTIFACT_MISSING: ${planPath}`);
  return JSON.parse(readFileSync(planPath, "utf8"));
}

export function verifyPlanStability({ root = process.cwd(), profile = "release", slice = "shared", outputRoot } = {}) {
  const workspace = outputRoot ?? mkdtempSync(join(tmpdir(), "sciencediscovery-plan-"));
  const firstOutput = join(workspace, "first");
  const secondOutput = join(workspace, "second");
  try {
    const first = runList({ root, profile, slice, output: firstOutput });
    const second = runList({ root, profile, slice, output: secondOutput });
    const problems = comparePlans(first, second);
    if (problems.length) throw new Error(`PLAN_NOT_STABLE: ${problems.join(", ")}`);
    return {
      profile,
      slice,
      revision: first.revision,
      digest: first.digest,
      catalogDigest: first.catalogDigest,
      planned: first.entries.length,
      identityCount: planIdentitySet(first).length,
    };
  } finally {
    if (!outputRoot) rmSync(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const profileIndex = process.argv.indexOf("--profile");
  const sliceIndex = process.argv.indexOf("--slice");
  const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : "release";
  const slice = sliceIndex >= 0 ? process.argv[sliceIndex + 1] : "shared";
  if (!profile || !slice) throw new Error("Usage: node .ci/plan-stability.mjs [--profile <name>] [--slice <name>]");
  const result = verifyPlanStability({ profile, slice });
  console.log(`Stable plan ${result.profile}/${result.slice}: ${result.planned} identities, digest=${result.digest}`);
}

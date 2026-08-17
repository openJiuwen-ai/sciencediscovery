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

// Validates the E2E-META contract for the Playwright specs in this directory:
// every top-level test() must be immediately preceded by an E2E-META comment
// block whose fields are complete and whose Type (mocked | real) agrees with
// the @mocked / @real tag on the test. Files in LEGACY predate the contract,
// stay quarantined from the safe default project, and produce a migration
// warning until they carry their first block.
//
// Run from anywhere: node test/check-e2e-meta.mjs

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const specDir = dirname(fileURLToPath(import.meta.url));

// Pending migration to the E2E-META contract. Remove entries as they migrate;
// never add new spec files here.
const LEGACY = new Set([
  "agent-run-componentization.spec.ts",
  "artifact-dashboard.spec.ts",
  "debug-main-path.spec.ts",
  "e2e-auth.spec.ts",
  "gateway-token-recovery.spec.ts",
  "issue-143-proxy-settings.spec.ts",
  "issue-37-composer-height.spec.ts",
  "issue-44-background-timeline.spec.ts",
  "issue-44-session-stop.spec.ts",
  "session-run-api-queue-stop.spec.ts",
  "session-run-queue-stop.spec.ts",
  "subagent-rename-and-align.spec.ts",
  "timeouts-runtime-status-user.spec.ts",
]);

const REQUIRED_FIELDS = [
  "Purpose",
  "Steps",
  "Environment",
  "Type",
  "LLM",
  "WebSearch",
  "PaperSources",
  "MCP",
  "OtherExternal",
  "Credentials",
  "CostSideEffects",
];
// How far below a test declaration the tag option may sit (multi-line args).
const TAG_WINDOW = 400;

const errors = [];
const warnings = [];

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * Journey specs additionally carry the step-report contract: every user step
 * goes through the `journey` fixture so the run writes report.md/report.html
 * with per-step screenshots and logs. Hand-rolled `page.screenshot()` as the
 * primary evidence is what this replaces, so it is rejected here rather than
 * discovered when a report turns out to be empty.
 */
function checkJourneyFile(name, text, tests) {
  if (!/^journey-.*\.spec\.ts$/.test(name)) return;

  if (!/import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*["']\.\/helpers\/e2e\.ts["']/.test(text)) {
    errors.push(`${name}: journey specs must import test from ./helpers/e2e.ts to get the journey fixture`);
  }
  if (!text.includes("journey.step(")) {
    errors.push(`${name}: journey specs must record each user step with journey.step(title, description, body)`);
  }
  if (!text.includes("journey.scenario(")) {
    errors.push(`${name}: journey specs must declare journey.scenario({ goal, preconditions }) for the report header`);
  }
  const adHocShot = text.search(/\bpage\s*\.\s*screenshot\s*\(/);
  if (adHocShot >= 0) {
    errors.push(
      `${name}:${lineOf(text, adHocShot)}: journey specs must not take ad-hoc page.screenshot(); `
      + "journey.step() captures step evidence",
    );
  }
  for (const match of tests) {
    const declaration = text.slice(match.index, match.index + TAG_WINDOW);
    const fixtures = declaration.match(/async\s*\(\s*\{([^}]*)\}/)?.[1] ?? "";
    if (!/\bjourney\b/.test(fixtures)) {
      errors.push(`${name}:${lineOf(text, match.index)}: journey test must request the { journey } fixture`);
    }
  }
}

function checkFile(name) {
  const text = readFileSync(join(specDir, name), "utf8");
  const tests = [...text.matchAll(/^\s*test(?:\.(?:only|skip|fixme|fail))?\s*\(/gm)];
  const hasMeta = text.includes("E2E-META");
  const hasMocked = /^\s*\*\s*Type:\s*mocked\s*$/m.test(text);
  const usesE2EFixture = /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*["']\.\/helpers\/e2e\.ts["']/.test(text);

  if (!hasMeta) {
    if (LEGACY.has(name)) {
      warnings.push(`${name}: quarantined legacy spec without E2E-META blocks (pending migration)`);
      // A legacy spec must not partially opt into a group without metadata.
      if (/@(?:mocked|real)/.test(text)) {
        errors.push(`${name}: mentions a group tag but has no E2E-META block — migrate it`);
      }
      return;
    }
    errors.push(`${name}: no E2E-META block; every new spec must document each test`);
    return;
  }

  if (hasMocked && !usesE2EFixture) {
    errors.push(`${name}: mocked tests must import test from ./helpers/e2e.ts for the automatic network guard`);
  }

  checkJourneyFile(name, text, tests);

  for (const [testIndex, match] of tests.entries()) {
    const line = lineOf(text, match.index);
    // Plain // comment lines (e.g. a fixme note) may sit between the block
    // and the test declaration.
    const beforeLines = text.slice(0, match.index).trimEnd().split("\n");
    while (beforeLines.length && beforeLines[beforeLines.length - 1].trim().startsWith("//")) beforeLines.pop();
    const before = beforeLines.join("\n").trimEnd();
    const blockStart = before.lastIndexOf("/**");
    const block = blockStart >= 0 && before.endsWith("*/") ? before.slice(blockStart) : null;
    if (!block || !block.includes("E2E-META")) {
      errors.push(`${name}:${line}: test is not immediately preceded by an E2E-META block`);
      continue;
    }

    const missing = REQUIRED_FIELDS.filter((field) => !new RegExp(`^\\s*\\*\\s*${field}:`, "m").test(block));
    if (missing.length) {
      errors.push(`${name}:${line}: E2E-META missing field(s): ${missing.join(", ")}`);
    }
    const empty = REQUIRED_FIELDS.filter((field) => {
      if (field === "Steps") return false;
      return new RegExp(`^\\s*\\*\\s*${field}:\\s*$`, "m").test(block);
    });
    if (empty.length) {
      errors.push(`${name}:${line}: E2E-META empty field(s): ${empty.join(", ")}`);
    }
    if (!/^\s*\*\s+1\.\s+\S/m.test(block)) {
      errors.push(`${name}:${line}: E2E-META Steps must contain a numbered first step`);
    }

    const type = block.match(/^\s*\*\s*Type:\s*(\S+)/m)?.[1];
    if (type !== "mocked" && type !== "real") {
      errors.push(`${name}:${line}: E2E-META Type must be "mocked" or "real" (got "${type ?? ""}")`);
      continue;
    }

    if (type === "real") {
      const body = text.slice(match.index, tests[testIndex + 1]?.index ?? text.length);
      const envGate = body.search(/\b(?:requireRealEnv|allowRealEnvException)\s*\(/);
      const stackGate = body.search(/\brequireRealStack\s*\(/);
      const externalAction = body.search(/\b(?:(?:setupSession|openWorkspace|api|fetch)\s*\(|(?:page|request)\.(?:goto|reload|get|post|put|patch|delete|fetch)\s*\()/);

      if (!usesE2EFixture) {
        errors.push(`${name}:${line}: real tests must import test from ./helpers/e2e.ts`);
      }
      if (envGate < 0) {
        errors.push(`${name}:${line}: real test body needs requireRealEnv(...) or allowRealEnvException(...)`);
      } else if (body.slice(envGate).startsWith("requireRealEnv")) {
        const gateCall = body.slice(envGate, envGate + 400);
        const missingEnv = ["E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN"].filter((env) => !gateCall.includes(env));
        if (missingEnv.length) errors.push(`${name}:${line}: requireRealEnv gate missing ${missingEnv.join(", ")}`);
      }
      if (stackGate < 0) {
        errors.push(`${name}:${line}: real test body needs requireRealStack(...)`);
      }
      if (externalAction >= 0 && (envGate < 0 || stackGate < 0 || envGate > externalAction || stackGate > externalAction)) {
        errors.push(`${name}:${line}: real environment gates must precede the first external action`);
      }
    }

    const declaration = text.slice(match.index, match.index + TAG_WINDOW);
    const tags = [...declaration.matchAll(/tag\s*:\s*["']@(mocked|real)["']/g)].map((tag) => tag[1]);
    if (!tags.includes(type)) {
      errors.push(`${name}:${line}: Type: ${type} but the test lacks a { tag: "@${type}" } option`);
    }
    const otherType = type === "mocked" ? "real" : "mocked";
    if (tags.includes(otherType)) {
      errors.push(`${name}:${line}: Type: ${type} but the test is tagged @${otherType}`);
    }
  }
}

const specs = readdirSync(specDir).filter((name) => name.endsWith(".spec.ts")).sort();
specs.forEach(checkFile);

for (const warning of warnings) console.warn(`WARN  ${warning}`);
for (const error of errors) console.error(`ERROR ${error}`);
console.log(
  `check-e2e-meta: ${specs.length} spec file(s), ${errors.length} error(s), ${warnings.length} legacy warning(s)`,
);
process.exit(errors.length ? 1 : 0);

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

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { tagDimensions, testCases } from "./test-catalog.mjs";

const actions = new Set(["check", "list", "run", "tags"]);
const action = process.argv[2];
const args = process.argv.slice(3);

function usage(message) {
  if (message) console.error(message);
  console.error(`Usage:
  node .ci/test-selector.mjs tags [--json]
  node .ci/test-selector.mjs list [--tag <tag[,tag...]>] [--exclude <tag[,tag...]>] [--case <id>] [--json]
  node .ci/test-selector.mjs run  (--tag <tag[,tag...]> | --case <id>)... [--exclude <tag[,tag...]>]
  node .ci/test-selector.mjs check

Repeated --tag clauses use AND; comma-separated tags inside one clause use OR.
Every --exclude clause removes cases matching any tag in that clause.`);
  process.exitCode = 2;
}

function parseOptions(values) {
  const options = { cases: [], excludes: [], json: false, tags: [] };
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index];
    // pnpm versions differ on whether the conventional separator is stripped.
    if (current === "--") continue;
    if (current === "--json") {
      options.json = true;
      continue;
    }
    const key = current === "--case" ? "cases" : current === "--exclude" ? "excludes" : current === "--tag" ? "tags" : undefined;
    if (!key) throw new Error(`Unknown option: ${current}`);
    const value = values[index + 1]?.trim();
    if (!value || value.startsWith("--")) throw new Error(`${current} requires a value`);
    options[key].push(value);
    index += 1;
  }
  return options;
}

function knownTags() {
  return new Set(Object.entries(tagDimensions).flatMap(([dimension, definition]) =>
    Object.keys(definition.values).map((value) => `${dimension}:${value}`)));
}

function validateCatalog() {
  const errors = [];
  const ids = new Set();
  const resultPaths = new Set();
  const allowedTags = knownTags();
  const dimensions = Object.keys(tagDimensions);
  for (const testCase of testCases) {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(testCase.id)) errors.push(`${testCase.id}: invalid id`);
    if (ids.has(testCase.id)) errors.push(`${testCase.id}: duplicate id`);
    ids.add(testCase.id);
    if (!testCase.description?.trim()) errors.push(`${testCase.id}: missing description`);
    if (!testCase.resultPath?.trim()) errors.push(`${testCase.id}: missing resultPath`);
    if (resultPaths.has(testCase.resultPath)) errors.push(`${testCase.id}: duplicate resultPath ${testCase.resultPath}`);
    resultPaths.add(testCase.resultPath);
    if (testCase.runnable === false) {
      if (!testCase.unsupportedReason?.trim()) errors.push(`${testCase.id}: unsupported case needs a reason`);
    } else if (!Array.isArray(testCase.command) || testCase.command.length === 0 || testCase.command.some((part) => typeof part !== "string" || !part)) {
      errors.push(`${testCase.id}: runnable case needs a non-empty argv command`);
    }
    if (!Array.isArray(testCase.tags)) {
      errors.push(`${testCase.id}: tags must be an array`);
      continue;
    }
    const tags = new Set(testCase.tags);
    if (tags.size !== testCase.tags.length) errors.push(`${testCase.id}: duplicate tags`);
    for (const tag of tags) if (!allowedTags.has(tag)) errors.push(`${testCase.id}: unknown tag ${tag}`);
    for (const dimension of dimensions) {
      const count = [...tags].filter((tag) => tag.startsWith(`${dimension}:`)).length;
      const multiple = tagDimensions[dimension].multiple === true;
      if (count === 0 || (!multiple && count !== 1)) {
        errors.push(`${testCase.id}: expected ${multiple ? "at least one" : "exactly one"} ${dimension}:* tag, found ${count}`);
      }
    }
  }
  if (errors.length > 0) throw new Error(`Invalid CI test catalog:\n- ${errors.join("\n- ")}`);
}

function splitClauses(clauses, allowedTags) {
  return clauses.map((clause) => {
    const alternatives = clause.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (alternatives.length === 0) throw new Error(`Empty tag clause: ${clause}`);
    const unknown = alternatives.filter((tag) => !allowedTags.has(tag));
    if (unknown.length > 0) throw new Error(`Unknown tag(s): ${unknown.join(", ")}; run pnpm ci:tags`);
    return alternatives;
  });
}

function selectCases(options) {
  const allowedTags = knownTags();
  const includes = splitClauses(options.tags, allowedTags);
  const excludes = splitClauses(options.excludes, allowedTags);
  const requestedCases = new Set(options.cases);
  const unknownCases = [...requestedCases].filter((id) => !testCases.some((testCase) => testCase.id === id));
  if (unknownCases.length > 0) throw new Error(`Unknown case(s): ${unknownCases.join(", ")}`);
  return testCases.filter((testCase) => {
    const tags = new Set(testCase.tags);
    if (requestedCases.size > 0 && !requestedCases.has(testCase.id)) return false;
    if (!includes.every((alternatives) => alternatives.some((tag) => tags.has(tag)))) return false;
    return !excludes.some((alternatives) => alternatives.some((tag) => tags.has(tag)));
  });
}

function printCases(selected, json) {
  if (json) {
    console.log(JSON.stringify(selected, null, 2));
    return;
  }
  if (selected.length === 0) {
    console.log("No test cases matched.");
    return;
  }
  for (const testCase of selected) {
    const state = testCase.runnable === false ? "unsupported" : testCase.gates ? "gated" : "runnable";
    console.log(`${testCase.id}\t${state}\t${testCase.tags.join(",")}\n  ${testCase.description}`);
    if (testCase.unsupportedReason) console.log(`  BLOCKED: ${testCase.unsupportedReason}`);
    if (testCase.limitation) console.log(`  LIMIT: ${testCase.limitation}`);
  }
}

function printTags(json) {
  const rows = [];
  for (const [dimension, definition] of Object.entries(tagDimensions)) {
    for (const [value, description] of Object.entries(definition.values)) {
      const tag = `${dimension}:${value}`;
      rows.push({
        cases: testCases.filter((testCase) => testCase.tags.includes(tag)).map((testCase) => testCase.id),
        description,
        dimension,
        tag,
      });
    }
  }
  if (json) console.log(JSON.stringify(rows, null, 2));
  else {
    for (const row of rows) console.log(`${row.tag}\t${row.cases.length}\t${row.description}`);
  }
}

function nativeArchitecture() {
  if (process.arch === "x64") return "amd64";
  if (process.arch === "arm64") return "arm64";
  return process.arch;
}

function preflight(selected) {
  const problems = [];
  const architecture = nativeArchitecture();
  for (const testCase of selected) {
    if (!testCase.tags.includes(`arch:${architecture}`)) {
      problems.push(`${testCase.id}: current architecture is ${architecture}`);
    }
    if (testCase.runnable === false) problems.push(`${testCase.id}: ${testCase.unsupportedReason}`);
    if (testCase.gates?.allowEnv && process.env[testCase.gates.allowEnv] !== "1") {
      problems.push(`${testCase.id}: set ${testCase.gates.allowEnv}=1 for explicit opt-in`);
    }
    const missing = (testCase.gates?.requiredEnv ?? []).filter((name) => !process.env[name]?.trim());
    if (missing.length > 0) problems.push(`${testCase.id}: missing ${missing.join(", ")}`);
  }
  return problems;
}

async function runSelected(selected) {
  const configuredRoot = process.env.CI_RESULTS_DIR?.trim() || "/ci-results";
  const resultsRoot = isAbsolute(configuredRoot) ? configuredRoot : resolve(process.cwd(), configuredRoot);
  const selectionRoot = join(resultsRoot, "selection");
  const logPath = join(selectionRoot, "run.log");
  const summaryPath = join(selectionRoot, "summary.json");
  const startedAt = new Date();
  const outcomes = [];
  await mkdir(selectionRoot, { recursive: true });
  const log = createWriteStream(logPath, { flags: "w" });
  const emit = (chunk, target) => { target.write(chunk); log.write(chunk); };
  let exitCode = 0;

  for (const testCase of selected) {
    const caseStarted = Date.now();
    emit(`\n== ${testCase.id} ==\n$ ${testCase.command.join(" ")}\n`, process.stdout);
    const child = spawn(testCase.command[0], testCase.command.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => emit(chunk, process.stdout));
    child.stderr.on("data", (chunk) => emit(chunk, process.stderr));
    const code = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (value, signal) => resolveExit(value ?? (signal ? 128 : 1)));
    });
    outcomes.push({ case: testCase.id, command: testCase.command, durationMs: Date.now() - caseStarted, exitCode: code });
    if (code !== 0) {
      exitCode = code;
      break;
    }
  }

  const finishedAt = new Date();
  const summary = {
    architecture: nativeArchitecture(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    exitCode,
    finishedAt: finishedAt.toISOString(),
    outcomes,
    selected: selected.map((testCase) => ({ id: testCase.id, resultPath: testCase.resultPath, tags: testCase.tags })),
    startedAt: startedAt.toISOString(),
    status: exitCode === 0 ? "passed" : exitCode === 2 ? "blocked" : "failed",
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await new Promise((resolveClose) => log.end(resolveClose));
  console.log(`Selection result: ${summary.status}; summary=${summaryPath}; log=${logPath}`);
  process.exitCode = exitCode;
}

async function recordBlockedSelection(selected, problems) {
  const configuredRoot = process.env.CI_RESULTS_DIR?.trim() || "/ci-results";
  const resultsRoot = isAbsolute(configuredRoot) ? configuredRoot : resolve(process.cwd(), configuredRoot);
  const selectionRoot = join(resultsRoot, "selection");
  const now = new Date().toISOString();
  const message = `BLOCKED: selection preflight failed:\n- ${problems.join("\n- ")}\n`;
  await mkdir(selectionRoot, { recursive: true });
  await writeFile(join(selectionRoot, "run.log"), message);
  await writeFile(join(selectionRoot, "summary.json"), `${JSON.stringify({
    architecture: nativeArchitecture(),
    durationMs: 0,
    exitCode: 2,
    finishedAt: now,
    outcomes: [],
    problems,
    selected: selected.map((testCase) => ({ id: testCase.id, resultPath: testCase.resultPath, tags: testCase.tags })),
    startedAt: now,
    status: "blocked",
  }, null, 2)}\n`);
  console.error(message.trimEnd());
  process.exitCode = 2;
}

try {
  if (!actions.has(action)) {
    usage(action ? `Unknown action: ${action}` : undefined);
  } else {
    validateCatalog();
    const options = parseOptions(args);
    if (action === "check") {
      if (args.length > 0) throw new Error("check takes no options");
      console.log(`CI test catalog OK: ${testCases.length} cases, ${knownTags().size} tags`);
    } else if (action === "tags") {
      if (options.cases.length || options.excludes.length || options.tags.length) throw new Error("tags only accepts --json");
      printTags(options.json);
    } else {
      const selected = selectCases(options);
      if (action === "list") printCases(selected, options.json);
      else {
        if (options.json) throw new Error("run does not accept --json");
        if (options.cases.length === 0 && options.tags.length === 0) throw new Error("run requires at least one --case or --tag filter");
        if (selected.length === 0) throw new Error("No test cases matched; nothing was run");
        const problems = preflight(selected);
        if (problems.length > 0) await recordBlockedSelection(selected, problems);
        else await runSelected(selected);
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}

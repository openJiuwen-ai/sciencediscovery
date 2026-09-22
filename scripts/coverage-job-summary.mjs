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

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function markdownText(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/g, " ");
}

function percentage(metric) {
  if (!metric || metric.total === 0 || metric.percentage === null || metric.percentage === undefined) return "n/a";
  return `${Number(metric.percentage).toFixed(2)}% (${metric.covered}/${metric.total})`;
}

function titleCase(value) {
  const text = String(value || "").trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "Unknown";
}

function scannedGroups(document) {
  if (Array.isArray(document?.selected_groups)) return document.selected_groups;
  if (!Array.isArray(document?.groups)) return [];
  return document.groups.map((group) => typeof group === "string" ? group : group?.name).filter(Boolean);
}

function scanStatus(state) {
  if (state.skip) return "Skipped";
  if (!state.document) return "Unavailable";
  const mode = titleCase(state.document.mode || state.mode || (state.document.authoritative ? "full" : "incremental"));
  return state.outcome === "failure" ? `${mode} (failed)` : mode;
}

function detailLine(label, state) {
  if (state.skip) return `- **${label}:** Skipped — ${markdownText(state.reason || "no covered group changed")}`;
  if (!state.document) return `- **${label}:** Unavailable — ${markdownText(state.error || "summary.json was not produced")}`;
  const groups = scannedGroups(state.document);
  const groupText = groups.length > 0 ? groups.map((group) => `\`${markdownText(group)}\``).join(", ") : "none recorded";
  return `- **${label}:** ${groupText}`;
}

function scopeLine(label, state) {
  if (!state.document?.scope) return undefined;
  return `- **${label}:** ${markdownText(state.document.scope)}`;
}

export function renderCoverageJobSummary({ node, python }) {
  const rows = [
    ["Node.js", node],
    ["Python", python],
  ].map(([label, state]) => [
    label,
    scanStatus(state),
    state.document?.files ?? "—",
    state.document ? scannedGroups(state.document).length : "—",
    percentage(state.document?.totals?.lines),
    percentage(state.document?.totals?.branches),
    percentage(state.document?.totals?.functions),
  ]);

  const lines = [
    "## Coverage summary",
    "",
    "Coverage is informational. **No minimum percentage is enforced.**",
    "",
    "| Runtime | Scan | Files measured | Groups measured | Lines | Branches | Functions |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((row) => `| ${row.map(markdownText).join(" | ")} |`),
    "",
    "### Scanned groups",
    "",
    detailLine("Node.js", node),
    detailLine("Python", python),
  ];

  const scopes = [scopeLine("Node.js scope", node), scopeLine("Python scope", python)].filter(Boolean);
  if (scopes.length > 0) lines.push("", "### Scope notes", "", ...scopes);
  return `${lines.join("\n")}\n`;
}

async function loadState({ path, skip, reason, mode, outcome, scopeOutcome }) {
  if (skip) return { document: undefined, mode, outcome, reason, skip: true };
  try {
    return {
      document: JSON.parse(await readFile(path, "utf8")),
      mode,
      outcome,
      reason,
      skip: false,
    };
  } catch (error) {
    let message = scopeOutcome !== "success"
      ? "coverage scope selection did not complete"
      : outcome === "failure"
        ? "coverage generation failed before a readable summary was produced"
        : outcome === "skipped"
          ? "coverage generation did not run"
          : "summary.json was not produced";
    if (error instanceof SyntaxError) message = "summary.json was not valid JSON";
    return { document: undefined, error: message, mode, outcome, reason, skip: false };
  }
}

function selected(value) {
  return String(value || "").toLowerCase() === "true";
}

async function main() {
  const scopeOutcome = process.env.COVERAGE_SCOPE_OUTCOME || "unknown";
  const [node, python] = await Promise.all([
    loadState({
      mode: process.env.NODE_COVERAGE_MODE,
      outcome: process.env.NODE_COVERAGE_OUTCOME,
      path: resolve("coverage/summary.json"),
      reason: process.env.NODE_COVERAGE_REASON,
      scopeOutcome,
      skip: selected(process.env.NODE_COVERAGE_SKIP),
    }),
    loadState({
      mode: process.env.PYTHON_COVERAGE_MODE,
      outcome: process.env.PYTHON_COVERAGE_OUTCOME,
      path: resolve("coverage/python/summary.json"),
      reason: process.env.PYTHON_COVERAGE_REASON,
      scopeOutcome,
      skip: selected(process.env.PYTHON_COVERAGE_SKIP),
    }),
  ]);
  process.stdout.write(renderCoverageJobSummary({ node, python }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

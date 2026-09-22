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


// Render the Coverage job's run-page summary from the summaries
// `coverage-report.mjs` merged. Every number here was recorded by the UT job
// while it ran the plan; this job ran nothing, and the page says so.

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

function measuredGroups(document) {
  if (Array.isArray(document?.selected_groups)) return document.selected_groups;
  if (!Array.isArray(document?.groups)) return [];
  return document.groups.map((group) => typeof group === "string" ? group : group?.name).filter(Boolean);
}

/** Where a row's numbers came from, in the terms a reader of the run page needs. */
function source(state, producer) {
  if (!state.document) return "Unavailable";
  return producer === "success" ? "UT run" : "UT run (partial)";
}

function detailLine(label, state, producer) {
  if (state.document) {
    const groups = measuredGroups(state.document);
    return `- **${label}:** ${groups.length > 0 ? groups.map((group) => `\`${markdownText(group)}\``).join(", ") : "none recorded"}`;
  }
  const reason = state.error
    || (producer === "success"
      ? "the UT job passed but no coverage for this runtime reached this job"
      : `the UT job ended \`${markdownText(producer || "unknown")}\` before it uploaded coverage for this runtime; nothing was re-run to fill the gap`);
  return `- **${label}:** Unavailable — ${reason}`;
}

function runLine(document) {
  const run = document?.run;
  if (!run) return undefined;
  const counts = ["planned", "executed", "passed", "failed", "skipped"].map((key) => `${key} ${run[key] ?? "?"}`).join(", ");
  const plan = run.plan_digest ? ` (plan \`${String(run.plan_digest).slice(0, 12)}\`)` : "";
  return `UT run: profile \`${markdownText(run.profile ?? "query")}\`, slice \`${markdownText(run.slice ?? "?")}\` — ${counts}${plan}.`;
}

export function renderCoverageJobSummary({ node, python, producer = "success" }) {
  const rows = [
    ["Node.js", node],
    ["Python", python],
  ].map(([label, state]) => [
    label,
    source(state, producer),
    state.document?.files ?? "—",
    state.document ? measuredGroups(state.document).length : "—",
    percentage(state.document?.totals?.lines),
    percentage(state.document?.totals?.branches),
  ]);

  const lines = [
    "## Coverage summary",
    "",
    "Coverage is informational. **No minimum percentage is enforced.**",
    "",
    "Recorded by the UT job while it ran the plan. This job merges what that run uploaded and executes no tests.",
  ];
  const run = runLine(node.document) ?? runLine(python.document);
  if (run) lines.push("", run);
  if (producer !== "success") {
    lines.push("", `> **The UT job did not pass (\`${markdownText(producer || "unknown")}\`).** The figures below cover only what it uploaded; nothing was re-run to fill the gap. The UT job's own result is the signal.`);
  }
  lines.push(
    "",
    "| Runtime | Source | Files measured | Groups measured | Lines | Branches |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...rows.map((row) => `| ${row.map(markdownText).join(" | ")} |`),
    "",
    "### Measured groups",
    "",
    detailLine("Node.js", node, producer),
    detailLine("Python", python, producer),
    "",
    "ST and the mocked browser E2E load no product module into a measured process, so they contribute no module coverage.",
  );
  return `${lines.join("\n")}\n`;
}

async function loadState(path) {
  try {
    return { document: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { document: undefined };
    return { document: undefined, error: error instanceof SyntaxError ? "summary.json was not valid JSON" : String(error.message ?? error) };
  }
}

async function main() {
  const [node, python] = await Promise.all([
    loadState(resolve("coverage/summary.json")),
    loadState(resolve("coverage/python/summary.json")),
  ]);
  process.stdout.write(renderCoverageJobSummary({ node, python, producer: process.env.UT_RESULT || "unknown" }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

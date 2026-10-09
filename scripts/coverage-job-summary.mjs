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


// Render the Coverage job's run-page summary from what `coverage-report.mjs`
// merged. Every number was recorded by the UT and ST jobs while they ran the
// plan; this job ran nothing, and the page says so.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LAYERS = ["ut", "st"];

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

/** How a layer's job ended and what that means for the numbers beside it. */
function runCell(name, info, producer) {
  const result = info?.producer ?? producer ?? "unknown";
  const run = info?.run;
  const counts = run ? ` — ${run.planned} planned, ${run.executed} executed, ${run.passed} passed, ${run.failed} failed, ${run.skipped} skipped` : "";
  if (!run && !info?.node && !info?.python) return `${result}; uploaded no coverage`;
  if (result !== "success") return `${result}; partial upload${counts}`;
  return `${result}${counts}`;
}

function pythonProcesses(info) {
  const processes = info?.processes;
  if (!processes) return "—";
  if (processes.started === 0) return "none started";
  return `${processes.started} started, ${processes.measured} measured`;
}

export function renderCoverageJobSummary({ node, python, layers = {}, producers = {} }) {
  const lines = [
    "## Coverage summary",
    "",
    "Coverage is informational. **No minimum percentage is enforced.**",
    "",
    "Recorded by the UT and ST jobs while they ran the plan. This job merges what they uploaded and executes no tests. The mocked browser E2E is not measured.",
    "",
    "### Merged (UT + ST)",
    "",
    "| Runtime | Files measured | Groups measured | Lines | Branches |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...[["Node.js", node], ["Python", python]].map(([label, document]) => `| ${[
      label,
      document?.files ?? "—",
      document ? measuredGroups(document).length : "—",
      percentage(document?.totals?.lines),
      percentage(document?.totals?.branches),
    ].map(markdownText).join(" | ")} |`),
    "",
    "### By layer",
    "",
    "| Layer | Job | Node.js lines | Python lines | Python processes |",
    "| --- | --- | ---: | ---: | --- |",
    ...LAYERS.map((name) => {
      const info = layers[name];
      return `| ${[
        name.toUpperCase(),
        runCell(name, info, producers[name]),
        percentage(info?.node?.totals?.lines),
        percentage(info?.python?.totals?.lines),
        pythonProcesses(info),
      ].map(markdownText).join(" | ")} |`;
    }),
  ];

  const failed = LAYERS.filter((name) => (layers[name]?.producer ?? producers[name] ?? "success") !== "success");
  if (failed.length > 0) {
    lines.push("", `> **${failed.map((name) => `${name.toUpperCase()} (\`${markdownText(layers[name]?.producer ?? producers[name])}\`)`).join(" and ")} did not pass.** Their rows cover only what they uploaded; nothing was re-run to fill the gap. The jobs' own results are the signal.`);
  }

  const groupLine = (label, document) => {
    const groups = measuredGroups(document);
    return `- **${label}:** ${groups.length > 0 ? groups.map((group) => `\`${markdownText(group)}\``).join(", ") : "none"}`;
  };
  lines.push("", "### Measured groups", "", groupLine("Node.js", node), groupLine("Python", python));

  const unmeasured = LAYERS.flatMap((name) => (layers[name]?.processes?.unmeasured ?? []).map((entry) => ({ ...entry, layer: name })));
  if (unmeasured.length > 0) {
    lines.push("", "### Python processes that could not be measured", "");
    for (const entry of unmeasured) {
      // What the process was doing tells a reader whether anything was lost.
      const example = Array.isArray(entry.example) ? entry.example.join(" ").replaceAll(/\s+/g, " ").slice(0, 90) : "";
      lines.push(`- ${entry.layer.toUpperCase()}: ${entry.count} × \`${markdownText(entry.executable)}\` — ${markdownText(entry.status)}${example ? `, e.g. \`${markdownText(example)}\`` : ""}`);
    }
  }
  const problems = LAYERS.flatMap((name) => (layers[name]?.problems ?? []).map((problem) => `${name.toUpperCase()}: ${problem}`));
  if (problems.length > 0) lines.push("", "### Problems", "", ...problems.map((problem) => `- ${markdownText(problem)}`));
  return `${lines.join("\n")}\n`;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function main() {
  const [node, python, layers] = await Promise.all([
    readJson(resolve("coverage/summary.json")),
    readJson(resolve("coverage/python/summary.json")),
    readJson(resolve("coverage/layers.json")),
  ]);
  process.stdout.write(renderCoverageJobSummary({
    node, python, layers: layers ?? {},
    producers: { ut: process.env.UT_RESULT, st: process.env.ST_RESULT },
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

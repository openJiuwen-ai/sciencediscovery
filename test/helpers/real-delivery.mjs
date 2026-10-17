// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
/** The last chat reply is retained for diagnostics, not used to select Artifact versions. */
export function finalAnswer(run, messages) {
  const message = messages.find(m => m.id === run.assistantMessageId && m.role === "assistant");
  const rawAnswer = typeof message?.content === "string" ? message.content
    : Array.isArray(message?.content) ? message.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";
  try { return decodeURIComponent(rawAnswer); } catch { return rawAnswer; }
}

export function deliveryStatus(runStatus, delivered) {
  return delivered.length ? runStatus === "completed" ? "passed" : "partial" : "failed";
}

/** Keep run errors separate from artifact read errors in CI diagnostics. */
export function deliveryFailureMessage(delivery) {
  const fields = [
    "Main run must complete with readable, nonempty declared final artifacts",
    `delivery_status=${delivery.status}`,
    `run_status=${delivery.run_status}`,
    `delivered_artifacts=${delivery.artifacts.length}`,
    `run_error=${delivery.run_error ?? "none"}`,
  ];
  if (delivery.errors.length) fields.push(`artifact_errors=${JSON.stringify(delivery.errors)}`);
  return fields.join("; ");
}

/**
 * Select the latest declaration of each Artifact ID and logical name in this
 * task's main Run chain. Child versions follow parentTurnId to their Run.
 * A later Run declaring another file does not erase earlier deliverables.
 * A broken newer declaration of the same name never falls back to an old one.
 */
export function selectFinalOutputs(outputs, runIds, subagents) {
  const runSet = new Set(runIds);
  const parentTurnBySubagentId = new Map(subagents.map(child => [child.id, child.parentTurnId]));
  const byId = new Map();
  const runOrder = new Map(runIds.map((id, index) => [id, index]));
  const newer = (item, previous) => !previous || item.order > previous.order
    || (item.order === previous.order && (item.output.version.version > previous.output.version.version
      || (item.output.version.version === previous.output.version.version
        && item.output.version.createdAt > previous.output.version.createdAt)));
  const rootRunId = (turnId) => {
    const visited = new Set();
    let current = turnId;
    while (current && !visited.has(current)) {
      if (runSet.has(current)) return current;
      visited.add(current);
      current = parentTurnBySubagentId.get(current);
    }
    return undefined;
  };
  for (const output of outputs) {
    const runId = rootRunId(output.version.turnId);
    if (!runId) continue;
    const item = { output, runId, order: runOrder.get(runId) };
    if (newer(item, byId.get(output.artifact.id))) byId.set(output.artifact.id, item);
  }
  // A renamed Artifact keeps one identity; a new Artifact reusing a name
  // replaces the earlier name mapping rather than reviving its old version.
  const byName = new Map();
  for (const item of byId.values()) {
    const name = item.output.artifact.name ?? item.output.artifact.logicalName ?? item.output.artifact.id;
    if (newer(item, byName.get(name))) byName.set(name, item);
  }
  const versions = [...byName.values()];
  const latest = versions.reduce((last, item) => item.order > (last?.order ?? -1) ? item : last, undefined);
  return { selected: versions.map(item => item.output), producerRunId: latest?.runId,
    producerRunIds: Object.fromEntries(versions.map(item => [item.output.version.id, item.runId])),
    errors: versions.length ? [] : ["No declared Artifact from this Run chain"] };
}

/** Resolve outputs explicitly required by a benchmark, allowing nested paths. */
export function requiredArtifacts(artifacts, names) {
  const found = new Map();
  const missing = [];
  for (const name of names) {
    const matches = artifacts.filter(a => a.logicalName === name || a.logicalName.endsWith(`/${name}`));
    // A main-workspace handoff takes precedence over child workspace copies.
    const main = matches.filter(a => !a.logicalName.startsWith("subagents/"));
    const candidates = main.length ? main : matches;
    const lastOrder = candidates.reduce((order, a) => Math.max(order, a.producerRunOrder ?? -1), -1);
    const latest = candidates.filter(a => (a.producerRunOrder ?? -1) === lastOrder);
    if (latest.length === 1) found.set(name, latest[0]);
    else missing.push(name);
  }
  return { found, missing };
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A sentence-ending period is punctuation; a period starting another extension is part of the name.
const mentions = (text, value) => !!value && new RegExp(
  `(?<![\\p{L}\\p{N}_.-])${escape(value)}(?![\\p{L}\\p{N}_-]|\\.(?=[\\p{L}\\p{N}_-]))`, "u",
).test(text);

/** An alternate report name is accepted only when the producing Run explicitly hands it off. */
export function finalReportArtifact(artifacts, expectedName, producerAnswer) {
  const named = requiredArtifacts(artifacts, [expectedName]);
  const exact = named.missing.length ? undefined : named.found.get(expectedName);
  const reports = artifacts.filter(a => /\.(md|txt)$/i.test(a.logicalName));
  const counts = new Map();
  for (const report of reports) {
    const base = report.logicalName.split("/").at(-1);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const referenced = reports.filter(a => {
    const base = a.logicalName.split("/").at(-1);
    const answer = a.producerAnswer ?? producerAnswer;
    return mentions(answer, a.version)
      || mentions(answer, a.logicalName) || (counts.get(base) === 1 && mentions(answer, base));
  });
  if (!referenced.length) return exact;
  // An official named report remains authoritative unless a later Run
  // explicitly hands off another file as its final report. Mentioning notes
  // elsewhere in a reply, even alongside "final report", is insufficient.
  const reportMarker = "(?:final\\s+(?:report|article|output)|(?:最终|正式)(?:报告|产物|输出)|(?:报告|文章|交付)\\s*[:：])";
  const explicit = referenced.filter(a => {
    const answer = a.producerAnswer ?? producerAnswer;
    const base = a.logicalName.split("/").at(-1);
    const names = [a.logicalName, a.version, ...(counts.get(base) === 1 ? [base] : [])];
    // Stop at a sentence-ending period, but allow relative paths such as ./results/report.md.
    return names.some(name => new RegExp(
      `${reportMarker}(?:(?!\\.(?:\\s|$)|[。;；!?\\n])[\\s\\S]){0,100}${escape(name)}(?![\\p{L}\\p{N}_-]|\\.(?=[\\p{L}\\p{N}_-]))`,
      "iu",
    ).test(answer));
  });
  if (exact && !explicit.some(a => (a.producerRunOrder ?? 0) > (exact.producerRunOrder ?? 0))) return exact;
  // Without the official name, an incidental file mention cannot establish
  // that an alternate text file is the final report.
  const candidates = explicit;
  const lastOrder = candidates.reduce((max, a) => Math.max(max, a.producerRunOrder ?? 0), 0);
  const latest = candidates.filter(a => (a.producerRunOrder ?? 0) === lastOrder);
  return latest.length === 1 ? latest[0] : undefined;
}

/** Choose an official named scoring input when available; never silently choose among unrelated reports. */
export function scoringArtifact(artifacts, expectedName) {
  const named = artifacts.filter(a => a.logicalName === expectedName || a.logicalName.endsWith(`/${expectedName}`));
  if (named.length === 1) return named[0];
  const reports = artifacts.filter(a => /\.(md|txt)$/i.test(a.logicalName));
  return reports.length === 1 ? reports[0] : undefined;
}

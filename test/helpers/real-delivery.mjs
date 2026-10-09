// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text, value) => !!value && new RegExp(`(?<![\\p{L}\\p{N}_.-])${escape(value)}(?![\\p{L}\\p{N}_.-])`, "u").test(text);

/** References are taken only from this run's final assistant message, never its intermediate tools. */
export function finalReferences(run, messages, artifacts) {
  const message = messages.find(m => m.id === run.assistantMessageId && m.role === "assistant");
  const rawAnswer = typeof message?.content === "string" ? message.content
    : Array.isArray(message?.content) ? message.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";
  let answer = rawAnswer;
  try { answer = decodeURIComponent(rawAnswer); } catch { /* Plain text containing a percent sign. */ }
  const basenameCounts = new Map();
  for (const a of artifacts) {
    const base = a.logicalName.split("/").at(-1);
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
  }
  const selected = artifacts.filter(a => mentions(answer, a.id) || (a.versions ?? []).some(v => mentions(answer, v.id)) || mentions(answer, a.logicalName) ||
    (basenameCounts.get(a.logicalName.split("/").at(-1)) === 1 && mentions(answer, a.logicalName.split("/").at(-1))));
  return { answer, selected };
}

export function deliveryStatus(runStatus, delivered) {
  return delivered.length ? runStatus === "completed" ? "passed" : "partial" : "failed";
}

/** Choose an official named scoring input when available; never silently choose among unrelated reports. */
export function scoringArtifact(artifacts, expectedName) {
  const named = artifacts.filter(a => a.logicalName === expectedName || a.logicalName.endsWith(`/${expectedName}`));
  if (named.length === 1) return named[0];
  const reports = artifacts.filter(a => /\.(md|txt)$/i.test(a.logicalName));
  return reports.length === 1 ? reports[0] : undefined;
}

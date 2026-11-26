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

import type { SubagentStep } from "../api/types.js";
import { TEXT } from "../text.js";
import { parseToolResultSections, type ToolResultSection } from "./tool-io.js";

/**
 * What one tool step of a subagent's record shows a reader (#1431).
 *
 * A step keeps three separate things: the result text the model received, the
 * intermediate output captured while it ran, and the complete result details
 * retained for audit. They answer different questions, and drawing them one
 * after another in a single box made the audit identifiers look like command
 * output and printed the same streamed line twice.
 *
 * This projection keeps them apart:
 *
 * - `output` is only what the reader can act on, split by the runner's own
 *   `stdout:` / `stderr:` / `created files:` labels;
 * - `progress` is the captured stream, kept only while it is still information
 *   the result does not already carry;
 * - `actionable` is the subset of the audit record worth reading without
 *   opening it;
 * - `audit` is the rest, drawn folded: the execution envelope (or the fragment
 *   the output bound cut it down to) and the whole `details` object, unchanged,
 *   so nothing is dropped.
 *
 * The model-facing result (`step.content`) and the stored audit record are
 * never rewritten here; this is a display projection only.
 */
export interface SubagentToolStepView {
  /** Actionable facts lifted out of the audit record, shown in the output. */
  actionable: StepActionableField[];
  /** The complete record behind the folded audit block, never discarded. */
  audit: StepAuditEntry[];
  /** The ordinary result, split by the runner's own section labels. */
  output: ToolResultSection[];
  /** Captured intermediate output, shown only when it adds a record. */
  progress?: string;
  /** Completion status the execution envelope carried, e.g. `Completed · exit 0`. */
  summary?: string;
}

export type StepActionableFieldId = "createdFiles" | "error" | "instruction" | "networkDeniedHosts" | "recovery";

/** One field of the audit record a reader may need to act on. */
export interface StepActionableField {
  content: string;
  id: StepActionableFieldId;
  label: string;
}

export type StepAuditEntryId = "details" | "result";

/** One complete part of the audit record, kept for the folded block. */
export interface StepAuditEntry {
  id: StepAuditEntryId;
  label: string;
  value: unknown;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

/** The object a complete JSON line holds, when the line is one. */
function jsonObjectLine(line: string): JsonRecord | undefined {
  const text = line.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Whether a parsed object is the shell execution envelope.
 *
 * `run_shell` writes one JSON line describing the run ahead of
 * `stdout:`/`stderr:` (`shellExecutionModelText`). The minimal envelope the
 * issue reproduces, `{"state":"completed","exitCode":0}`, names no execution
 * id and is accepted too: it still describes the run rather than its output.
 */
function isExecutionEnvelope(record: JsonRecord): boolean {
  if (typeof record.state !== "string" || !EXECUTION_STATES.has(record.state)) return false;
  return typeof record.executionId === "string" || typeof record.exitCode === "number";
}

/**
 * The shell tool, and only the shell tool, writes this envelope as a header
 * above its streams.
 *
 * Other tools return the same identifiers as their own result — `timer_create`
 * a timer carrying `executionId` and `state: "pending"`, `execution_status`
 * the status view — and folding those would hide a legitimate JSON result from
 * the ordinary output. They keep rendering as their result.
 */
const EXECUTION_ENVELOPE_TOOL = "run_shell";

/**
 * When the output bound cuts the metadata line open, what is left no longer
 * parses: it opens with a `{` and still carries an `executionId` (or, in a
 * minimal envelope, a `state`). The cut is decided by the failed parse, never
 * by the last character: the head size is a **byte** slice, so it can land
 * exactly on a nested `}` (`..."recovery":{...}}` losing only the outer
 * brace), leaving text that ends in a brace yet is not a JSON object.
 */
const ENVELOPE_FRAGMENT = /"(?:executionId|state)"\s*:/u;

function looksLikeEnvelopeFragment(line: string): boolean {
  const text = line.trim();
  return text.startsWith("{") && ENVELOPE_FRAGMENT.test(text);
}

/** The states an execution envelope reports; a JSON result using another
 *  `state` is some tool's own payload, not this header. */
const EXECUTION_STATES: ReadonlySet<string> = new Set([
  "queued", "running", "completed", "failed", "cancelled", "unknown",
]);

interface EnvelopeSplit {
  envelope?: JsonRecord;
  sections: ToolResultSection[];
  /** The metadata line the output bound cut before it could be read. */
  truncated?: string;
}

function withoutEnvelopeLine(first: ToolResultSection, lines: string[], sections: ToolResultSection[]): ToolResultSection[] {
  const residual = lines.join("\n").trim();
  return residual === "" ? sections.slice(1) : [{ ...first, content: residual }, ...sections.slice(1)];
}

/**
 * Move the envelope out of the residual text, keeping every other line.
 *
 * Only the **first** line that opens an object is examined. A run_shell result
 * always puts the envelope there, and stopping at that position is what keeps
 * a JSON line the command printed later - `{"state":"completed","exitCode":7}`
 * on stdout, say - from being mistaken for the header and silently removed.
 * The output guard can cut that metadata line open at its byte budget, so an
 * unparseable line that looks like the envelope's own beginning is moved into
 * the audit block as a truncated record instead of being left in the output.
 */
function splitExecutionEnvelope(toolName: string | undefined, sections: ToolResultSection[]): EnvelopeSplit {
  const first = sections[0];
  if (toolName !== EXECUTION_ENVELOPE_TOOL || first === undefined || first.id !== "result") return { sections };
  const lines = first.content.split("\n");
  const index = lines.findIndex((line) => line.trim().startsWith("{"));
  if (index < 0) return { sections };
  const line = lines[index]!;
  const record = jsonObjectLine(line);
  if (record !== undefined) {
    // A complete JSON object that is not the header is the tool's own result.
    if (!isExecutionEnvelope(record)) return { sections };
    lines.splice(index, 1);
    return { envelope: record, sections: withoutEnvelopeLine(first, lines, sections) };
  }
  if (!looksLikeEnvelopeFragment(line)) return { sections };
  const truncated = line.trim();
  lines.splice(index, 1);
  return { truncated, sections: withoutEnvelopeLine(first, lines, sections) };
}

/** Text the runtime writes when a tool result carried no text of its own. */
const PLACEHOLDER_RESULT = /^Tool (?:completed|failed)$/;

function carriesCommandOutput(sections: ToolResultSection[]): boolean {
  return sections.some((section) => section.id !== "result" || !PLACEHOLDER_RESULT.test(section.content.trim()));
}

/**
 * The captured stream, or nothing when the result already says the same thing.
 *
 * While a step runs, progress is the only output there is. Once it completes,
 * a shell step keeps both the terminal result and the captured stream, and the
 * streamed stdout is inside both — printing it again under the same heading is
 * the duplicate reported in #1431. A completed step therefore keeps its
 * progress only when the result carries no command output at all (`Tool
 * completed`, an empty result) or when the captured text is not part of it; the
 * capture can be the only surviving record of what the command printed.
 */
function visibleProgress(step: SubagentStep, output: ToolResultSection[]): string | undefined {
  const progress = step.progress?.trim() ?? "";
  if (progress === "") return undefined;
  if (step.status === "running") return progress;
  if (carriesCommandOutput(output) && step.content.includes(progress)) return undefined;
  return progress;
}

function stateLabel(state: string): string {
  // The wire states the envelope uses are named in the dictionary, so a reader
  // never sees `queued` or `unknown` in a Chinese panel.
  const labels: Record<string, string> = TEXT.subagent.executionState;
  return labels[state] ?? TEXT.subagent.executionState.unknown;
}

/** `Completed · exit 0`, so the ordinary output still says how the run ended. */
function executionSummary(facts: JsonRecord | undefined): string | undefined {
  if (facts === undefined) return undefined;
  const parts: string[] = [];
  const state = facts.state;
  if (typeof state === "string" && state !== "") parts.push(stateLabel(state));
  if (typeof facts.exitCode === "number") parts.push(TEXT.subagent.exitCode(facts.exitCode));
  if (typeof facts.finalization === "string" && facts.finalization !== "committed") {
    const labels: Record<string, string> = TEXT.subagent.finalization;
    const label = labels[facts.finalization];
    if (label !== undefined) parts.push(label);
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/**
 * The facts the completion line is built from.
 *
 * The audit copy is the complete record, so its `state`, `exitCode` and
 * `finalization` win field by field: the bounded result can lose the envelope
 * entirely, and a metadata line the output guard cut open cannot say how the
 * run ended. Only the shell tool has this record; for any other tool `details`
 * is that tool's own result, never a completion line.
 */
function executionFacts(step: SubagentStep, envelope: JsonRecord | undefined): JsonRecord | undefined {
  if (step.toolName !== EXECUTION_ENVELOPE_TOOL) return undefined;
  const details = asRecord(step.details);
  if (details === undefined) return envelope;
  const facts: JsonRecord = {};
  for (const key of ["state", "exitCode", "finalization"] as const) {
    const value = details[key] ?? envelope?.[key];
    if (value !== undefined) facts[key] = value;
  }
  return Object.keys(facts).length === 0 ? undefined : facts;
}

function compact(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A list as one entry per line, or nothing when it carries no entry. */
function listText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(compact).filter((item) => item.trim() !== "");
  return items.length === 0 ? undefined : items.join("\n");
}

/**
 * A field's text, or nothing when it is empty. Empty strings, empty lists and
 * empty objects are bookkeeping, not information: a reader learns nothing from
 * them and the default recovery object adds a line to every step.
 */
function fieldText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (Array.isArray(value)) return listText(value);
  if (value !== null && typeof value === "object") {
    const text = compact(value);
    return text === "{}" || text === "[]" ? undefined : text;
  }
  return value === null || value === undefined ? undefined : String(value);
}

/**
 * `unknownRecovery()`: the adapter reported no recovery capability at all
 * (`{ capability: "unknown", reason: "NOT_REPORTED" }`), which is the default
 * on every execution and says nothing about this one. Anything else — a
 * supported adapter, or an unknown one with a concrete reason — is kept.
 */
function isDefaultRecovery(value: unknown): boolean {
  const record = asRecord(value);
  if (record === undefined) return false;
  return record.capability === "unknown" && (record.reason === undefined || record.reason === "NOT_REPORTED");
}

function firstDefined(sources: JsonRecord[], key: string): unknown {
  for (const source of sources) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

/**
 * The fields worth reading without opening the audit block. `details` is the
 * audit copy, so it wins; the envelope is the same data the model received and
 * fills in whatever the audit copy omitted.
 */
function actionableFields(sources: JsonRecord[], output: ToolResultSection[]): StepActionableField[] {
  const fields: StepActionableField[] = [];
  const instruction = fieldText(firstDefined(sources, "instruction"));
  if (instruction !== undefined) {
    fields.push({ content: instruction, id: "instruction", label: TEXT.subagent.fieldInstruction });
  }
  const error = fieldText(firstDefined(sources, "error"));
  if (error !== undefined) fields.push({ content: error, id: "error", label: TEXT.conversation.toolError });
  const denied = fieldText(firstDefined(sources, "networkDeniedHosts"));
  if (denied !== undefined) {
    fields.push({ content: denied, id: "networkDeniedHosts", label: TEXT.subagent.fieldNetworkDeniedHosts });
  }
  // A created-files section is already labelled in the output; promoting the
  // same list again would print it twice under one heading.
  if (!output.some((section) => section.id === "created-files")) {
    const created = fieldText(firstDefined(sources, "createdFiles"));
    if (created !== undefined) {
      fields.push({ content: created, id: "createdFiles", label: TEXT.subagent.fieldCreatedFiles });
    }
  }
  const recovery = firstDefined(sources, "recovery");
  if (recovery !== undefined && !isDefaultRecovery(recovery)) {
    const content = fieldText(recovery);
    if (content !== undefined) {
      fields.push({ content, id: "recovery", label: TEXT.subagent.fieldRecovery });
    }
  }
  return fields;
}

export function subagentToolStepView(step: SubagentStep): SubagentToolStepView {
  const content = step.content.trim();
  const parsed = content === "" ? [] : parseToolResultSections(content, step.status ?? "completed");
  const { envelope, sections: output, truncated } = splitExecutionEnvelope(step.toolName, parsed);
  const progress = visibleProgress(step, output);
  const summary = executionSummary(executionFacts(step, envelope));
  const sources = [asRecord(step.details), envelope].filter((source): source is JsonRecord => source !== undefined);
  const audit: StepAuditEntry[] = [];
  if (envelope !== undefined) audit.push({ id: "result", label: TEXT.subagent.auditResult, value: envelope });
  else if (truncated !== undefined) audit.push({ id: "result", label: TEXT.subagent.auditResult, value: truncated });
  if (step.details !== undefined) audit.push({ id: "details", label: TEXT.subagent.auditDetails, value: step.details });
  return {
    actionable: actionableFields(sources, output),
    audit,
    output,
    ...(progress === undefined ? {} : { progress }),
    ...(summary === undefined ? {} : { summary }),
  };
}

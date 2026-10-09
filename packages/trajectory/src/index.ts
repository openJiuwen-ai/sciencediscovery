// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** Browser-safe contracts; the host owns authentication and Session authorization. */
export type TrajectoryKind = "state" | "input" | "output" | "thinking" | "tool" | "mcp" | "lifecycle";
export interface TrajectoryAgent { id: string; label: string; parentId?: string; parentRunId?: string }
export interface TrajectoryEntry {
  id: string; agentId: string; kind: TrajectoryKind; label: string;
  timestamp: string | null; endTime?: string; contextId?: string; runId?: string; turn?: number;
  sequence?: number; streamId?: string; requestExecutionId?: string;
  eventType?: string; status?: string;
}
export interface TrajectoryIndex {
  schemaVersion: 1; sessionId: string; capturedAt: string;
  agents: TrajectoryAgent[]; entries: TrajectoryEntry[]; warnings: string[];
  /** @deprecated Compatibility alias of untimedEntries; not superseded versions. */
  historicalEntries?: TrajectoryEntry[];
  /** Records without a reliable event timestamp; not superseded versions. */
  untimedEntries?: TrajectoryEntry[];
}
export interface ContextBlock {
  id: string; kind: string; source: string; content: string;
  attribution: "recorded" | "unavailable";
}
export interface TrajectoryDetail {
  entry: TrajectoryEntry; value: unknown;
  context?: { input: unknown; blocks: ContextBlock[]; assembly: unknown; state: unknown };
}
export interface TrajectoryPort {
  index(sessionId: string, signal: AbortSignal): Promise<TrajectoryIndex>;
  detail(sessionId: string, id: string, signal: AbortSignal): Promise<TrajectoryDetail>;
  export(sessionId: string, signal: AbortSignal): Promise<Blob>;
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function text(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? ""; }

/** Color only content actually sent. Pre-budget proposals stay in the assembly record. */
export function contextBlocks(inputValue: unknown, assemblyValue: unknown): ContextBlock[] {
  const input = object(inputValue), trace = object(object(assemblyValue).trace);
  const admitted = object(trace.admitted), rendered = object(trace.renderedContext ?? trace.rendered);
  const sections = Array.isArray(admitted.sections) ? admitted.sections.map(object) : [];
  const ids = Array.isArray(rendered.sectionIds) ? rendered.sectionIds : [];
  const ordered = ids.map(id => sections.find(s => s.id === id)).filter((s): s is Record<string, unknown> => !!s && typeof s.content === "string" && s.content.length > 0);
  // What makes the blocks trustworthy is the equality below: the sections the record kept,
  // concatenated, are byte for byte what was sent. `selectedPath` only names who assembled
  // them — the built-in loop's dynamic assembler, or an external executor that owns its own
  // loop (JiuwenSwarm), which reports the prompt it built as the single section it is.
  const assembler = trace.selectedPath ?? trace.used;
  const exact = (assembler === "dynamic" || assembler === "external") && ordered.length > 0 && ordered.map(s => s.content).join("\n") === input.systemPrompt;
  const blocks: ContextBlock[] = exact
    ? ordered.map((s, i) => ({ id: `system-${i}`, kind: String(s.slot), source: String(s.contributorId), content: String(s.content) + (i < ordered.length - 1 ? "\n" : ""), attribution: "recorded" }))
    : [{ id: "system", kind: "system", source: "systemPrompt", content: text(input.systemPrompt ?? ""), attribution: "unavailable" }];
  for (const [i, value] of (Array.isArray(input.history) ? input.history : []).entries()) {
    // Matching proposal text is not proof of origin after admission/compaction.
    blocks.push({ id: `message-${i}`, kind: String(object(value).role ?? "message"), source: "model history / context projection",
      content: text(value), attribution: "unavailable" });
  }
  for (const [i, tool] of (Array.isArray(input.tools) ? input.tools : []).entries()) {
    blocks.push({ id: `tool-${i}`, kind: "tool", source: "tool registry", content: text(tool), attribution: "recorded" });
  }
  return blocks;
}
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) =>
    [key, /^(api[_-]?key|apiToken|access[_-]?token|refresh[_-]?token|authorization|password|secret|clientSecret|cookie|set-cookie)$/i.test(key) ? "[REDACTED]" : redact(child)]));
  return value;
}
export function eventKind(value: unknown): TrajectoryKind {
  const event = object(value), type = String(event.type ?? ""), step = object(event.step);
  if (type === "context.captured") return "input";
  if (type === "model.completed") return "output";
  if (type.includes("thinking") || event.kind === "thinking" || step.kind === "thinking") return "thinking";
  if (type.includes("mcp")) return "mcp";
  if (type.includes("tool") || step.kind === "tool") {
    const trace = object(event.trace ?? event.call ?? step.toolTrace);
    return trace.mcp || String(trace.name ?? trace.tool ?? "").startsWith("mcp") ? "mcp" : "tool";
  }
  if (type.includes("assistant") || type === "model_delta" || type === "text_delta" || step.kind === "assistant") return "output";
  if (type.includes("state") || type.includes("plan") || type.includes("phase")) return "state";
  return "lifecycle";
}

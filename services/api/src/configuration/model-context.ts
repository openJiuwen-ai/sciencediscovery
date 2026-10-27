// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { AgentHistoryMessage } from "@sciencediscovery/orchestration";
import { CONFIGURATION_CONTEXT_LIMITS } from "./context-budget.js";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** Model-history projection only. Raw tool events/CAS records are not edited. */
export function projectConfigurationHistory(history: readonly AgentHistoryMessage[]): AgentHistoryMessage[] {
  const calls = new Set<string>();
  const queries: Array<{ index: number; value: Record<string, unknown> }> = [];
  const proposed = new Map<string, number>();
  let lastUser = -1;
  for (const [index, message] of history.entries()) {
    if (message.role === "user") lastUser = index;
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) for (const call of message.tool_calls) {
      if (record(call) && typeof call.id === "string" && record(call.function) && call.function.name === "configuration") calls.add(call.id);
    }
    if (message.role === "assistant" && Array.isArray(message.response_items)) for (const item of message.response_items) {
      if (record(item) && item.type === "function_call" && item.name === "configuration" && typeof item.call_id === "string") calls.add(item.call_id);
    }
    if (message.role !== "tool" || typeof message.tool_call_id !== "string" || !calls.has(message.tool_call_id) || typeof message.content !== "string") continue;
    let value: unknown;
    try { value = JSON.parse(message.content); } catch { continue; }
    if (!record(value)) continue;
    if (value.action === "propose" && typeof value.capabilityId === "string" && (typeof value.requestId === "string" || value.status === "already_effective")) proposed.set(value.capabilityId, index);
    if ((value.action === "search" || value.action === "describe") && !value.detailsElided) queries.push({ index, value });
  }
  const recent = new Set(queries.slice(-2).map(item => item.index));
  const replacements = new Map<number, string>();
  for (const { index, value } of queries) {
    const ids = typeof value.capabilityId === "string" ? [value.capabilityId]
      : Array.isArray(value.items) ? [...new Set(value.items.filter(record).map(item => item.capabilityId).filter((id): id is string => typeof id === "string"))] : [];
    const resolved = ids.length > 0 && ids.every(id => (proposed.get(id) ?? -1) > index);
    if (recent.has(index) && index > lastUser && !resolved) continue;
    const summary: Record<string, unknown> = { action: value.action, detailsElided: true,
      ...(typeof value.capabilityId === "string" ? { capabilityId: value.capabilityId } : {}),
      ...(typeof value.query === "string" ? { query: value.query } : {}),
      ...(typeof value.targetId === "string" ? { targetId: value.targetId } : {}),
      ...(typeof value.total === "number" ? { total: value.total } : {}),
      instruction: "Discovery details were removed from model history. Repeat search/describe for current fields or resources. Existing proposals and user decisions remain authoritative." };
    if (Buffer.byteLength(JSON.stringify(summary), "utf8") > CONFIGURATION_CONTEXT_LIMITS.summary) delete summary.query;
    if (Buffer.byteLength(JSON.stringify(summary), "utf8") > CONFIGURATION_CONTEXT_LIMITS.summary) { delete summary.targetId; summary.targetInToolArguments = true; }
    replacements.set(index, JSON.stringify(summary));
  }
  return history.map((message, index) => replacements.has(index) ? { ...message, content: replacements.get(index)! } : message);
}

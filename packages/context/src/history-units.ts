// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

export interface HistoryUnit<TMessage extends RuntimeMessage> {
  /** A unit is closed only when every declared tool call has its result. */
  closed: boolean;
  messages: TMessage[];
}

function toolCallIds(message: RuntimeMessage): string[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.flatMap((call) => {
    if (typeof call !== "object" || call === null || Array.isArray(call)) return [];
    const id = (call as Record<string, unknown>).id;
    return typeof id === "string" && id ? [id] : [];
  });
}

/**
 * Split history without ever separating an assistant tool-call declaration
 * from the immediately following results. An incomplete call is deliberately
 * marked open so pressure handling cannot summarize or evict it.
 */
export function historyUnits<TMessage extends RuntimeMessage>(history: readonly TMessage[]): HistoryUnit<TMessage>[] {
  const units: HistoryUnit<TMessage>[] = [];
  for (let index = 0; index < history.length; index += 1) {
    const message = history[index]!;
    const messages = [structuredClone(message)];
    const pending = new Set(toolCallIds(message));
    while (pending.size && index + 1 < history.length) {
      const next = history[index + 1]!;
      const resultId = typeof next.tool_call_id === "string" ? next.tool_call_id : undefined;
      if (next.role !== "tool" || !resultId || !pending.has(resultId)) break;
      messages.push(structuredClone(next));
      pending.delete(resultId);
      index += 1;
    }
    units.push({ closed: pending.size === 0, messages });
  }
  return units;
}

export function flattenHistoryUnits<TMessage extends RuntimeMessage>(units: readonly HistoryUnit<TMessage>[]): TMessage[] {
  return units.flatMap((unit) => unit.messages);
}

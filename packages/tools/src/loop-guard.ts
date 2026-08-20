// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createHash } from "node:crypto";

function stableJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map((item) => stableJsonValue(item, seen));
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, stableJsonValue((value as Record<string, unknown>)[key], seen)]));
  }
  return value;
}

export type ToolLoopDecision =
  | { action: "allow"; count: number }
  | { action: "warn" | "stop"; content: string; count: number };

/** Run-scoped policy; intentionally separate from the universal Agent Loop. */
export class ToolLoopGuard {
  private readonly counts = new Map<string, number>();

  constructor(private readonly warnAt = 10, private readonly stopAt = 20) {
    if (warnAt < 1 || stopAt <= warnAt) throw new Error("Tool loop thresholds must satisfy 1 <= warnAt < stopAt");
  }

  inspect(name: string, args: Record<string, unknown>): ToolLoopDecision {
    const key = createHash("sha256").update(`${name}\n${JSON.stringify(stableJsonValue(args))}`).digest("hex");
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (count >= this.stopAt) {
      return { action: "stop", count, content: JSON.stringify({ ok: false, error: {
        attempts: count, code: "TOOL_LOOP_DETECTED", retryable: false,
        message: `Stopped repeated ${name} call with identical arguments after ${count} attempts. Do not call this same tool with the same arguments again; synthesize from existing results or choose a different action.`,
      } }) };
    }
    if (count >= this.warnAt) {
      return { action: "warn", count, content: JSON.stringify({ ok: false, warning: {
        code: "REPEATED_TOOL_CALL", count, retryable: true,
        message: `Repeated ${name} call with identical arguments detected ${count} times. Reconsider your approach, use the previous result if available, or change arguments meaningfully before retrying.`,
      } }) };
    }
    return { action: "allow", count };
  }
}

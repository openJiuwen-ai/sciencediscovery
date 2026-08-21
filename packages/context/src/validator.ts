// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ModelInput, WireToolSpec } from "@sciencediscovery/model";
import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

import type { ResolvedContextSection } from "./contributor.js";

function toolCallIds(message: RuntimeMessage): string[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.flatMap((call) => {
    if (typeof call !== "object" || call === null || Array.isArray(call)) return [];
    const id = (call as Record<string, unknown>).id;
    return typeof id === "string" && id ? [id] : [];
  });
}

export class ContextValidator<TMessage extends RuntimeMessage> {
  validate(
    input: ModelInput<TMessage>,
    protectedSections: readonly ResolvedContextSection[],
    governedTools: readonly WireToolSpec[],
  ): void {
    for (const section of protectedSections) {
      if (!input.systemPrompt.includes(section.content)) {
        throw new Error(`Context assembly dropped protected section: ${section.id}`);
      }
    }
    const expectedNames = governedTools.map((tool) => tool.name).toSorted();
    const actualNames = input.tools.map((tool) => tool.name).toSorted();
    if (new Set(actualNames).size !== actualNames.length || JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      throw new Error("Context assembly changed the governed tool set");
    }
    const calls = new Set<string>();
    for (const message of input.history) {
      for (const id of toolCallIds(message)) calls.add(id);
      if (message.role !== "tool" || typeof message.tool_call_id !== "string") continue;
      if (!calls.has(message.tool_call_id)) {
        throw new Error(`Context window contains orphan tool result: ${message.tool_call_id}`);
      }
    }
  }
}

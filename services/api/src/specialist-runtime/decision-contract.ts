// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { Value } from "typebox/value";
import type { SpecialistRuntimeRequest } from "./adapter.js";

export const platformDecisionSchema = {
  type: "object", additionalProperties: false, required: ["summary", "tools"],
  properties: {
    summary: { type: "string" },
    tools: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["tool", "arguments"],
      properties: { tool: { type: "string" }, arguments: { type: "string" } },
    } },
  },
};
export const decisionInstructions = 'Return ONLY JSON with summary and tools: an ordered array of {tool, arguments}, where arguments is a JSON-encoded object. Request all known platform calls for this turn; they execute serially in array order. Use tools=[] and summary=final answer to finish. Never use native tools. Product files are in the platform Workspace.';
export const decisionCorrection = 'Invalid platform decision (JSON, shape, unavailable platform tool or invalid platform tool arguments). Nothing from this decision was executed. Correct the entire decision once, preserving every intended legal call. Use only the listed tools and their argument schemas. Return ONLY JSON matching the decision schema.';

export class PlatformDecisionError extends Error {}

/** Validate the entire batch before any call can reach platform bindings. */
export function parsePlatformDecision(output: string, tools: SpecialistRuntimeRequest["tools"]) {
  if (output.length > 100000) throw new PlatformDecisionError("oversized JSON");
  let decision: { summary: string; tools: { tool: string; arguments: string }[] };
  try { decision = JSON.parse(output); }
  catch { throw new PlatformDecisionError("invalid JSON"); }
  if (!Value.Check(platformDecisionSchema, decision)) throw new PlatformDecisionError("invalid shape");
  const calls = decision.tools.map(call => {
    const tool = tools.find(tool => tool.name === call.tool);
    if (!tool) throw new PlatformDecisionError("unavailable platform tool");
    let args: Record<string, unknown>;
    try { args = JSON.parse(call.arguments); }
    catch { throw new PlatformDecisionError("invalid platform tool arguments"); }
    if (!Value.Check(tool.parameters, args)) throw new PlatformDecisionError("invalid platform tool arguments");
    return { tool, args };
  });
  return { summary: decision.summary, calls };
}

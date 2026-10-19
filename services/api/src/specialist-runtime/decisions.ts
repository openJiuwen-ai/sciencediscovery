// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import type { SpecialistRuntimeRequest, SpecialistEventSink, SpecialistResult } from "./adapter.js";
import { CodexRuntimeError, SpecialistUnavailableError } from "./codex.js";

export const platformDecisionSchema = {
  type: "object", additionalProperties: false, required: ["summary", "tool", "arguments"],
  properties: { summary: { type: "string" }, tool: { type: ["string", "null"] }, arguments: { type: "string" } },
};
/** Both transports are model-only. All code, files, network and artifacts use
 * validated platform tools and the child's live permission/Runner bindings. */
export async function runPlatformDecisions(request: SpecialistRuntimeRequest, sink: SpecialistEventSink,
  decide: (prompt: string) => Promise<string>, result: SpecialistResult = { summary: "", artifacts: [] }): Promise<SpecialistResult> {
  const contract = `${request.prompt}\nReturn ONLY JSON matching ${JSON.stringify(platformDecisionSchema)}. Request one platform tool or finish with tool=null. Never use native tools. Product files are in the platform Workspace.\nTools: ${JSON.stringify(request.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })))}`;
  const history: unknown[] = [];
  let dispatched = false;
  try {
    for (let turn = 0; turn < request.maxTurns; turn++) {
      request.signal.throwIfAborted();
      await sink({ type: "progress", text: `Specialist turn ${turn + 1}` });
      const output = await decide(`${contract}\nPlatform history: ${JSON.stringify(history).slice(-64000)}`);
      request.signal.throwIfAborted();
      if (output.length > 100000) throw new CodexRuntimeError("Oversized platform decision");
      let decision: { summary: string; tool: string | null; arguments: string };
      try {
        decision = JSON.parse(output);
        if (!(Value.Check(platformDecisionSchema, decision) as boolean)) throw Error();
      } catch { throw new CodexRuntimeError("Invalid platform decision"); }
      if (decision.tool === null) { result.summary = decision.summary; await sink({ type: "done", result }); return result; }
      const tool = request.tools.find(t => t.name === decision.tool);
      if (!tool) throw new SpecialistUnavailableError("Unavailable platform tool");
      let args: Record<string, unknown>;
      try { args = JSON.parse(decision.arguments); if (!Value.Check(tool.parameters, args)) throw Error(); }
      catch { throw new CodexRuntimeError("Invalid platform tool arguments"); }
      const id = randomUUID();
      await sink({ type: "tool_call", id, name: tool.name, args });
      request.signal.throwIfAborted();
      const previous: boolean = dispatched;
      dispatched ||= ["run_shell", "run_python", "run_scientific", "run_direct_shell", "declare_artifact"].includes(tool.name);
      const response = await tool.execute(id, args, request.signal);
      request.signal.throwIfAborted();
      const detail = response.details as { code?: string; dispatched?: boolean } | undefined;
      if (detail?.code === "RUNNER_UNAVAILABLE" && detail.dispatched === false) dispatched = previous;
      await sink({ type: "tool_call", id, name: tool.name, args, result: response });
      if (tool.name === "report_runtime_unavailable") throw new SpecialistUnavailableError("Required runtime tools unavailable");
      if (tool.name === "declare_artifact" && !response.isError) result.artifacts.push(response.details);
      history.push({ tool: tool.name, args, result: response });
    }
    throw new CodexRuntimeError("Specialist exceeded maximum turns");
  } catch (error) {
    request.signal.throwIfAborted();
    if (error instanceof SpecialistUnavailableError && dispatched) throw new CodexRuntimeError("Runtime stopped after platform dispatch; review before retrying");
    if (error instanceof CodexRuntimeError) throw error;
    throw new CodexRuntimeError("Platform task failed; review before retrying");
  }
}

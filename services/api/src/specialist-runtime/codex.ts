// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Codex, type CodexOptions, type ThreadOptions, type Thread } from "@openai/codex-sdk";
import { sandboxedCodex } from "./launcher.js";
import { Value } from "typebox/value";
import type { SpecialistRuntimeAdapter, SpecialistRuntimeRequest, SpecialistEventSink, SpecialistResult } from "./adapter.js";

// The SDK does not expose custom tool callbacks. Use structured decisions with
// validated platform dispatch. No execution request is sent to a Codex shell.
const decisionSchema = {
  type: "object", additionalProperties: false, required: ["summary", "tool", "arguments"],
  properties: { summary: { type: "string" }, tool: { type: ["string", "null"] }, arguments: { type: "string" } },
};
export class CodexRuntimeError extends Error {}
/** Only inability to run the runtime triggers native fallback. */
export class SpecialistUnavailableError extends CodexRuntimeError {}

export type CodexFactory = (options: CodexOptions, thread: ThreadOptions) => Pick<Thread, "runStreamed">;
const sdkFactory: CodexFactory = (options, thread) => new Codex(options).startThread(thread);

export class CodexSpecialistAdapter implements SpecialistRuntimeAdapter {
  constructor(private readonly factory: CodexFactory = sdkFactory) {}
  async invoke(request: SpecialistRuntimeRequest, sink: SpecialistEventSink): Promise<SpecialistResult> {
    request.signal.throwIfAborted();
    let apiKey: string;
    try { apiKey = await request.credential(); }
    catch { request.signal.throwIfAborted(); throw new SpecialistUnavailableError("Codex credential channel is unavailable"); }
    request.signal.throwIfAborted();
    if (request.execution === "direct") {
      if (!request.authorizeDirect) throw new CodexRuntimeError("Direct Codex execution requires separate direct_code consent");
      await request.authorizeDirect();
      request.signal.throwIfAborted();
    }
    const scratch = await mkdtemp(join(request.workspaceRoot ?? tmpdir(), ".sd-codex-"));
    let dispatched: boolean = false;
    try {
      const home = join(scratch, "home");
      const work = request.workspaceRoot ?? join(scratch, "work");
      await mkdir(home, { mode: 0o700 });
      await mkdir(work, { recursive: true });
      const codexPathOverride = this.factory === sdkFactory && request.execution !== "direct" ? await sandboxedCodex(work, scratch) : undefined;
      const startThread = () => this.factory({
        apiKey,
        ...(process.env.SCIENCE_AGENT_CODEX_BASE_URL ? { baseUrl: process.env.SCIENCE_AGENT_CODEX_BASE_URL } : {}),
        ...(codexPathOverride ? { codexPathOverride } : {}),
        // Explicit env avoids inherited provider keys, host HOME/config, MCP,
        // plugins and user Skills. The credential never enters argv or text.
        env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home },
        config: {
          ...(process.env.SCIENCE_AGENT_CODEX_BASE_URL ? {
            model_provider: "platform", model_providers: { platform: { name: "Platform Codex endpoint", base_url: process.env.SCIENCE_AGENT_CODEX_BASE_URL, env_key: "CODEX_API_KEY", wire_api: "responses", supports_websockets: false } },
          } : {}),
          features: { shell_tool: false, multi_agent: false }, developer_instructions:
          "Use only structured output to request platform tools. Native shell and file edits are unavailable. Never execute commands yourself." },
      }, { workingDirectory: work, sandboxMode: "danger-full-access", approvalPolicy: "never", skipGitRepoCheck: true,
        networkAccessEnabled: false, webSearchMode: "disabled", ...(request.model ? { model: request.model } : {}), ...(request.reasoningEffort ? { modelReasoningEffort: request.reasoningEffort } : {}) });
      let thread = startThread();
      let model = request.model;
      let reasoningEffort = request.reasoningEffort;
      const result: SpecialistResult = { summary: "", artifacts: [] };
      const contract = `${request.prompt}\n\nRequest ONE platform tool using tool and JSON-encoded arguments, or finish with tool=null and summary=final answer. All product files live in the platform Workspace, not this process directory. Tools:\n${JSON.stringify(request.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })))}`;
      let input = contract;
      const outcomes: unknown[] = [];
      for (let turn = 0; turn < request.maxTurns; turn++) {
        request.signal.throwIfAborted();
        await sink({ type: "progress", text: `Codex turn ${turn + 1}` });
        let output = "";
        let completed = false;
        const stream = await thread.runStreamed(input, { outputSchema: decisionSchema, signal: request.signal });
        for await (const event of stream.events) {
          request.signal.throwIfAborted();
          if (event.type === "thread.started") {
            result.runtimeSessionId = event.thread_id;
            await sink({ type: "started", runtimeSessionId: event.thread_id });
          }
          if (event.type === "error" || event.type === "turn.failed") throw new SpecialistUnavailableError("Codex provider request failed; check the Codex credential and model configuration");
          if (event.type === "item.completed" && event.item.type === "agent_message") output = event.item.text;
          if (event.type === "turn.completed") {
            completed = true;
            const u = event.usage;
            const prev = result.usage;
            result.usage = { inputTokens: (prev?.inputTokens ?? 0) + u.input_tokens, outputTokens: (prev?.outputTokens ?? 0) + u.output_tokens,
              totalTokens: (prev?.totalTokens ?? 0) + u.input_tokens + u.output_tokens, cacheReadTokens: (prev?.cacheReadTokens ?? 0) + u.cached_input_tokens };
          }
          // A native action signals a policy/configuration regression, never a
          // platform execution or a valid Artifact. Stop rather than adopting it.
          if ("item" in event && ["command_execution", "file_change", "mcp_tool_call"].includes(event.item.type)) {
            throw new CodexRuntimeError("Codex attempted a disabled native tool");
          }
        }
        if (!completed || output.length > 100_000) throw new CodexRuntimeError("Codex returned an incomplete or oversized decision");
        let decision: { summary: string; tool: string | null; arguments: string };
        try {
          decision = JSON.parse(output);
          if (!(Value.Check(decisionSchema, decision) as boolean)) throw new CodexRuntimeError();
        } catch { throw new CodexRuntimeError("Codex returned an invalid platform decision"); }
        if (decision.tool === null) {
          result.summary = decision.summary;
          await sink({ type: "done", result });
          return result;
        }
        const tool = request.tools.find(t => t.name === decision.tool);
        if (!tool) throw new SpecialistUnavailableError("Codex requested an unavailable platform tool");
        let args: Record<string, unknown>;
        try { args = JSON.parse(decision.arguments); } catch { throw new CodexRuntimeError("Invalid platform tool arguments"); }
        if (!Value.Check(tool.parameters, args)) throw new CodexRuntimeError("Invalid platform tool arguments");
        const id = randomUUID();
        await sink({ type: "tool_call", id, name: tool.name, args });
        request.signal.throwIfAborted();
        const previouslyDispatched: boolean = dispatched;
        dispatched ||= ["run_shell", "run_python", "run_scientific", "run_direct_shell", "declare_artifact"].includes(tool.name);
        const toolResult = await tool.execute(id, args, request.signal);
        request.signal.throwIfAborted();
        const blocked = toolResult.details as { code?: string; dispatched?: boolean } | undefined;
        if (blocked?.code === "RUNNER_UNAVAILABLE" && blocked.dispatched === false) dispatched = previouslyDispatched;
        await sink({ type: "tool_call", id, name: tool.name, args, result: toolResult });
        if (tool.name === "report_runtime_unavailable") throw new SpecialistUnavailableError("Codex cannot run with the available platform tools");
        if (tool.name === "declare_artifact" && !toolResult.isError) result.artifacts.push(toolResult.details);
        outcomes.push({ tool: tool.name, args, result: toolResult });
        if (model !== request.model || reasoningEffort !== request.reasoningEffort) {
          model = request.model; reasoningEffort = request.reasoningEffort; thread = startThread();
        }
        input = `${contract}\nPlatform tool history:\n${JSON.stringify(outcomes).slice(-64000)}\nChoose the next platform tool or finish.`;
      }
      throw new CodexRuntimeError(`Codex exceeded maximum turns (${request.maxTurns})`);
    } catch (error) {
      if (request.signal.aborted) request.signal.throwIfAborted();
      // SDK stderr/provider errors may contain credentials. Do not persist them.
      if (error instanceof CodexRuntimeError && !error.message.includes(apiKey)) {
        if (dispatched && error instanceof SpecialistUnavailableError) throw new CodexRuntimeError(error.message);
        throw error;
      }
      if (dispatched) throw new CodexRuntimeError("Codex stopped after platform work began; review the task before retrying");
      throw new SpecialistUnavailableError("Codex runtime failed; check auth/config or use builtin-code-engineer");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

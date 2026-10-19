// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Codex, type CodexOptions, type ThreadOptions, type Thread } from "@openai/codex-sdk";
import { Value } from "typebox/value";
import type { SpecialistRuntimeAdapter, SpecialistRuntimeRequest, SpecialistEventSink, SpecialistResult } from "./adapter.js";

// The SDK does not expose custom tool callbacks. Use structured decisions with
// validated platform dispatch. No execution request is sent to a Codex shell.
const decisionSchema = {
  type: "object", additionalProperties: false, required: ["summary", "tool", "arguments"],
  properties: { summary: { type: "string" }, tool: { type: ["string", "null"] }, arguments: { type: "string" } },
};
class CodexRuntimeError extends Error {}

export type CodexFactory = (options: CodexOptions, thread: ThreadOptions) => Pick<Thread, "runStreamed">;
const sdkFactory: CodexFactory = (options, thread) => new Codex(options).startThread(thread);

export class CodexSpecialistAdapter implements SpecialistRuntimeAdapter {
  constructor(private readonly factory: CodexFactory = sdkFactory) {}
  async invoke(request: SpecialistRuntimeRequest, sink: SpecialistEventSink): Promise<SpecialistResult> {
    request.signal.throwIfAborted();
    const apiKey = await request.credential();
    request.signal.throwIfAborted();
    const scratch = await mkdtemp(join(tmpdir(), "sd-codex-"));
    try {
      const home = join(scratch, "home");
      const work = join(scratch, "work");
      await mkdir(home, { mode: 0o700 });
      await mkdir(work);
      const thread = this.factory({
        apiKey,
        // Explicit env avoids inherited provider keys, host HOME/config, MCP,
        // plugins and user Skills. The credential never enters argv or text.
        env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home },
        config: { features: { shell_tool: false, multi_agent: false }, developer_instructions:
          "Use only structured output to request platform tools. Native shell and file edits are unavailable. Never execute commands yourself." },
      }, { workingDirectory: work, sandboxMode: "read-only", approvalPolicy: "never", skipGitRepoCheck: true,
        networkAccessEnabled: false, webSearchMode: "disabled", ...(request.model ? { model: request.model } : {}) });
      const result: SpecialistResult = { summary: "", artifacts: [] };
      let input = `${request.prompt}\n\nRequest ONE platform tool using tool and JSON-encoded arguments, or finish with tool=null and summary=final answer. All product files live in the platform Workspace, not this process directory. Tools:\n${JSON.stringify(request.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })))}`;
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
          if (event.type === "error" || event.type === "turn.failed") throw new CodexRuntimeError("Codex provider request failed; check the Codex credential and model configuration");
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
        if (!tool) throw new CodexRuntimeError("Codex requested an unavailable platform tool");
        let args: Record<string, unknown>;
        try { args = JSON.parse(decision.arguments); } catch { throw new CodexRuntimeError("Invalid platform tool arguments"); }
        if (!Value.Check(tool.parameters, args)) throw new CodexRuntimeError("Invalid platform tool arguments");
        const id = randomUUID();
        await sink({ type: "tool_call", id, name: tool.name, args });
        request.signal.throwIfAborted();
        const toolResult = await tool.execute(id, args, request.signal);
        request.signal.throwIfAborted();
        await sink({ type: "tool_call", id, name: tool.name, args, result: toolResult });
        if (tool.name === "declare_artifact" && !toolResult.isError) result.artifacts.push(toolResult.details);
        const changes = toolResult.details as { createdFiles?: unknown; modifiedFiles?: unknown } | undefined;
        const paths = [...new Set([changes?.createdFiles, changes?.modifiedFiles].flatMap(files => Array.isArray(files) ? files : []))];
        if (paths.length) await sink({ type: "file_change", toolCallId: id, details: { paths } });
        input = `Platform tool result:\n${JSON.stringify(toolResult).slice(0, 32000)}\nChoose the next platform tool or finish.`;
      }
      throw new CodexRuntimeError(`Codex exceeded maximum turns (${request.maxTurns})`);
    } catch (error) {
      if (request.signal.aborted) request.signal.throwIfAborted();
      // SDK stderr/provider errors may contain credentials. Do not persist them.
      if (error instanceof CodexRuntimeError && !error.message.includes(apiKey)) throw error;
      throw new CodexRuntimeError("Codex runtime failed; check auth/config or use builtin-code-engineer");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

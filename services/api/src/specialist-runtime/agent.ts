// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@sciencediscovery/orchestration";
import { buildTools, type NativeAgentHandle, type NativeAgentOptions } from "../native-agent/index.js";
import { CodexSpecialistAdapter } from "./codex.js";
import type { SpecialistRuntimeAdapter, SpecialistRuntimeEvent } from "./adapter.js";

const PLATFORM_TOOLS = new Set(["list_files", "read_file", "run_shell", "run_python", "run_scientific", "declare_artifact", "list_artifacts", "read_artifact", "materialize_artifact", "check_runner", "wait_for_runner", "execution_status", "execution_logs", "execution_cancel"]);

/** Replace only the model-loop factory; execution and artifact bindings remain platform-owned. */
export function codexAgentFactory(config: {
  model?: string;
  maxTurns: number;
  credential(signal: AbortSignal, needInput: () => Promise<void>): Promise<string>;
  onRuntimeEvent(event: SpecialistRuntimeEvent): Promise<void>;
  adapter?: SpecialistRuntimeAdapter;
}): (options: NativeAgentOptions) => NativeAgentHandle {
  return options => {
    const controller = new AbortController();
    const listeners = new Set<(event: AgentEvent) => void>();
    const emit = (event: AgentEvent) => { for (const listener of listeners) listener(event); };
    const sink = async (event: SpecialistRuntimeEvent) => {
      await config.onRuntimeEvent(event);
      if (event.type === "progress") {
        emit({ type: "turn_start" });
        emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: `${event.text}\n`, responseId: randomUUID() } });
      }
      if (event.type === "tool_call") {
        if (!event.result) emit({ type: "tool_execution_start", args: event.args, toolCallId: event.id, toolName: event.name });
        else emit({ type: "tool_execution_end", isError: event.result.isError === true, result: event.result, toolCallId: event.id, toolName: event.name });
      }
      if (event.type === "done") {
        if (event.result.usage) emit({ type: "usage", usage: event.result.usage });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: event.result.summary, responseId: randomUUID() } });
      }
    };
    const execute: NativeAgentHandle["execute"] = async prompt => {
      const result = await (config.adapter ?? new CodexSpecialistAdapter()).invoke({
        prompt: [options.specialist?.instructions, options.subagent?.instructions,
          options.runContract && options.runContract !== prompt ? `Original delegation:\n${options.runContract}` : undefined,
          options.gatewayHistory?.length ? `Prior platform conversation:\n${JSON.stringify(options.gatewayHistory)}` : undefined,
          prompt].filter(Boolean).join("\n\n"),
        ...(config.model ? { model: config.model } : {}), maxTurns: config.maxTurns, signal: controller.signal,
        tools: buildTools(options).filter(tool => PLATFORM_TOOLS.has(tool.name)),
        credential: () => config.credential(controller.signal, () => sink({ type: "need_input", runtime: "codex" })),
      }, sink);
      return { finalMessages: [...(options.gatewayHistory ?? []), { role: "user", content: prompt }, { role: "assistant", content: result.summary }] };
    };
    return { execute, prompt: async text => { await execute(text); }, abort: () => controller.abort(),
      beginExternalWait: () => () => undefined,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  };
}

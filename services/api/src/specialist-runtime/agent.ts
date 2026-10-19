// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { Type } from "typebox";
import type { SpecialistRuntime } from "@sciencediscovery/schema";
import { normalizeSpecialistRuntime } from "./config.js";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@sciencediscovery/orchestration";
import { buildTools, type NativeAgentHandle, type NativeAgentOptions } from "../native-agent/index.js";
import { CodexSpecialistAdapter, SpecialistUnavailableError } from "./codex.js";
import type { SpecialistRuntimeAdapter, SpecialistRuntimeEvent } from "./adapter.js";

const PLATFORM_TOOLS = new Set(["request_sandbox_network", "request_direct_execution", "run_direct_shell", "list_files", "read_file", "run_shell", "run_python", "run_scientific", "declare_artifact", "list_artifacts", "read_artifact", "materialize_artifact", "check_runner", "wait_for_runner", "execution_status", "execution_logs", "execution_cancel"]);

/** Replace only the model-loop factory; execution and artifact bindings remain platform-owned. */
export function codexAgentFactory(config: {
  model?: string;
  readRuntime?(): Extract<SpecialistRuntime, { kind: "codex" }> | undefined;
  runtime?: Extract<SpecialistRuntime, { kind: "codex" }>;
  configure?(runtime: Extract<SpecialistRuntime, { kind: "codex" }>): Promise<void>;
  authorizeDirect?(): Promise<void>;
  fallbackFactory?: (options: NativeAgentOptions) => NativeAgentHandle;
  maxTurns: number;
  credential(signal: AbortSignal, needInput: () => Promise<void>): Promise<string>;
  onRuntimeEvent(event: SpecialistRuntimeEvent): Promise<void>;
  adapter?: SpecialistRuntimeAdapter;
}): (options: NativeAgentOptions) => NativeAgentHandle {
  return options => {
    const controller = new AbortController();
    let fallback: NativeAgentHandle | undefined;
    let runtime = { kind: "codex" as const, ...(config.model ? { model: config.model } : {}), ...config.runtime };
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
      const parameters = Type.Object({
        model: Type.Optional(Type.String()), fallback: Type.Optional(Type.Boolean()),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400 })),
        reasoningEffort: Type.Optional(Type.Union([Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")])),
      }, { additionalProperties: false });
      const configure = {
        name: "configure_specialist_runtime", label: "Specialist runtime settings", parameters,
        description: "Apply the user's requested advanced runtime settings from this same conversation. No credentials. Model/reasoning apply on the next decision, timeout is the task wall-clock budget, fallback=false disables builtin-code-engineer recovery. Do not change settings without the user's request.",
        execute: async (_id: string, changes: Record<string, unknown>) => {
          runtime = normalizeSpecialistRuntime({ ...runtime, ...changes }) as typeof runtime;
          await config.configure?.(runtime);
          return { content: [{ type: "text" as const, text: JSON.stringify(runtime) }], details: runtime };
        },
      };
      const unavailable = {
        name: "report_runtime_unavailable", label: "Report unavailable runtime tools", parameters: Type.Object({}),
        description: "Use only when the Specialist cannot run at all because required tools are unavailable through every supported interaction path. Never use for a failed task, denied permission, cancellation, deadline or a normal nonzero command. Requests platform recovery according to the user's fallback setting.",
        execute: async () => ({ content: [{ type: "text" as const, text: "Required runtime tools are unavailable; requesting configured recovery." }], details: { runtimeUnavailable: true } }),
      };
      try {
        const result = await (config.adapter ?? new CodexSpecialistAdapter()).invoke({
          prompt: [options.specialist?.instructions, options.subagent?.instructions,
            options.runContract && options.runContract !== prompt ? `Original delegation:\n${options.runContract}` : undefined,
            options.gatewayHistory?.length ? `Prior platform conversation:\n${JSON.stringify(options.gatewayHistory)}` : undefined,
            prompt].filter(Boolean).join("\n\n"),
          workspaceRoot: options.workspaceRoot,
          get execution() { return runtime.execution; }, authorizeDirect: config.authorizeDirect,
          get model() { return runtime.model; }, get reasoningEffort() { return runtime.reasoningEffort; }, maxTurns: config.maxTurns, signal: controller.signal,
          tools: [...buildTools(options).filter(tool => PLATFORM_TOOLS.has(tool.name)), configure, unavailable],
          credential: async () => {
            const key = await config.credential(controller.signal, () => sink({ type: "need_input", runtime: "codex" }));
            runtime = config.readRuntime?.() ?? runtime;
            return key;
          },
        }, sink);
        return { finalMessages: [...(options.gatewayHistory ?? []), { role: "user", content: prompt }, { role: "assistant", content: result.summary }] };
      } catch (error) {
        if (controller.signal.aborted || !(error instanceof SpecialistUnavailableError) || runtime.fallback === false || !config.fallbackFactory) throw error;
        await sink({ type: "fallback", specialistId: "builtin-code-engineer" });
        controller.signal.throwIfAborted();
        fallback = config.fallbackFactory(options);
        const unsubscribe = fallback.subscribe(emit);
        try { return await fallback.execute(prompt); } finally { unsubscribe(); }
      }
    };
    return { execute, prompt: async text => { await execute(text); }, abort: () => { controller.abort(); fallback?.abort(); },
      beginExternalWait: () => fallback?.beginExternalWait() ?? (() => undefined),
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  };
}

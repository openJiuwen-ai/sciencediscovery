// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import {
  ContextSectionContributor,
  type AgentScope,
  type ContextContributorFactory,
} from "@sciencediscovery/context";
import type { RuntimeMessage } from "@sciencediscovery/runtime-core";
import type { AgentTool } from "@sciencediscovery/tools";
import { Type } from "typebox";

export interface ExecutionModeDescriptor {
  description: string;
  id: string;
  label: string;
}

export interface ExecutionModePlugin<TMessage extends RuntimeMessage = RuntimeMessage> {
  readonly contextContributorFactories?: readonly ContextContributorFactory<TMessage>[];
  readonly descriptor: ExecutionModeDescriptor;
  readonly tools: readonly AgentTool[];
}

export interface ActiveExecutionMode {
  activatedAt: string;
  modeId: string;
}

export type ExecutionModeEvent = {
  mode: ActiveExecutionMode;
  type: "mode.activated";
};

type ModeListener = (event: ExecutionModeEvent) => void;

const MODE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;

/**
 * Run-scoped mode registry. It owns capability selection only: tool handlers
 * still pass through the ordinary ToolRegistry and Governance policies.
 */
export class ExecutionModeRegistry<TMessage extends RuntimeMessage = RuntimeMessage> {
  private readonly plugins = new Map<string, ExecutionModePlugin<TMessage>>();
  private readonly listeners = new Set<ModeListener>();
  private frozen = false;
  private active: ActiveExecutionMode | undefined;

  register(plugin: ExecutionModePlugin<TMessage>): this {
    if (this.frozen) throw new Error("Execution mode registry is frozen");
    if (!MODE_ID.test(plugin.descriptor.id)) throw new Error(`Execution mode id is invalid: ${plugin.descriptor.id}`);
    if (this.plugins.has(plugin.descriptor.id)) throw new Error(`Duplicate execution mode: ${plugin.descriptor.id}`);
    const names = new Set<string>();
    for (const tool of plugin.tools) {
      if (names.has(tool.name)) throw new Error(`Duplicate tool in execution mode ${plugin.descriptor.id}: ${tool.name}`);
      names.add(tool.name);
    }
    this.plugins.set(plugin.descriptor.id, Object.freeze({
      ...plugin,
      descriptor: Object.freeze({ ...plugin.descriptor }),
      tools: Object.freeze([...plugin.tools]),
    }));
    return this;
  }

  freeze(): this {
    if (!this.plugins.size) throw new Error("At least one execution mode must be registered");
    this.frozen = true;
    return this;
  }

  descriptors(): ExecutionModeDescriptor[] {
    return [...this.plugins.values()].map((plugin) => structuredClone(plugin.descriptor));
  }

  snapshot(): ActiveExecutionMode | undefined {
    return this.active ? structuredClone(this.active) : undefined;
  }

  activate(modeId: string): ActiveExecutionMode {
    if (!this.frozen) throw new Error("Execution mode registry must be frozen before activation");
    if (!this.plugins.has(modeId)) throw new Error(`Unknown execution mode: ${modeId}`);
    if (this.active) {
      if (this.active.modeId === modeId) return structuredClone(this.active);
      throw new Error(`Execution mode is already active: ${this.active.modeId}`);
    }
    this.active = { activatedAt: new Date().toISOString(), modeId };
    const event: ExecutionModeEvent = { mode: structuredClone(this.active), type: "mode.activated" };
    for (const listener of this.listeners) listener(event);
    return structuredClone(this.active);
  }

  subscribe(listener: ModeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isToolAvailable(name: string): boolean {
    if (name === ACTIVATE_EXECUTION_MODE_TOOL) return true;
    if (!this.active) return false;
    return this.plugins.get(this.active.modeId)?.tools.some((tool) => tool.name === name) ?? false;
  }

  allTools(): AgentTool[] {
    const tools = new Map<string, AgentTool>();
    for (const plugin of this.plugins.values()) {
      for (const tool of plugin.tools) {
        const existing = tools.get(tool.name);
        if (existing && existing !== tool) {
          throw new Error(`Execution modes register incompatible implementations for tool: ${tool.name}`);
        }
        tools.set(tool.name, tool);
      }
    }
    return [...tools.values()];
  }

  contextContributorFactories(): readonly ContextContributorFactory<TMessage>[] {
    const factories: ContextContributorFactory<TMessage>[] = [];
    for (const plugin of this.plugins.values()) {
      for (const factory of plugin.contextContributorFactories ?? []) {
        factories.push({
          id: factory.id,
          create: (request) => {
            const created = factory.create(request);
            const contributors = Array.isArray(created) ? created : [created];
            const guarded = contributors.map((contributor) => ({
              id: contributor.id,
              ...(contributor.required !== undefined ? { required: contributor.required } : {}),
              scopes: contributor.scopes,
              contribute: async (contributionRequest: Parameters<typeof contributor.contribute>[0]) => {
                if (this.active?.modeId !== plugin.descriptor.id) return {};
                return contributor.contribute(contributionRequest);
              },
            }));
            return Array.isArray(created) ? guarded : guarded[0]!;
          },
        });
      }
    }
    return factories;
  }
}

export const ACTIVATE_EXECUTION_MODE_TOOL = "activate_execution_mode";

export function createActivateExecutionModeTool<TMessage extends RuntimeMessage>(
  registry: ExecutionModeRegistry<TMessage>,
) {
  const descriptors = registry.descriptors();
  const modeSchema = descriptors.length === 1
    ? Type.Literal(descriptors[0]!.id)
    : Type.Union(descriptors.map((descriptor) => Type.Literal(descriptor.id)));
  const parameters = Type.Object({
    modeId: modeSchema,
  });
  const tool: AgentTool<typeof parameters> = {
    description: [
      "Activate one execution mode for this run. Activate a mode before calling its tools.",
      ...descriptors.map((mode) => `- ${mode.id}: ${mode.description}`),
      "Activation is idempotent for the same mode; switching to another mode during the run is not supported.",
    ].join("\n"),
    async execute(_toolCallId, params) {
      // Tool calls from one model response enter the dispatcher synchronously
      // before awaiting their handlers. Yield once so activation affects only
      // the next model turn, never a sibling call whose schema was not exposed.
      await Promise.resolve();
      const mode = registry.activate(params.modeId);
      return { content: [{ type: "text", text: JSON.stringify({ mode, ok: true }) }], details: { mode } };
    },
    label: "Activate execution mode",
    name: ACTIVATE_EXECUTION_MODE_TOOL,
    parameters,
  };
  return tool;
}

export function executionModePromptSection(descriptors: readonly ExecutionModeDescriptor[]): string {
  return [
    "<execution_modes>",
    "No execution mode is active at the beginning of a run. First choose the mode that best fits the request by calling activate_execution_mode. Do not call mode-specific tools in the same model response as activation; they become available on the next turn.",
    ...descriptors.map((mode) => `- ${mode.id} (${mode.label}): ${mode.description}`),
    "</execution_modes>",
  ].join("\n");
}

/** Dynamic-context bridge; the assembler remains unaware of concrete modes. */
export function createExecutionModeContextFactory<TMessage extends RuntimeMessage>(
  registry: ExecutionModeRegistry<TMessage>,
  scopes: readonly AgentScope[],
): ContextContributorFactory<TMessage> {
  return {
    id: "execution-mode.state",
    create() {
      return new ContextSectionContributor<TMessage>({
        id: "execution-mode.state",
        scopes,
        contribute: async () => {
          const active = registry.snapshot();
          return { systemSections: [{
            content: active
              ? `<execution_mode_state>Active mode: ${active.modeId}. Continue using the capabilities and workflow of this mode.</execution_mode_state>`
              : executionModePromptSection(registry.descriptors()),
            id: "execution-mode.state",
            protected: true,
            slot: active ? "task_state" : "capabilities",
          }] };
        },
      });
    },
  };
}

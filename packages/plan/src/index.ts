// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import {
  ContextSectionContributor,
  type AgentScope,
  type ContextContributorFactory,
} from "@sciencediscovery/context";
import type { RuntimeMessage, RuntimeToolCall } from "@sciencediscovery/runtime-core";
import type { PlanSnapshot, UpdatePlanRequest } from "@sciencediscovery/schema";
import type { AgentTool, ToolBatchPolicy } from "@sciencediscovery/tools";
import { Type } from "typebox";

export const UPDATE_PLAN_TOOL_NAME = "update_plan";

/** Run-scoped persistence/projection port implemented by application composition. */
export interface PlanStore {
  latest(signal?: AbortSignal): Promise<PlanSnapshot | undefined>;
  update(input: UpdatePlanRequest, toolCallId: string, signal?: AbortSignal): Promise<PlanSnapshot>;
}

export interface PlanCapabilityOptions {
  store: PlanStore;
}

export interface PlanProgressObservation extends Record<string, unknown> {
  agentId: string;
  anchorFound: boolean;
  currentModelTurn: number;
  modelStepsSinceUpdate?: number;
  toolCallId: string;
  toolResultsSinceUpdate?: number;
  updatedAt: string;
}

const itemSchema = Type.Object({
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
  ]),
  step: Type.String({ maxLength: 1_000, minLength: 1 }),
}, { additionalProperties: false });

const parameters = Type.Object({
  explanation: Type.Optional(Type.String({ maxLength: 2_000 })),
  plan: Type.Array(itemSchema, { maxItems: 20 }),
}, { additionalProperties: false });

export function createPlanTool(options: PlanCapabilityOptions): AgentTool<typeof parameters> {
  return {
    description: [
      "Maintain the model-declared execution plan for this run by replacing it with a complete snapshot.",
      "Send the entire list on every call; this tool does not apply per-step edits.",
      "Before starting a planned step, mark it in_progress.",
      "Before each substantive tool call, check whether the previous planned step finished or the next action changed; if so, update the plan first.",
      "As soon as a step reaches its intended outcome, update the plan before moving to another planned step; do not batch completed steps.",
      "Revise, add, remove, or reorder unfinished steps when new evidence changes the approach.",
      "Mark a step completed only after successful completion; if it is blocked or unsuccessful, leave it unfinished and explain why.",
      "Several items may be in_progress only when work genuinely runs in parallel.",
      "Before the final answer, make one last plan update, then provide the answer after the tool result.",
      "Use an empty list to clear the plan.",
    ].join(" "),
    async execute(toolCallId, input, signal) {
      if (!Array.isArray(input.plan) || input.plan.length > 20) {
        throw new Error("Plan must contain at most 20 items");
      }
      const plan = input.plan.map((item) => {
        const step = typeof item?.step === "string" ? item.step.trim() : "";
        if (!step || step.length > 1_000) throw new Error("Each plan step must contain 1-1000 non-whitespace characters");
        if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") {
          throw new Error("Invalid plan item status");
        }
        return { status: item.status, step };
      });
      const explanation = typeof input.explanation === "string" ? input.explanation.trim() : "";
      if (explanation.length > 2_000) throw new Error("Plan explanation must not exceed 2000 characters");
      const snapshot = await options.store.update({
        ...(explanation ? { explanation } : {}),
        plan,
      }, toolCallId, signal);
      return { content: [{ type: "text", text: JSON.stringify(snapshot) }], details: snapshot };
    },
    label: "Update plan",
    name: UPDATE_PLAN_TOOL_NAME,
    parameters,
  };
}

function toolCallId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

function toolResultName(message: RuntimeMessage): string | undefined {
  return message.role === "tool" && typeof message.name === "string" ? message.name : undefined;
}

/** Trace-only progress age derived from visible history; it never classifies or blocks execution. */
export function observePlanProgress<TMessage extends RuntimeMessage>(
  snapshot: PlanSnapshot,
  history: readonly TMessage[],
  currentModelTurn: number,
): PlanProgressObservation {
  const anchorIndex = history.findLastIndex((message) => Array.isArray(message.tool_calls)
    && message.tool_calls.some((call) => toolCallId(call) === snapshot.toolCallId));
  const base = {
    agentId: snapshot.agentId,
    anchorFound: anchorIndex >= 0,
    currentModelTurn,
    toolCallId: snapshot.toolCallId,
    updatedAt: snapshot.updatedAt,
  };
  if (anchorIndex < 0) return base;
  const subsequent = history.slice(anchorIndex + 1);
  return {
    ...base,
    modelStepsSinceUpdate: subsequent.filter((message) => message.role === "assistant").length,
    toolResultsSinceUpdate: subsequent.filter((message) => {
      const name = toolResultName(message);
      return name !== undefined && name !== UPDATE_PLAN_TOOL_NAME;
    }).length,
  };
}

/** Within one model-declared batch only the final whole-plan snapshot commits. */
export function createPlanBatchPolicy(): ToolBatchPolicy {
  return {
    id: "plan.last-declared-snapshot",
    decide(calls: readonly RuntimeToolCall[]) {
      const updates = calls.filter((call) => call.name === UPDATE_PLAN_TOOL_NAME);
      const winner = updates.at(-1);
      return winner
        ? updates.slice(0, -1).map((call) => ({
          byCallId: winner.id,
          callId: call.id,
          kind: "supersede" as const,
        }))
        : [];
    },
  };
}

export function createPlanContextFactory<TMessage extends RuntimeMessage>(
  store: PlanStore,
  scopes: readonly AgentScope[],
): ContextContributorFactory<TMessage> {
  return {
    id: "plan.state",
    create() {
      return new ContextSectionContributor<TMessage>({
        id: "plan.state",
        scopes,
        contribute: async ({ history, signal, turn }) => {
          const snapshot = await store.latest(signal);
          if (!snapshot?.items.length) return {};
          const observation = observePlanProgress(snapshot, history, turn);
          return {
            diagnostics: [{
              code: "PLAN_PROGRESS_OBSERVATION",
              details: observation,
              message: "Trace-only plan progress observation; no stale classification or execution policy was applied.",
              severity: "info",
            }],
            systemSections: [{
              content: [
                "<plan_state>",
                "Keep this plan current at semantic step boundaries: when starting, completing, blocking, or revising a planned step—not after every individual tool call. Before a substantive tool call, check whether the previous planned step finished or the next action changed; if so, call update_plan first with the complete replacement list. Do not batch completed steps, and close or explicitly revise unfinished steps before the final answer.",
                JSON.stringify({
                  ...(snapshot.explanation ? { explanation: snapshot.explanation } : {}),
                  items: snapshot.items,
                }),
                "</plan_state>",
              ].join("\n"),
              id: "plan.state",
              protected: true,
              slot: "task_state",
            }],
          };
        },
      });
    },
  };
}

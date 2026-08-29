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
      "Replace the current task plan with this complete snapshot.",
      "Send the entire list on every call; this tool does not apply per-step edits.",
      "Use an empty list to clear the plan. Several items may be in_progress when work genuinely runs in parallel.",
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
        contribute: async ({ signal }) => {
          const snapshot = await store.latest(signal);
          if (!snapshot?.items.length) return {};
          return { systemSections: [{
            content: [
              "<plan_state>",
              "Keep this plan current as work progresses. Call update_plan with the complete replacement list when status or structure changes.",
              JSON.stringify({
                ...(snapshot.explanation ? { explanation: snapshot.explanation } : {}),
                items: snapshot.items,
              }),
              "</plan_state>",
            ].join("\n"),
            id: "plan.state",
            protected: true,
            slot: "task_state",
          }] };
        },
      });
    },
  };
}

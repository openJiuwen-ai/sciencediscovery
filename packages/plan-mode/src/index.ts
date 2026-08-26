// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import {
  ContextSectionContributor,
  type AgentScope,
  type ContextContributorFactory,
} from "@sciencediscovery/context";
import type { ExecutionModeDescriptor, ExecutionModePlugin } from "@sciencediscovery/execution-modes";
import type { RuntimeMessage } from "@sciencediscovery/runtime-core";
import type {
  PlanStep,
  ProposePlanRequest,
  RevisePlanRequest,
  SessionPlan,
} from "@sciencediscovery/schema";
import type { AgentTool } from "@sciencediscovery/tools";
import { Type } from "typebox";

export interface UpdatePlanStepRequest {
  expectedVersion: number;
  planId: string;
  status: PlanStep["status"];
  stepId: string;
}

export interface AbandonPlanRequest {
  expectedVersion: number;
  planId: string;
  reason?: string;
}

/** Persistence port implemented by the application composition root. */
export interface PlanRepository {
  abandon(input: AbandonPlanRequest, signal?: AbortSignal): Promise<SessionPlan>;
  latest(signal?: AbortSignal): Promise<SessionPlan | undefined>;
  propose(input: ProposePlanRequest, signal?: AbortSignal): Promise<SessionPlan>;
  revise(planId: string, input: RevisePlanRequest, signal?: AbortSignal): Promise<SessionPlan>;
  updateStep(input: UpdatePlanStepRequest, signal?: AbortSignal): Promise<SessionPlan>;
}

export type PlanModeEvent =
  | { plan: SessionPlan; type: "plan.proposed" }
  | { plan: SessionPlan; type: "plan.revised" }
  | { plan: SessionPlan; type: "plan.step_updated" }
  | { plan: SessionPlan; type: "plan.abandoned" };

export interface PlanModeOptions<TMessage extends RuntimeMessage = RuntimeMessage> {
  executionTools: readonly AgentTool[];
  onEvent?(event: PlanModeEvent): void | Promise<void>;
  repository: PlanRepository;
  scopes?: readonly AgentScope[];
}

export const PLAN_MODE_DESCRIPTOR: ExecutionModeDescriptor = Object.freeze({
  description: "Maintain a structured, visible plan while executing a multi-step request. Planning records progress but does not gate ordinary tool use.",
  id: "plan",
  label: "Plan",
});

const planBody = {
  caveats: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 10 })),
  feasibilityConfidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
  scope: Type.String({ maxLength: 2_000, minLength: 1 }),
  steps: Type.Array(Type.String({ maxLength: 1_000, minLength: 1 }), { maxItems: 20, minItems: 1 }),
} as const;

async function emit(options: PlanModeOptions, event: PlanModeEvent): Promise<void> {
  await options.onEvent?.(event);
}

export function createPlanLifecycleTools(options: PlanModeOptions): AgentTool[] {
  const proposeParameters = Type.Object(planBody);
  const propose: AgentTool<typeof proposeParameters> = {
    description: "Create the current structured plan. This records execution state but does not require user approval and does not block ordinary tools.",
    async execute(_id, params, signal) {
      const plan = await options.repository.propose(params, signal);
      await emit(options, { plan, type: "plan.proposed" });
      return { content: [{ type: "text", text: JSON.stringify(plan) }], details: plan };
    },
    label: "Propose plan",
    name: "propose_plan",
    parameters: proposeParameters,
  };

  const reviseParameters = Type.Object({
    ...planBody,
    expectedVersion: Type.Integer({ minimum: 1 }),
    planId: Type.String({ minLength: 1 }),
  });
  const revise: AgentTool<typeof reviseParameters> = {
    description: "Replace the scope, confidence, caveats, and steps of the current plan. Supply its latest version to prevent lost updates.",
    async execute(_id, params, signal) {
      const { planId, ...input } = params;
      const plan = await options.repository.revise(planId, input, signal);
      await emit(options, { plan, type: "plan.revised" });
      return { content: [{ type: "text", text: JSON.stringify(plan) }], details: plan };
    },
    label: "Revise plan",
    name: "revise_plan",
    parameters: reviseParameters,
  };

  const stepParameters = Type.Object({
    expectedVersion: Type.Integer({ minimum: 1 }),
    planId: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("blocked"),
      Type.Literal("completed"),
    ]),
    stepId: Type.String({ minLength: 1 }),
  });
  const updateStep: AgentTool<typeof stepParameters> = {
    description: "Update one plan step after its execution state changes. The plan completes automatically when every step is completed.",
    async execute(_id, params, signal) {
      const plan = await options.repository.updateStep(params, signal);
      await emit(options, { plan, type: "plan.step_updated" });
      return { content: [{ type: "text", text: JSON.stringify(plan) }], details: plan };
    },
    label: "Update plan step",
    name: "update_plan_step",
    parameters: stepParameters,
  };

  const abandonParameters = Type.Object({
    expectedVersion: Type.Integer({ minimum: 1 }),
    planId: Type.String({ minLength: 1 }),
    reason: Type.Optional(Type.String({ maxLength: 2_000 })),
  });
  const abandon: AgentTool<typeof abandonParameters> = {
    description: "Abandon the current plan when it is no longer applicable. This records the terminal state; it does not undo completed work.",
    async execute(_id, params, signal) {
      const plan = await options.repository.abandon(params, signal);
      await emit(options, { plan, type: "plan.abandoned" });
      return { content: [{ type: "text", text: JSON.stringify(plan) }], details: plan };
    },
    label: "Abandon plan",
    name: "abandon_plan",
    parameters: abandonParameters,
  };
  return [propose, revise, updateStep, abandon];
}

export function createPlanContextFactory<TMessage extends RuntimeMessage>(
  repository: PlanRepository,
  scopes: readonly AgentScope[],
): ContextContributorFactory<TMessage> {
  return {
    id: "plan-mode.state",
    create() {
      return new ContextSectionContributor<TMessage>({
        id: "plan-mode.state",
        scopes,
        contribute: async ({ signal }) => {
          const plan = await repository.latest(signal);
          return { systemSections: [{
            content: plan
              ? [
                "<plan_mode_state>",
                "Maintain this plan as execution progresses. Update a step when its state changes; revise only when the plan itself changes.",
                JSON.stringify(plan),
                "</plan_mode_state>",
              ].join("\n")
              : "<plan_mode_state>No plan has been recorded yet. Understand the objective, then call propose_plan before maintaining step progress. Ordinary execution tools remain available.</plan_mode_state>",
            id: "plan-mode.state",
            protected: true,
            slot: "task_state",
          }] };
        },
      });
    },
  };
}

export function createPlanMode<TMessage extends RuntimeMessage = RuntimeMessage>(
  options: PlanModeOptions<TMessage>,
): ExecutionModePlugin<TMessage> {
  const scopes = options.scopes ?? ["main", "subagent"];
  return {
    contextContributorFactories: [createPlanContextFactory<TMessage>(options.repository, scopes)],
    descriptor: PLAN_MODE_DESCRIPTOR,
    tools: [...options.executionTools, ...createPlanLifecycleTools(options)],
  };
}

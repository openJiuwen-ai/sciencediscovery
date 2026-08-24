// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

import type { CollectedContext, ContextDiagnostic } from "./contributor.js";

export interface ContextBudgetConfig {
  attachmentMaxCharacters: number;
  contributedMessageBudgetCharacters: number;
  dataBudgetCharacters: number;
  maxContributedMessages: number;
  /** Provider/model context window, including the reserved model output. */
  modelContextTokens?: number;
  /** Tokens kept free for the model response. */
  outputReserveTokens?: number;
  promptBudgetCharacters: number;
  sectionMaxCharacters: number;
  windowMessages?: number;
  windowRounds?: number;
  windowTokens?: number;
}

const DEFAULTS: ContextBudgetConfig = Object.freeze({
  attachmentMaxCharacters: 200_000,
  contributedMessageBudgetCharacters: 100_000,
  dataBudgetCharacters: 500_000,
  maxContributedMessages: 50,
  modelContextTokens: 131_072,
  outputReserveTokens: 16_384,
  promptBudgetCharacters: 300_000,
  sectionMaxCharacters: 100_000,
});

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback?: number): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function resolveContextBudget(
  env: NodeJS.ProcessEnv = process.env,
  defaults: { outputReserveTokens?: number } = {},
): ContextBudgetConfig {
  const modelContextTokens = positiveInteger(
    env,
    "SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS",
    DEFAULTS.modelContextTokens,
  )!;
  const outputReserveTokens = positiveInteger(
    env,
    "SCIENCE_AGENT_CONTEXT_OUTPUT_RESERVE_TOKENS",
    defaults.outputReserveTokens ?? DEFAULTS.outputReserveTokens,
  )!;
  if (outputReserveTokens >= modelContextTokens) {
    throw new Error("SCIENCE_AGENT_CONTEXT_OUTPUT_RESERVE_TOKENS must be smaller than SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS");
  }
  return {
    attachmentMaxCharacters: positiveInteger(env, "SCIENCE_AGENT_CONTEXT_ATTACHMENT_MAX_CHARS", DEFAULTS.attachmentMaxCharacters)!,
    contributedMessageBudgetCharacters: positiveInteger(env, "SCIENCE_AGENT_CONTEXT_CONTRIBUTED_MESSAGE_BUDGET_CHARS", DEFAULTS.contributedMessageBudgetCharacters)!,
    dataBudgetCharacters: positiveInteger(env, "SCIENCE_AGENT_CONTEXT_DATA_BUDGET_CHARS", DEFAULTS.dataBudgetCharacters)!,
    maxContributedMessages: positiveInteger(env, "SCIENCE_AGENT_CONTEXT_MAX_CONTRIBUTED_MESSAGES", DEFAULTS.maxContributedMessages)!,
    modelContextTokens,
    outputReserveTokens,
    promptBudgetCharacters: positiveInteger(env, "SCIENCE_AGENT_CONTEXT_PROMPT_BUDGET_CHARS", DEFAULTS.promptBudgetCharacters)!,
    sectionMaxCharacters: positiveInteger(env, "SCIENCE_AGENT_CONTEXT_SECTION_MAX_CHARS", DEFAULTS.sectionMaxCharacters)!,
    ...(positiveInteger(env, "SCIENCE_AGENT_CONTEXT_WINDOW_MESSAGES") !== undefined
      ? { windowMessages: positiveInteger(env, "SCIENCE_AGENT_CONTEXT_WINDOW_MESSAGES")! }
      : {}),
    ...(positiveInteger(env, "SCIENCE_AGENT_CONTEXT_WINDOW_ROUNDS") !== undefined
      ? { windowRounds: positiveInteger(env, "SCIENCE_AGENT_CONTEXT_WINDOW_ROUNDS")! }
      : {}),
    ...(positiveInteger(env, "SCIENCE_AGENT_CONTEXT_WINDOW_TOKENS") !== undefined
      ? { windowTokens: positiveInteger(env, "SCIENCE_AGENT_CONTEXT_WINDOW_TOKENS")! }
      : {}),
  };
}

const TRUNCATION_MARKER = "\n[context truncated by configured budget]";

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, limit);
  return `${value.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function diagnostic(code: string, message: string): ContextDiagnostic & { contributorId: string } {
  return { code, contributorId: "context.budget", message, severity: "warning" };
}

/** Enforces admission budgets before the invocation context is rendered. */
export function applyContextBudget<TMessage extends RuntimeMessage>(
  input: CollectedContext<TMessage>,
  budget: ContextBudgetConfig,
): CollectedContext<TMessage> {
  const output: CollectedContext<TMessage> = {
    attachments: [],
    diagnostics: input.diagnostics.map((item) => ({ ...item })),
    messages: [],
    sections: [],
  };

  const protectedSections = input.sections.filter((section) => section.protected);
  const protectedCharacters = protectedSections
    .reduce((total, section) => total + section.content.length, 0)
    + Math.max(0, protectedSections.length - 1);
  if (protectedCharacters > budget.promptBudgetCharacters) {
    throw new Error(
      `Protected context sections require ${protectedCharacters} characters, exceeding SCIENCE_AGENT_CONTEXT_PROMPT_BUDGET_CHARS=${budget.promptBudgetCharacters}`,
    );
  }
  let promptRemaining = budget.promptBudgetCharacters - protectedCharacters;
  let admittedOptionalSections = 0;
  for (const section of input.sections) {
    if (section.protected) {
      output.sections.push({ ...section });
      continue;
    }
    const separatorCharacters = protectedSections.length + admittedOptionalSections > 0 ? 1 : 0;
    const allowed = Math.min(budget.sectionMaxCharacters, promptRemaining - separatorCharacters);
    if (allowed <= 0) {
      output.diagnostics.push(diagnostic("CONTEXT_SECTION_DROPPED", `Dropped ${section.id}: prompt budget exhausted`));
      continue;
    }
    const content = truncate(section.content, allowed);
    output.sections.push({ ...section, content });
    admittedOptionalSections += 1;
    promptRemaining -= separatorCharacters + content.length;
    if (content.length !== section.content.length) {
      output.diagnostics.push(diagnostic("CONTEXT_SECTION_TRUNCATED", `Truncated ${section.id} to ${content.length} characters`));
    }
  }

  let dataRemaining = budget.dataBudgetCharacters;
  for (const attachment of input.attachments) {
    const allowed = Math.min(budget.attachmentMaxCharacters, dataRemaining);
    if (allowed <= 0) {
      output.diagnostics.push(diagnostic("CONTEXT_ATTACHMENT_DROPPED", `Dropped ${attachment.id}: data budget exhausted`));
      continue;
    }
    const content = truncate(attachment.content, allowed);
    output.attachments.push({ ...attachment, content });
    dataRemaining -= content.length;
    if (content.length !== attachment.content.length) {
      output.diagnostics.push(diagnostic("CONTEXT_ATTACHMENT_TRUNCATED", `Truncated ${attachment.id} to ${content.length} characters`));
    }
  }

  let messageCharacters = 0;
  const newestFirst = input.messages.toReversed();
  for (const message of newestFirst) {
    if (output.messages.length >= budget.maxContributedMessages) break;
    const content = typeof message.content === "string" ? message.content.length : 0;
    if (messageCharacters + content > budget.contributedMessageBudgetCharacters) continue;
    output.messages.unshift(structuredClone(message));
    messageCharacters += content;
  }
  if (output.messages.length !== input.messages.length) {
    output.diagnostics.push(diagnostic(
      "CONTEXT_MESSAGES_DROPPED",
      `Kept ${output.messages.length} of ${input.messages.length} contributed messages`,
    ));
  }
  return output;
}

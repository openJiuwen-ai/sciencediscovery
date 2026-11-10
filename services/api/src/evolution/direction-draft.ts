// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").

import { randomUUID } from "node:crypto";
import { resolveProxyForUrl } from "@sciencediscovery/data-source";
import { completeChatRequest } from "@sciencediscovery/model";
import { EVOLVE_EDITABLE_LIMIT, evolveBaselineFields, evolveFieldIsSelectable, type EvolveDirectionInput, type ModelProfile, type Session } from "@sciencediscovery/schema";

import { parseProviderUsage } from "../provider-usage.js";
import type { SessionStore } from "../store.js";
import { endpointCanDisableThinking } from "./model-thinking.js";

const PROMPT = "Draft a compact starting JSON for an Evolve search based on the user's task. "
  + "Return one JSON object with baseline (an object of meaningful initial field values) and editable (an array "
  + "of top-level field names that the search should be allowed to vary). Only suggest changing fields consistent "
  + "with the user's task. Use the user's specified starting values and constraints when provided. "
  + "Keep fixed context separate. Do not invent empirical results or credentials. "
  + "Return only JSON. This is a draft for the user to review, not a run or a score.";

export function parseEvolveDirectionDraft(content: string): EvolveDirectionInput | undefined {
  try {
    const source = content.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
    const parsed = JSON.parse(source) as { baseline?: unknown; editable?: unknown };
    if (parsed.baseline === undefined) return undefined;
    const baseline = JSON.stringify(parsed.baseline);
    const fields = evolveBaselineFields(baseline);
    if (!fields?.length) return undefined;
    const names = new Map(fields);
    const suggestions = Array.isArray(parsed.editable) ? parsed.editable : [];
    const editable = [...new Set(suggestions.filter((name): name is string =>
      typeof name === "string" && evolveFieldIsSelectable(name) && names.has(name)))].slice(0, EVOLVE_EDITABLE_LIMIT);
    return { baseline, editable };
  } catch {
    return undefined;
  }
}

export async function draftEvolveDirection(
  store: SessionStore, session: Session, model: ModelProfile, apiToken: string, task: string, signal: AbortSignal,
): Promise<EvolveDirectionInput | undefined> {
  const startedAt = new Date().toISOString();
  const reply = await completeChatRequest(
    { ...model, apiToken, proxy: resolveProxyForUrl(store.resolveProxy(model.proxyPolicy), model.baseUrl) },
    {
      messages: [{ role: "system", content: PROMPT }, { role: "user", content: task }],
      max_tokens: 4096,
      ...(endpointCanDisableThinking(model) ? { thinking: { type: "disabled" } } : {}),
    },
    AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
    undefined,
    256 * 1024,
  );
  if (!reply.ok) return undefined;
  const result = await reply.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
  const content = result.choices?.[0]?.message?.content;
  const draft = typeof content === "string" ? parseEvolveDirectionDraft(content) : undefined;
  const usage = parseProviderUsage(result.usage);
  const id = randomUUID();
  await store.appendModelInvocationUsage({
    id, invocationId: id, invocationKind: "evolve", attemptIndex: 0,
    model: model.model, modelProfileId: model.id, modelProfileName: model.name,
    sessionId: session.id, projectId: session.projectId, startedAt, finishedAt: new Date().toISOString(),
    costUsd: null, outcome: draft ? "completed" : "failed",
    cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens, usageStatus: usage.usageStatus,
  });
  return draft;
}

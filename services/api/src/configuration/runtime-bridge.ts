// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { BackendConfigurationCapabilities } from "./backend-capabilities.js";
import { requireSameRun } from "./backend-capabilities.js";

/** Server-only identity: never accept these fields from an Agent or ordinary decision DTO. */
export interface ConfigurationWaitBinding<CheckpointRef = string> {
  sessionId: string;
  runId: string;
  requestId: string;
  revision: number;
  stopGeneration: number;
  checkpointRef: CheckpointRef;
  committedAt: string;
}
export interface JiuwenConfigurationWaitBinding extends ConfigurationWaitBinding {
  upstreamSessionId: string;
  interruptId: string;
  toolCallId: string;
  upstreamCheckpointRef: string;
}
export interface ConfigurationActivationEvidence {
  requestId: string;
  revision: number;
  receiptId: string;
  runId?: string;
  effectiveRevision: string;
  toolCatalogFingerprint: string;
  activatedAt: string;
}
export function assertWaitBinding(expected: ConfigurationWaitBinding, actual: ConfigurationWaitBinding): void {
  for (const key of ["sessionId", "runId", "requestId", "revision", "stopGeneration", "checkpointRef", "committedAt"] as const)
    if (expected[key] !== actual[key]) throw new Error(`Configuration wait binding mismatch: ${key}`);
}
export function assertJiuwenWaitBinding(expected: JiuwenConfigurationWaitBinding, actual: JiuwenConfigurationWaitBinding): void {
  assertWaitBinding(expected, actual);
  for (const key of ["upstreamSessionId", "interruptId", "toolCallId", "upstreamCheckpointRef"] as const)
    if (!expected[key] || expected[key] !== actual[key]) throw new Error(`Configuration interrupt binding mismatch: ${key}`);
}

/** DEV-CFG-04 / CFG-T27: reuse native checkpoint serialization, with explicit durable ordering. */
export async function persistNativeConfigurationWait<CheckpointRef>(input: {
  sessionId: string; runId: string; requestId: string; revision?: number;
  generation(): number;
  commitCheckpoint(stopGeneration: number, committedAt: string): Promise<CheckpointRef>;
  commitWait(binding: ConfigurationWaitBinding<CheckpointRef>): Promise<void>;
}): Promise<ConfigurationWaitBinding<CheckpointRef>> {
  const stopGeneration = input.generation();
  const committedAt = new Date().toISOString();
  const checkpointRef = await input.commitCheckpoint(stopGeneration, committedAt);
  if (!checkpointRef || input.generation() !== stopGeneration) throw new Error("Configuration wait invalidated before checkpoint commit");
  const binding: ConfigurationWaitBinding<CheckpointRef> = { sessionId: input.sessionId, runId: input.runId, requestId: input.requestId,
    revision: input.revision ?? 1, stopGeneration, checkpointRef, committedAt };
  await input.commitWait(binding);
  if (input.generation() !== stopGeneration) throw new Error("Configuration wait invalidated while committing run binding");
  return binding;
}

/** A capable host supplies core's actual interrupt endpoints; no chat('continue') fallback exists. */
export interface JiuwenInterruptHost {
  inspectWait(binding: JiuwenConfigurationWaitBinding): Promise<{ binding: JiuwenConfigurationWaitBinding; checkpointDurable: boolean; pendingInterruptIds: string[] }>;
  resume(input: { binding: JiuwenConfigurationWaitBinding; resumeKey: string; answers: Record<string, { requestId: string; revision: number; decision: "apply" | "dismiss"; receiptId?: string }> }): Promise<{ state: "queued" | "started"; resumeKey: string }>;
  cancel(binding: JiuwenConfigurationWaitBinding): Promise<void>;
}
export class JiuwenConfigurationRuntimeBridge {
  constructor(private readonly capabilities: BackendConfigurationCapabilities, private readonly host: JiuwenInterruptHost) {}
  async resume(input: {
    binding: JiuwenConfigurationWaitBinding; capabilityId: string; decision: "apply" | "dismiss";
    generation(): number; activation?: ConfigurationActivationEvidence;
  }): Promise<{ state: "queued" | "started"; resumeKey: string }> {
    requireSameRun(this.capabilities, input.capabilityId);
    const binding = input.binding;
    if (binding.stopGeneration !== input.generation()) throw new Error("Configuration wait was stopped");
    if (input.decision === "apply" && (!input.activation || input.activation.requestId !== binding.requestId
      || input.activation.revision !== binding.revision || input.activation.runId !== binding.runId
      || !input.activation.toolCatalogFingerprint || !input.activation.effectiveRevision)) throw new Error("Matching activation evidence is required before resume");
    const current = await this.host.inspectWait(binding);
    assertJiuwenWaitBinding(binding, current.binding);
    if (!current.checkpointDurable || !current.pendingInterruptIds.includes(binding.interruptId))
      throw new Error("The durable configuration interrupt is no longer pending");
    if (binding.stopGeneration !== input.generation()) throw new Error("Configuration wait was stopped during reconciliation");
    const resumeKey = `${binding.runId}:${binding.requestId}:${binding.revision}:${binding.stopGeneration}`;
    const result = await this.host.resume({ binding, resumeKey, answers: {
      [binding.interruptId]: { requestId: binding.requestId, revision: binding.revision, decision: input.decision,
        ...(input.activation ? { receiptId: input.activation.receiptId } : {}) },
    } });
    if (result.resumeKey !== resumeKey || !["queued", "started"].includes(result.state)) throw new Error("Invalid configuration resume receipt");
    return result;
  }
  async cancel(binding: JiuwenConfigurationWaitBinding): Promise<void> {
    await this.host.cancel(binding);
  }
}

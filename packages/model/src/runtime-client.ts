// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ModelClient, ModelClientObserver, ModelTurn as RuntimeModelTurn, RuntimeMessage } from "@sciencediscovery/runtime-core";

import {
  streamModelTurn,
  isModelInputTooLargeError,
  isEmptyTerminalTurn,
  EmptyModelTurnError,
  type ModelClientPolicy,
  type ModelEndpoint,
  type WireToolSpec,
} from "./client.js";
import type { ModelUsage } from "./types.js";

export interface ModelInput<TMessage extends RuntimeMessage = RuntimeMessage> {
  history: TMessage[];
  systemPrompt: string;
  tools: WireToolSpec[];
}

export type ModelTurnTransport = typeof streamModelTurn;

/** Runtime port adapter around the normalized provider transport. */
export class ProviderModelClient<TMessage extends RuntimeMessage = RuntimeMessage>
implements ModelClient<TMessage, ModelInput<TMessage>, ModelUsage> {
  constructor(
    private readonly endpoint: ModelEndpoint,
    private readonly policy: ModelClientPolicy,
    private readonly transport: ModelTurnTransport = streamModelTurn,
  ) {}

  isInputTooLargeError(error: unknown): boolean {
    return isModelInputTooLargeError(error);
  }

  async invoke(
    input: ModelInput<TMessage>,
    signal: AbortSignal,
    observer: ModelClientObserver,
  ): Promise<RuntimeModelTurn<TMessage, ModelUsage>> {
    const turn = await this.transport(this.endpoint, input.systemPrompt, input.history, input.tools, this.policy, signal, {
      ...observer,
      // The rule below is this client's, so the transport must classify the one
      // record it reports; the summary line then names which empty shape failed
      // (`reasoning_only` or `empty_completion`) instead of reading like a served turn.
      rejectEmptyTerminalTurn: true,
    });
    if (turn.streamDiagnostics?.unparseableSsePayloads) throw new Error("Model stream contained malformed event payloads");
    if (turn.completionObserved === false) throw new Error("Model stream ended without a completion event");
    // A completed turn that says nothing and calls nothing ends the run with no
    // deliverable. It is a failed model request, not a final answer; the
    // diagnostics keep the upstream request ID and framing summary attached.
    if (isEmptyTerminalTurn(turn)) throw new EmptyModelTurnError(turn.wireDiagnostics);
    return { ...turn, assistantMessage: turn.assistantMessage as TMessage };
  }
}

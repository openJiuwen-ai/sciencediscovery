// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ModelClient, ModelClientObserver, ModelTurn as RuntimeModelTurn, RuntimeMessage } from "@science-agent/runtime-core";

import {
  streamModelTurn,
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

  async invoke(
    input: ModelInput<TMessage>,
    signal: AbortSignal,
    observer: ModelClientObserver,
  ): Promise<RuntimeModelTurn<TMessage, ModelUsage>> {
    const turn = await this.transport(this.endpoint, input.systemPrompt, input.history, input.tools, this.policy, signal, observer);
    return { ...turn, assistantMessage: turn.assistantMessage as TMessage };
  }
}

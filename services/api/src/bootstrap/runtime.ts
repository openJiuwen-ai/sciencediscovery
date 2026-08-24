// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import {
  RuntimeBuilder,
  type AgentLoop,
  type ContextAssembler,
  type ExternalWaitController,
  type ModelClient,
  type RunEventSink,
  type RuntimeMessage,
  type ToolDispatcher,
} from "@sciencediscovery/runtime-core";

export interface RuntimeComposition<TMessage extends RuntimeMessage, TModelInput, TUsage> {
  contextAssembler: ContextAssembler<TMessage, TModelInput>;
  eventSink: RunEventSink<TUsage>;
  maxModelTurns: number;
  modelClient: ModelClient<TMessage, TModelInput, TUsage>;
  toolDispatcher: ToolDispatcher<TMessage>;
  waitController: ExternalWaitController;
}

/** API composition root: adapters are registered here, not looked up by the core. */
export function composeRuntime<TMessage extends RuntimeMessage, TModelInput, TUsage>(
  composition: RuntimeComposition<TMessage, TModelInput, TUsage>,
): AgentLoop<TMessage, TModelInput, TUsage> {
  return new RuntimeBuilder<TMessage, TModelInput, TUsage>()
    .withContextAssembler(composition.contextAssembler)
    .withModelClient(composition.modelClient)
    .withToolDispatcher(composition.toolDispatcher)
    .withEventSink(composition.eventSink)
    .withWaitController(composition.waitController)
    .withMaxModelTurns(composition.maxModelTurns)
    .build();
}

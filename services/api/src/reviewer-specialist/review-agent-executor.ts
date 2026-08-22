// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import {
  createReviewAgentOptions as createReviewAgentDomainOptions,
  type CreateReviewAgentOptionsInput,
} from "@sciencediscovery/specialist";

import { runSubagentTask } from "../agent-run/orchestrators.js";

/** Thin API adapter binding the Specialist domain to the local Agent runner. */
export function createReviewAgentOptions(
  input: Omit<CreateReviewAgentOptionsInput, "executeSubagent">,
) {
  return createReviewAgentDomainOptions({
    ...input,
    executeSubagent: async (request) => await runSubagentTask({
      bindings: {
        abortSignal: request.abortSignal,
        observer: request.observer,
        runIdleTimeoutMs: request.runIdleTimeoutMs,
        workspace: request.workspace,
      },
      profile: request.profile,
      prompt: request.prompt,
      requestExecutionId: request.requestExecutionId,
      runContract: request.runContract,
    }).execute(),
  });
}

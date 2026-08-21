// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type { RequestExecutionIdentity } from "@science-agent/orchestration";
import type { RunStreamEvent } from "@science-agent/schema";

import type { AgentPermissionRuntime } from "@science-agent/governance";

export interface OuterResponseSink {
  emit(event: RunStreamEvent): void;
}

export interface RequestExecutionContext {
  abortSignal: AbortSignal;
  identity: RequestExecutionIdentity;
  permission: AgentPermissionRuntime;
  responseSink: OuterResponseSink;
}

export function createRequestExecutionContext(
  context: RequestExecutionContext,
): RequestExecutionContext {
  return context;
}

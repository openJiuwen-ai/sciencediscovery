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

import type { AgentPermissionRuntime } from "../agent-run/permission-runtime.js";
import type { WebBroker, WebCallContext } from "./broker.js";

export function createWebWorkspaceTools(options: {
  broker: WebBroker;
  context: Omit<WebCallContext, "toolCallId">;
  permission: AgentPermissionRuntime;
}) {
  return {
    webFetch: (toolCallId: string, url: string, signal?: AbortSignal) =>
      options.broker.fetch(url, { ...options.context, toolCallId }, options.permission, signal),
    webSearch: (toolCallId: string, query: string, signal?: AbortSignal) =>
      options.broker.search(query, { ...options.context, toolCallId }, options.permission, signal),
  };
}

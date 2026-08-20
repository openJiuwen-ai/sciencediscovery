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

import type { PermissionAuthorization, PermissionEpoch, PermissionRequest } from "@sciencediscovery/schema";

export type PrivilegedAction = "code" | "connector" | "host";

export interface PrivilegeRequest {
  action: PrivilegedAction;
  executionId?: string;
  resource: string;
  signal?: AbortSignal;
  summary: string;
  toolCallId?: string;
}

export type PermissionCheck =
  | { allowed: true; authorization: PermissionAuthorization }
  | { allowed: false; request: PermissionRequest };

export interface AgentPermissionRuntime {
  getEpoch(): PermissionEpoch;
  requirePrivilege(request: PrivilegeRequest): Promise<PermissionAuthorization>;
}

export interface AgentPermissionRuntimeBindings {
  emitRequired(request: PermissionRequest): void;
  readAuthorization(id: string): PermissionAuthorization | undefined;
  readEpoch(): PermissionEpoch | undefined;
  requestPermission(
    action: PrivilegedAction,
    resource: string,
    summary: string,
    context?: { executionId?: string; toolCallId?: string },
  ): Promise<PermissionCheck>;
  beginExternalWait?: (executionId?: string) => () => void;
  waitForDecision(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionRequest>;
}

/**
 * Root RequestExecution permission cell. All main/correction/subagent AgentRuns
 * share this instance so grants refresh one live epoch reference.
 */
export function createAgentPermissionRuntime(
  initialEpoch: PermissionEpoch,
  bindings: AgentPermissionRuntimeBindings,
): AgentPermissionRuntime {
  let epoch = initialEpoch;
  return {
    getEpoch: () => epoch,
    async requirePrivilege({ action, executionId, resource, signal, summary, toolCallId }) {
      const check = await bindings.requestPermission(action, resource, summary, { executionId, toolCallId });
      if (check.allowed) {
        const currentEpoch = bindings.readEpoch();
        if (currentEpoch) epoch = currentEpoch;
        return check.authorization;
      }

      bindings.emitRequired(check.request);
      const releaseExternalWait = bindings.beginExternalWait?.(executionId);
      let decision: PermissionRequest;
      try {
        decision = await bindings.waitForDecision(check.request, signal);
      } finally {
        releaseExternalWait?.();
      }
      if (decision.state !== "allowed") {
        throw new Error(`Permission denied: ${check.request.summary}`);
      }
      if (!decision.permissionAuthorizationId) throw new Error("Permission decision has no authorization record");
      const authorization = bindings.readAuthorization(decision.permissionAuthorizationId);
      if (!authorization) throw new Error("Permission authorization record was not found");
      const currentEpoch = bindings.readEpoch();
      if (currentEpoch) epoch = currentEpoch;
      return authorization;
    },
  };
}

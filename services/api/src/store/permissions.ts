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

import { randomUUID } from "node:crypto";

import type {
  PermissionAction,
  PermissionAuthorization,
  PermissionAuthorizationSource,
  PermissionEpoch,
  PermissionGrantScope,
} from "@science-agent/schema";

import { DEFAULT_ENVIRONMENT_REVISION_ID } from "../environment.js";

export function createPermissionEpoch(
  sessionId: string,
  reason: string,
  memoryLostReason?: string,
  executeGrantScope?: PermissionGrantScope,
): PermissionEpoch {
  return {
    createdAt: new Date().toISOString(),
    environmentRevisionId: DEFAULT_ENVIRONMENT_REVISION_ID,
    id: randomUUID(),
    ...(executeGrantScope ? { executeGrantScope } : {}),
    mounts: [{ mode: "read-write", source: "workspace" }],
    ...(memoryLostReason ? { memoryLostReason } : {}),
    networkPolicy: "none",
    reason: cleanLabel(reason, "Session created"),
    secretRefs: [],
    sessionId,
  };
}

export function cleanLabel(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, 120);
  return cleaned || fallback;
}

export function permissionMatcherResource(action: PermissionAction, resource: string): string {
  const parts = resource.split(":");
  if (action === "connector") return parts.slice(0, 2).join(":");
  if (action === "artifact_download") return parts.slice(0, 2).join(":");
  if (action === "remote_job") return parts.slice(0, 3).join(":");
  return resource;
}

export function parsePermissionAuthorization(recordJson: string): PermissionAuthorization {
  const authorization = JSON.parse(recordJson) as Omit<PermissionAuthorization, "source"> & {
    source: PermissionAuthorizationSource | "never_ask";
  };
  const { source, ...record } = authorization;
  return { ...record, source: source === "never_ask" ? "always_allow" : source };
}

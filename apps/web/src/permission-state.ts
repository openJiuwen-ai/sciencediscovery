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

import type { PermissionRequest } from "@science-agent/schema";

/** Permission requests are terminal once resolved; delayed SSE must not restore stale buttons. */
export function mergePermissionRequestSnapshot(
  existing: PermissionRequest,
  incoming: PermissionRequest,
): PermissionRequest {
  if (existing.state !== "pending" && incoming.state === "pending") return existing;
  if (existing.state === "pending" && incoming.state !== "pending") return incoming;
  if (existing.state !== "pending" && incoming.state !== "pending") {
    return (incoming.decidedAt ?? "") >= (existing.decidedAt ?? "") ? incoming : existing;
  }
  return incoming;
}

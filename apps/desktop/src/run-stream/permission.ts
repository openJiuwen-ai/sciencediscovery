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

import type { PermissionRequest } from "../api/types.js";
import type { PermissionEntry } from "./model.js";

/**
 * Fold a permission snapshot into the list already held, keyed by request id.
 *
 * The two events that carry these — `permission.required` and
 * `permission.resolved` — send the same `PermissionRequest`, so the merge is
 * what keeps a decision from being undone. The rule that matters: a *pending*
 * snapshot must never overwrite one that has been decided. Live delivery and
 * the replay of a reconnect can interleave in either order, and letting a stale
 * `pending` land would put the buttons back on a request the user just
 * answered.
 *
 * Among two decided snapshots the later `decidedAt` wins, so a re-decision
 * (allow-once followed by a matching grant, say) still updates.
 */
export function mergePermissionSnapshot(
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

/** Merge one snapshot into the entry list, appending a request seen for the
 *  first time. Order is arrival order, which is also the order they were
 *  asked in. */
export function mergePermission(entries: PermissionEntry[], incoming: PermissionRequest): PermissionEntry[] {
  const index = entries.findIndex((entry) => entry.request.id === incoming.id);
  if (index < 0) return [...entries, { request: incoming }];
  return entries.map((entry, position) => (
    position === index ? { request: mergePermissionSnapshot(entry.request, incoming) } : entry
  ));
}

/** The requests still waiting for an answer — the only ones that may show
 *  buttons. Everything else is history. */
export function pendingPermissions(entries: PermissionEntry[]): PermissionRequest[] {
  return entries
    .map((entry) => entry.request)
    .filter((request) => request.state === "pending");
}

/**
 * A key that groups the requests one "allow same type" answer would cover.
 *
 * Answering a request with `allow_matching` decides every *other* pending
 * request that shares this key, and those resolutions arrive as separate
 * events. Without grouping, the buttons on the sibling cards would stay live
 * for the moment between the click and those events landing, and a second click
 * would send a second decision for an already-decided request.
 *
 * The grouping copies the server's own: a connector or artifact-download grant
 * covers the first two colon-separated resource segments, a remote-job grant
 * the first three, and everything else only its exact resource.
 */
export function permissionMatchingKey(request: PermissionRequest): string {
  const parts = request.resource.split(":");
  const resource = request.action === "connector" || request.action === "artifact_download"
    ? parts.slice(0, 2).join(":")
    : request.action === "remote_job"
      ? parts.slice(0, 3).join(":")
      : request.resource;
  return `${request.action}:${resource}`;
}

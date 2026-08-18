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

import { createHash } from "node:crypto";

import {
  DEFAULT_SANDBOX_NETWORK_SETTINGS,
  NO_SANDBOX_NETWORK_ACCESS,
  isSandboxNetworkMode,
  normalizeAllowedDomains,
  type SandboxNetworkAccess,
  type SandboxNetworkSettings,
} from "@science-agent/schema";

/**
 * Sandbox network access settings: the admin-owned policy that decides whether
 * `run_python` / `run_r` / `run_shell` may reach the network, and which domains
 * they may reach. Unrelated to the Web/MCP proxy servers, which govern this
 * service's own outbound calls.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SANDBOX_NETWORK_FIELDS = [
  "allowPrivateNetwork",
  "allowedDomains",
  "mode",
] as const satisfies readonly (keyof SandboxNetworkSettings)[];

export function normalizeSandboxNetworkSettings(value: unknown): SandboxNetworkSettings {
  if (!isRecord(value)) throw new Error("Sandbox network settings must be an object");
  const unknown = Object.keys(value)
    .find((key) => !SANDBOX_NETWORK_FIELDS.includes(key as keyof SandboxNetworkSettings));
  if (unknown) throw new Error(`Unknown sandbox network setting: ${unknown}`);
  const mode = value.mode ?? DEFAULT_SANDBOX_NETWORK_SETTINGS.mode;
  if (!isSandboxNetworkMode(mode)) {
    throw new Error("Sandbox network mode must be none or domain-allowlist");
  }
  const rawDomains = value.allowedDomains ?? [];
  if (!Array.isArray(rawDomains) || rawDomains.some((entry) => typeof entry !== "string")) {
    throw new Error("Allowed domains must be an array of strings");
  }
  const allowPrivateNetwork = value.allowPrivateNetwork ?? false;
  if (typeof allowPrivateNetwork !== "boolean") {
    throw new Error("allowPrivateNetwork must be a boolean");
  }
  const allowedDomains = normalizeAllowedDomains(rawDomains as string[]);
  if (mode === "domain-allowlist" && allowedDomains.length === 0) {
    throw new Error("Sandbox network mode domain-allowlist requires at least one allowed domain");
  }
  return { allowPrivateNetwork, allowedDomains, mode };
}

/** Fill missing fields from the fallback (catalog migration / partial PUT). */
export function resolveSandboxNetworkSettings(
  value: unknown,
  fallback: SandboxNetworkSettings,
): SandboxNetworkSettings {
  if (value === undefined || value === null) return structuredClone(fallback);
  if (!isRecord(value)) throw new Error("Sandbox network settings must be an object");
  return normalizeSandboxNetworkSettings({
    allowPrivateNetwork: value.allowPrivateNetwork ?? fallback.allowPrivateNetwork,
    allowedDomains: value.allowedDomains ?? fallback.allowedDomains,
    mode: value.mode ?? fallback.mode,
  });
}

/**
 * Content-derived policy identity. Two Permission Epochs carrying the same
 * revision granted the same network access, which is what lets the runner
 * reuse one egress gateway across Sessions and what makes a policy change
 * observable as an epoch change.
 */
export function sandboxNetworkRevision(settings: SandboxNetworkSettings): string {
  if (settings.mode === "none") return NO_SANDBOX_NETWORK_ACCESS.revision;
  const canonical = JSON.stringify([settings.mode, settings.allowedDomains, settings.allowPrivateNetwork]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** The immutable snapshot stored on a Permission Epoch. */
export function sandboxNetworkAccess(settings: SandboxNetworkSettings): SandboxNetworkAccess {
  const normalized = normalizeSandboxNetworkSettings(settings);
  if (normalized.mode === "none") return { ...NO_SANDBOX_NETWORK_ACCESS };
  return { ...normalized, revision: sandboxNetworkRevision(normalized) };
}

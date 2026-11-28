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
  PROXY_POLICY_INHERIT,
  isSandboxNetworkMode,
  normalizeAllowedDomains,
  type SandboxNetworkAccess,
  type SandboxNetworkSettings,
} from "@sciencediscovery/schema";

import { normalizeProxyPolicy } from "./settings.js";

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
  "egressProxyPolicy",
  "mode",
] as const satisfies readonly (keyof SandboxNetworkSettings)[];

/**
 * A body this module refuses is the caller's own input, whatever wording the
 * validator chose. The code is the stable signal the HTTP catch-all maps to
 * 400, so the route keeps answering 500 for the catalog write that follows the
 * validation in the same save.
 */
const INVALID_SANDBOX_NETWORK_SETTINGS = "INVALID_SANDBOX_NETWORK_SETTINGS";

function rejectSandboxNetworkSettings(message: string): Error {
  return Object.assign(new Error(message), { code: INVALID_SANDBOX_NETWORK_SETTINGS });
}

/** The schema validators only check input; keep their sentences and tag them. */
function normalizeSandboxAllowedDomains(entries: readonly string[]): string[] {
  try {
    return normalizeAllowedDomains(entries);
  } catch (error) {
    throw rejectSandboxNetworkSettings(error instanceof Error ? error.message : String(error));
  }
}

function normalizeEgressProxyPolicy(value: unknown): SandboxNetworkSettings["egressProxyPolicy"] {
  try {
    return normalizeProxyPolicy(value, "egressProxyPolicy");
  } catch (error) {
    throw rejectSandboxNetworkSettings(error instanceof Error ? error.message : String(error));
  }
}

export function normalizeSandboxNetworkSettings(value: unknown): SandboxNetworkSettings {
  if (!isRecord(value)) throw rejectSandboxNetworkSettings("Sandbox network settings must be an object");
  const unknown = Object.keys(value)
    .find((key) => !SANDBOX_NETWORK_FIELDS.includes(key as keyof SandboxNetworkSettings));
  if (unknown) throw rejectSandboxNetworkSettings(`Unknown sandbox network setting: ${unknown}`);
  const mode = value.mode ?? DEFAULT_SANDBOX_NETWORK_SETTINGS.mode;
  if (!isSandboxNetworkMode(mode)) {
    throw rejectSandboxNetworkSettings("Sandbox network mode must be none, domain-allowlist or open");
  }
  const rawDomains = value.allowedDomains ?? [];
  if (!Array.isArray(rawDomains) || rawDomains.some((entry) => typeof entry !== "string")) {
    throw rejectSandboxNetworkSettings("Allowed domains must be an array of strings");
  }
  const allowPrivateNetwork = value.allowPrivateNetwork ?? false;
  if (typeof allowPrivateNetwork !== "boolean") {
    throw rejectSandboxNetworkSettings("allowPrivateNetwork must be a boolean");
  }
  const allowedDomains = normalizeSandboxAllowedDomains(rawDomains as string[]);
  if (mode === "domain-allowlist" && allowedDomains.length === 0) {
    throw rejectSandboxNetworkSettings("Sandbox network mode domain-allowlist requires at least one allowed domain");
  }
  if (mode === "open" && allowedDomains.length > 0) {
    throw rejectSandboxNetworkSettings("Sandbox network mode open does not use allowed domains; remove them or use domain-allowlist");
  }
  // Catalogs written before this field existed behave as the shared default.
  const egressProxyPolicy = normalizeEgressProxyPolicy(value.egressProxyPolicy ?? PROXY_POLICY_INHERIT);
  return { allowPrivateNetwork, allowedDomains, egressProxyPolicy, mode };
}

/** Fill missing fields from the fallback (catalog migration / partial PUT). */
export function resolveSandboxNetworkSettings(
  value: unknown,
  fallback: SandboxNetworkSettings,
): SandboxNetworkSettings {
  if (value === undefined || value === null) return structuredClone(fallback);
  if (!isRecord(value)) throw rejectSandboxNetworkSettings("Sandbox network settings must be an object");
  return normalizeSandboxNetworkSettings({
    allowPrivateNetwork: value.allowPrivateNetwork ?? fallback.allowPrivateNetwork,
    allowedDomains: value.allowedDomains ?? fallback.allowedDomains,
    egressProxyPolicy: value.egressProxyPolicy ?? fallback.egressProxyPolicy,
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
  // The egress proxy policy is part of the identity: changing it changes where
  // allowed traffic leaves from, so the epoch — and with it every persistent
  // kernel and shell — has to rotate.
  const canonical = JSON.stringify([
    settings.mode,
    settings.allowedDomains,
    settings.allowPrivateNetwork,
    settings.egressProxyPolicy,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** The immutable snapshot stored on a Permission Epoch. */
export function sandboxNetworkAccess(settings: SandboxNetworkSettings): SandboxNetworkAccess {
  const normalized = normalizeSandboxNetworkSettings(settings);
  if (normalized.mode === "none") return { ...NO_SANDBOX_NETWORK_ACCESS };
  return { ...normalized, revision: sandboxNetworkRevision(normalized) };
}

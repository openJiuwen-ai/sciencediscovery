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

/**
 * Sandbox network access: the policy that decides whether `run_python`,
 * `run_r` and `run_shell` may reach the network, and which domains they may
 * reach. This is deliberately NOT the Web/MCP outbound proxy configuration —
 * that one governs the API/Gateway's own outbound calls and lives in
 * `proxy.ts`. Product wording for this capability is "sandbox network access"
 * and "allowed domains"; the outbound environment variables the runner injects
 * inside the sandbox are a client-library compatibility detail, not the
 * product concept.
 *
 * Pure contract + matching logic only: this module is bundled into the browser,
 * so it must stay free of Node built-ins.
 */

export const SANDBOX_NETWORK_MODES = ["none", "domain-allowlist"] as const;

/**
 * `none` keeps the sandbox without any network interface (the default).
 * `domain-allowlist` keeps the sandbox network namespace unshared as well and
 * routes outbound traffic through the runner's egress gateway, which allows
 * only the configured domains.
 */
export type SandboxNetworkMode = typeof SANDBOX_NETWORK_MODES[number];

export function isSandboxNetworkMode(value: unknown): value is SandboxNetworkMode {
  return SANDBOX_NETWORK_MODES.includes(value as SandboxNetworkMode);
}

/** Admin-owned system configuration. */
export interface SandboxNetworkSettings {
  /**
   * Allow the egress gateway to reach loopback, link-local and private
   * addresses. Off by default: with it on, an allowed domain that resolves
   * into the deployment's own network can reach internal services.
   */
  allowPrivateNetwork: boolean;
  /**
   * Allowed domains. Entries are `host`, `*.host` (label-boundary wildcard) or
   * either form with a `:port` suffix restricting the entry to that port.
   */
  allowedDomains: string[];
  mode: SandboxNetworkMode;
}

export const DEFAULT_SANDBOX_NETWORK_SETTINGS: SandboxNetworkSettings = {
  allowPrivateNetwork: false,
  allowedDomains: [],
  mode: "none",
};

/**
 * The immutable policy snapshot carried by a Permission Epoch. `revision` is
 * derived from the normalized policy content, so two epochs with the same
 * revision were granted the same network access.
 */
export interface SandboxNetworkAccess extends SandboxNetworkSettings {
  revision: string;
}

/** Revision of the always-available "no network" policy. */
export const NO_NETWORK_REVISION = "none";

export const NO_SANDBOX_NETWORK_ACCESS: SandboxNetworkAccess = {
  ...DEFAULT_SANDBOX_NETWORK_SETTINGS,
  revision: NO_NETWORK_REVISION,
};

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface AllowedDomainEntry {
  host: string;
  /** `undefined` allows any port; a number restricts the entry to that port. */
  port?: number;
  /** `true` for `*.example.org`: subdomains only, never the apex itself. */
  wildcard: boolean;
}

export function isIpLiteral(host: string): boolean {
  return IPV4.test(host) || host.includes(":") || host.startsWith("[");
}

/**
 * Parse one allowed-domain entry. Rejects IP literals (the gateway filters by
 * domain; an IP entry would silently bypass the concept) and anything that is
 * not a plain host, so a mistyped `https://example.org/path` fails loudly at
 * configuration time instead of never matching at runtime.
 */
export function parseAllowedDomain(entry: string): AllowedDomainEntry {
  const trimmed = entry.trim().toLowerCase();
  if (!trimmed) throw new Error("An allowed domain must not be empty");
  if (trimmed.includes("/") || trimmed.includes("@") || /\s/.test(trimmed)) {
    throw new Error(`Allowed domain "${entry}" must be a bare host such as example.org or *.example.org`);
  }
  const separator = trimmed.lastIndexOf(":");
  const hostPart = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const portPart = separator === -1 ? undefined : trimmed.slice(separator + 1);
  let port: number | undefined;
  if (portPart !== undefined) {
    port = Number(portPart);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Allowed domain "${entry}" has an invalid port`);
    }
  }
  const wildcard = hostPart.startsWith("*.");
  const host = wildcard ? hostPart.slice(2) : hostPart;
  if (isIpLiteral(host)) {
    throw new Error(`Allowed domain "${entry}" must be a domain name, not an IP address`);
  }
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) {
    throw new Error(`Allowed domain "${entry}" is not a valid domain name`);
  }
  return { host, ...(port === undefined ? {} : { port }), wildcard };
}

export function formatAllowedDomain(entry: AllowedDomainEntry): string {
  return `${entry.wildcard ? "*." : ""}${entry.host}${entry.port === undefined ? "" : `:${entry.port}`}`;
}

/** Validate, lower-case, de-duplicate and sort so the revision is stable. */
export function normalizeAllowedDomains(entries: readonly string[]): string[] {
  const normalized = entries
    .map((entry) => formatAllowedDomain(parseAllowedDomain(entry)));
  return [...new Set(normalized)].toSorted();
}

/**
 * Does `host:port` match the allowlist? A wildcard entry matches strictly at a
 * label boundary and never the apex, so `*.example.org` allows
 * `api.example.org` but neither `example.org` nor `evil-example.org`.
 */
export function allowedDomainMatches(allowedDomains: readonly string[], host: string, port: number): boolean {
  const target = host.trim().toLowerCase().replace(/\.$/, "");
  if (!target || isIpLiteral(target)) return false;
  return allowedDomains.some((candidate) => {
    let entry: AllowedDomainEntry;
    try {
      entry = parseAllowedDomain(candidate);
    } catch {
      return false;
    }
    if (entry.port !== undefined && entry.port !== port) return false;
    return entry.wildcard
      ? target.endsWith(`.${entry.host}`)
      : target === entry.host;
  });
}

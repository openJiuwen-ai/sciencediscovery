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
 * The settings pages' value translations, kept pure.
 *
 * What is left here is text-shaped and testable without a DOM: the proxy
 * policy vocabulary, the Runner state label, and the sandbox allowlist box
 * read as entries. Anything that only the components can decide stays in
 * them.
 */

import { TEXT } from "../text.js";
import type { ProxyPolicy } from "../api/types.js";

/**
 * The allowlist box, read as entries.
 *
 * One per line is what the placeholder shows, but a comma-separated paste is
 * the same list and refusing it would only make the box feel literal. The
 * entries are left as typed: the service parses, lower-cases, de-duplicates
 * and sorts them, so doing any of that here would be a second, looser opinion
 * on what is valid.
 */
export function domainEntries(text: string): string[] {
  return text
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** Where a `proxy:<id>` policy points, or the named policy itself. */
export function proxyPolicyServerId(policy: ProxyPolicy): string | undefined {
  return policy.startsWith("proxy:") ? policy.slice("proxy:".length) : undefined;
}

/** Runner states arrive as free strings from the remote host; unknown ones are
 *  shown as they came rather than guessed at. */
export function runnerStateLabel(state: string | undefined): string {
  if (!state) return TEXT.settings.runtime.runner.noDetail;
  return TEXT.settings.runtime.runner.state[state] ?? state;
}

export function runnerStateTone(state: string | undefined): "ok" | "warn" | "off" {
  if (state === "ready") return "ok";
  if (state === undefined || state === "stopped" || state === "disconnected") return "off";
  return "warn";
}

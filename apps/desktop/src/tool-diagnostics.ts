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

import { TEXT } from "./text.js";

/**
 * A runner timeout, an egress decision and a proxy tunnel failure are written
 * where no UI locale is known, so they reach the chat as English sentences
 * inside the tool result (#1382). The run-failure card already re-renders the
 * diagnostics it recognizes; this module gives the tool-result surface the
 * same treatment: each stable terminal wording is recognized and regenerated
 * through the active dictionary, and anything else is returned untouched.
 *
 * A gateway reason is matched only at the start of a line or after `; ` — the
 * places `egress-gateway.ts` writes one — never by scanning an arbitrary offset
 * with an unbounded host token. That keeps a 100 KB single-line result linear
 * instead of quadratic, and lets several reasons on one line be replaced
 * separately. The host token is length-bounded as a second guard. The proxy
 * client's tunnel sentence has a fixed onset but arrives inside a Python
 * traceback or exception repr, so it is matched wherever that literal occurs.
 *
 * A host is `[::1]` for an IPv6 egress reason and a non-space, non-separator
 * token otherwise. The patterns name the exact sentences produced by
 * `executor.ts`, `egress-gateway.ts` and the proxy client, so a program's own
 * log line is only rewritten when it reproduces one of those exact sentences;
 * the timeout labels are the six `executor.ts`/`kernel-manager.ts`/
 * `shell-session-manager.ts` emits.
 */
const TIMEOUT =
  /\b(Direct shell execution|Shell execution|Python execution|R execution|Persistent kernel evaluation|Persistent shell evaluation) timed out after (\d+) ms\b/g;
const NETWORK_DISABLED = /(^|; )([ \t]*)sandbox network access is disabled for this execution\b/gm;
const DOMAIN_NOT_ALLOWED =
  /(^|; )([ \t]*)(\[[^\]\s;]{1,64}\]|[^\s:;]{1,512}):(\d{1,5}) is not in the sandbox network allowed domains\b/gm;
const IP_LITERAL =
  /(^|; )([ \t]*)(\[[^\]\s;]{1,64}\]|[^\s;]{1,512}) is an IP address; sandbox network access allows domain names only\b/gm;
const PRIVATE_ADDRESS =
  /(^|; )([ \t]*)(\[[^\]\s;]{1,64}\]|[^\s;]{1,512}) is a private address; enable private network access to allow it\b/gm;
const PRIVATE_RESOLUTION =
  /(^|; )([ \t]*)(\[[^\]\s;]{1,64}\]|[^\s;]{1,512}) resolves only to private or loopback addresses; enable private network access to allow it\b/gm;
const RESOLVE_FAILED =
  /(^|; )([ \t]*)(\[[^\]\s;]{1,64}\]|[^\s;]{1,512}) could not be resolved: ([^;\n]+)/gm;
const UNREACHABLE =
  /(^|; )([ \t]*)Sandbox network access could not reach ([^\s;]{1,512}) through this deployment's outbound route\b/gm;
const ABSOLUTE_FORM =
  /(^|; )([ \t]*)Sandbox network access expects absolute-form proxy requests\b/gm;
const CANNOT_FORWARD =
  /(^|; )([ \t]*)Sandbox network access cannot forward ([^\s;]{1,512}) without CONNECT\b/gm;
const TUNNEL_FAILED = /Tunnel connection failed: ([^\n]+)/g;

const keep = (boundary: string, indent: string) => `${boundary}${indent}`;

/**
 * Regenerate the diagnostics a tool result carries in the active language.
 * Every substitution reads `TEXT` at call time, so a language switch applies to
 * a result that is rendered again, and the English dictionary keeps the
 * producer's original sentence.
 */
export function localizeToolDiagnostics(text: string): string {
  if (text === "") return text;
  return text
    .replace(TIMEOUT, (_match: string, label: string, timeoutMs: string) =>
      TEXT.toolDiagnostics.timeout(label, Number(timeoutMs)))
    .replace(NETWORK_DISABLED, (_match: string, boundary: string, indent: string) =>
      keep(boundary, indent) + TEXT.toolDiagnostics.networkDisabled)
    .replace(DOMAIN_NOT_ALLOWED, (_match: string, boundary: string, indent: string, host: string, port: string) =>
      keep(boundary, indent) + TEXT.toolDiagnostics.domainNotAllowed(host, Number(port)))
    .replace(IP_LITERAL, (_match: string, boundary: string, indent: string, host: string) =>
      keep(boundary, indent) + TEXT.toolDiagnostics.ipLiteral(host))
    .replace(PRIVATE_ADDRESS, (_match: string, boundary: string, indent: string, host: string) =>
      keep(boundary, indent) + TEXT.toolDiagnostics.privateAddress(host))
    .replace(PRIVATE_RESOLUTION, (_match: string, boundary: string, indent: string, host: string) =>
      keep(boundary, indent) + TEXT.toolDiagnostics.privateResolution(host))
    .replace(RESOLVE_FAILED, (_match: string, boundary: string, indent: string, host: string, detail: string) =>
      keep(boundary, indent) + TEXT.toolDiagnostics.resolveFailed(host, detail))
    .replace(UNREACHABLE, (_match: string, boundary: string, indent: string, target: string) =>
      keep(boundary, indent) + TEXT.toolDiagnostics.unreachable(target))
    .replace(ABSOLUTE_FORM, (_match: string, boundary: string, indent: string) =>
      keep(boundary, indent) + TEXT.toolDiagnostics.absoluteForm)
    .replace(CANNOT_FORWARD, (_match: string, boundary: string, indent: string, protocol: string) =>
      keep(boundary, indent) + TEXT.toolDiagnostics.cannotForward(protocol))
    .replace(TUNNEL_FAILED, (_match: string, status: string) => TEXT.toolDiagnostics.tunnelFailed(status));
}

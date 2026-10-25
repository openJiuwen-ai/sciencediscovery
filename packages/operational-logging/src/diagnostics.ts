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

import { redactLogText } from "./redaction.js";

export interface DiagnosticIds { requestId?: string; runId?: string; sessionId?: string }
export interface DiagnosticSnapshot { logs: string[]; logStatus: "available" | "unavailable" }
export interface ErrorDiagnostic extends DiagnosticIds {
  title: string;
  detail?: string;
  version: string;
  os: string;
  locale: string;
  snapshot?: DiagnosticSnapshot;
}

export const DIAGNOSTIC_MAX_CHARS = 4000;
export const DIAGNOSTIC_MAX_ENCODED = 6500;
export const DIAGNOSTIC_LOG_LINES = 5;
const ISSUE_PAGE = "https://github.com/openJiuwen-ai/sciencediscovery/issues/new";
const TRUNCATED = "\n[truncated]";

/** Redact before truncating, so a cap can never cut off the sensitive key. */
export function diagnosticText(value: string, limit: number, encodedLimit = Number.POSITIVE_INFINITY): string {
  const safe = redactLogText(value.toWellFormed()).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  let bounded = safe.length <= limit ? safe : `${safe.slice(0, limit - TRUNCATED.length).toWellFormed()}${TRUNCATED}`;
  while (encodeURIComponent(bounded).length > encodedLimit) {
    bounded = `${bounded.slice(0, -TRUNCATED.length - 20).toWellFormed()}${TRUNCATED}`;
  }
  return bounded;
}

export function formatErrorDiagnostic(input: ErrorDiagnostic): string {
  const text = [
    "ScienceDiscovery error diagnostics",
    `Version/build: ${diagnosticText(input.version, 120, 200)}`,
    `OS: ${diagnosticText(input.os, 100, 200)}`,
    `UI locale: ${diagnosticText(input.locale, 32, 50)}`,
    ...(["requestId", "runId", "sessionId"] as const).flatMap(key => input[key] ? [`${key}: ${diagnosticText(input[key]!, 96, 100)}`] : []),
    `Error: ${diagnosticText(input.title, 140, 400)}`,
    diagnosticText(input.detail ?? "", 900, 1800),
    "Related service logs (metadata only, last 5 lines):",
    ...(input.snapshot?.logs.length ? input.snapshot.logs.slice(-DIAGNOSTIC_LOG_LINES).map(line => diagnosticText(line, 350, 450)) : ["Unavailable: no matching local log metadata or service unreachable."]),
  ].join("\n");
  // The same bundle fits both the clipboard and the URL, including CJK text.
  let bounded = diagnosticText(text, DIAGNOSTIC_MAX_CHARS);
  while (encodeURIComponent(bounded).length > DIAGNOSTIC_MAX_ENCODED) {
    bounded = `${bounded.slice(0, -100).toWellFormed()}${TRUNCATED}`;
  }
  return bounded;
}

export function errorIssueUrl(title: string, diagnostic: string): string {
  const url = new URL(ISSUE_PAGE);
  url.searchParams.set("title", `[Bug]: ${diagnosticText(title, 120).replace(/\s+/g, " ")}`);
  url.searchParams.set("body", `Please describe what you were doing and how to reproduce the failure. Review diagnostics before submitting.\n\n${diagnosticText(diagnostic, DIAGNOSTIC_MAX_CHARS, DIAGNOSTIC_MAX_ENCODED)}`);
  return url.toString();
}

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

const SENSITIVE_KEY = /(?:authorization|cookie|api[-_]?key|token|password|secret)/i;
const BULK_PAYLOAD_KEY = /^(?:args|arguments|body|content|input|messages?|output|prompt|request|response|stderr|stdout)$/i;
const SENSITIVE_ASSIGNMENT = /\b([\w-]*(?:token|secret|password)|api[-_]?key|authorization|cookie)\b["']?\s*[:=]\s*["']?(?:bearer\s+)?[^\s,;"'}]+/gi;
const BEARER_VALUE = /\bbearer\s+[a-z0-9._~+\/-]+=*/gi;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const SENSITIVE_QUERY_VALUE = /([?&](?:api[-_]?key|access[-_]?token|token|password|secret)=)[^&#\s]+/gi;

// Match complete username segments, including Windows paths escaped in JSON.
const UNIX_HOME = /(\/(?:home|Users)\/)[^/\\\r\n]+/g;
const WINDOWS_HOME = /(\b[a-z]:[\\/]+Users[\\/]+)[^\\/\r\n]+/gi;

export function redactLogText(value: string): string {
  return value
    .replace(UNIX_HOME, "$1[REDACTED]")
    .replace(WINDOWS_HOME, "$1[REDACTED]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED]")
    .replace(/\b(authorization|(?:set-)?cookie)\s*[:=]\s*[^\r\n]+/gi, "$1=[REDACTED]")
    .replace(/(["']?(?:[\w-]*(?:token|secret|password)|api[-_]?key|authorization|(?:set-)?cookie)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, "$1\"[REDACTED]\"")
    .replace(/\b(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{8,})\b/gi, "[REDACTED]")
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(SENSITIVE_QUERY_VALUE, "$1[REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT, "$1=[REDACTED]")
    .replace(BEARER_VALUE, "Bearer [REDACTED]");
}

export function shortErrorMessage(error: unknown, maxLength = 500): string {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return redactLogText(message).replace(/[\r\n\t]+/g, " ").slice(0, maxLength);
}

export function redactLogValue(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (key && BULK_PAYLOAD_KEY.test(key)) return "[OMITTED]";
  if (typeof value === "string") return redactLogText(value);
  if (value instanceof Error) {
    return { errorMessage: redactLogText(value.message), errorName: value.name };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const redacted = value.map((entry) => redactLogValue(entry, undefined, seen));
    seen.delete(value);
    return redacted;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const redacted = Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactLogValue(entryValue, entryKey, seen)]),
    );
    seen.delete(value);
    return redacted;
  }
  return value;
}

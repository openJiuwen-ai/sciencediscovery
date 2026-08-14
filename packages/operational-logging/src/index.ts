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

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface OperationalLogger {
  readonly path: string;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface OperationalLoggerOptions {
  category: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  service: string;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_BACKUP_COUNT = 5;
const SENSITIVE_KEY = /(?:authorization|api[-_]?key|token|password|secret)/i;
const BULK_PAYLOAD_KEY = /^(?:args|arguments|body|content|input|messages?|output|prompt|request|response|stderr|stdout)$/i;
const SENSITIVE_ASSIGNMENT = /\b(authorization|api[-_]?key|token|password|secret)\b["']?\s*[:=]\s*["']?(?:bearer\s+)?[^\s,;"'}]+/gi;
const BEARER_VALUE = /\bbearer\s+[a-z0-9._~+\/-]+=*/gi;

function parseLevel(raw: string | undefined): LogLevel {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "warning") return "warn";
  return normalized && normalized in LEVELS ? normalized as LogLevel : "info";
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function redactLogText(value: string): string {
  return value
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

function formatValue(value: unknown): string {
  const redacted = redactLogValue(value);
  if (typeof redacted === "string" && /^[a-zA-Z0-9._:@/+\-]+$/.test(redacted)) return redacted;
  try {
    return JSON.stringify(redacted);
  } catch {
    return JSON.stringify("[Unserializable]");
  }
}

function rotate(path: string, backupCount: number): void {
  for (let index = backupCount - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    if (!existsSync(source)) continue;
    const destination = `${path}.${index + 1}`;
    if (existsSync(destination)) rmSync(destination);
    renameSync(source, destination);
  }
  if (existsSync(`${path}.1`)) rmSync(`${path}.1`);
  renameSync(path, `${path}.1`);
}

export function createOperationalLogger(options: OperationalLoggerOptions): OperationalLogger {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.category)) {
    throw new Error("Log category must contain only lowercase letters, digits, and hyphens");
  }
  const env = options.env ?? process.env;
  const threshold = LEVELS[parseLevel(env.SCIENCE_AGENT_LOG_LEVEL)];
  const maxBytes = parsePositiveInteger(env.SCIENCE_AGENT_LOG_MAX_BYTES, DEFAULT_MAX_BYTES);
  const backupCount = parsePositiveInteger(env.SCIENCE_AGENT_LOG_BACKUP_COUNT, DEFAULT_BACKUP_COUNT);
  const logDir = env.SCIENCE_AGENT_LOG_DIR?.trim()
    ? resolve(env.SCIENCE_AGENT_LOG_DIR.trim())
    : resolve(options.dataDir, "logs");
  const path = resolve(logDir, `${options.category}.log`);

  try {
    mkdirSync(logDir, { recursive: true });
    closeSync(openSync(path, "a"));
  } catch {
    // Logging is best-effort and must never prevent a service from starting.
  }

  const write = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    if (LEVELS[level] < threshold) return;
    const safeEvent = redactLogText(event).replace(/[\r\n]+/g, " ");
    const serializedFields = Object.entries(fields)
      .map(([key, value]) => `${key}=${formatValue(redactLogValue(value, key))}`)
      .join(" ");
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${options.service}] event=${safeEvent}`
      + `${serializedFields ? ` ${serializedFields}` : ""}\n`;
    try {
      mkdirSync(logDir, { recursive: true });
      if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > maxBytes) {
        rotate(path, backupCount);
      }
      appendFileSync(path, line, "utf8");
    } catch {
      // Disk errors, rotation races, and permission failures never break work.
    }
  };

  return {
    path,
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

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

import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const MAX_PROMPT_CHARACTERS = 48_000;
const MAX_TOOL_CHARACTERS = 12_000;
const MAX_MODEL_OUTPUT_CHARACTERS = 32_000;

let logDir: string | undefined;

export interface ReviewerLogContext {
  artifactLogicalName: string;
  artifactVersionId: string;
  checkpointId: string;
  executionId: string;
  sessionId: string;
}

function logPath(): string {
  const directory = logDir ?? resolve(process.cwd(), "logs");
  mkdirSync(directory, { recursive: true });
  return resolve(directory, "reviewer-specialist.ndjson");
}

function redact(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[^\s"']+/giu, "$1[REDACTED]")
    .replace(/\b(api[_-]?key|token|password)\s*[:=]\s*[^\s,"'}]+/giu, "$1=[REDACTED]");
}

/** A bounded, redacted error excerpt that is safe to retain or show in Reviewer UI. */
function safeText(value: unknown, maximum = 600): string {
  if (value instanceof Error) return safeText(value.message, maximum);
  if (typeof value !== "string") return "Unknown Reviewer execution error";
  const text = redact(value).replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, maximum) : "Unknown Reviewer execution error";
}

function clipped(value: unknown, maximum: number): { text: string; truncated: boolean } | undefined {
  if (typeof value !== "string") return undefined;
  const text = redact(value);
  return { text: text.slice(0, maximum), truncated: text.length > maximum };
}

function jsonValue(value: unknown, maximum: number): unknown {
  if (value === undefined || value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return clipped(value, maximum);
  const seen = new WeakSet<object>();
  const normalize = (item: unknown): unknown => {
    if (item === undefined || item === null || typeof item === "number" || typeof item === "boolean") return item;
    if (typeof item === "string") return clipped(item, maximum);
    if (typeof item !== "object") return String(item);
    if (seen.has(item)) return "[circular log value]";
    seen.add(item);
    if (Array.isArray(item)) return item.map(normalize);
    return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, normalize(nested)]));
  };
  return normalize(value);
}

/**
 * Best-effort, append-only local Reviewer trace. It deliberately omits model
 * thinking deltas, but preserves the prompt, allowed tool activity, final model
 * output, and errors needed to reproduce a Deep review outcome.
 */
export const reviewerLog = {
  setLogDir(directory: string): void {
    logDir = resolve(directory);
  },
  event(context: ReviewerLogContext, event: string, details: Record<string, unknown> = {}): void {
    const record = {
      artifact: {
        logicalName: context.artifactLogicalName,
        versionId: context.artifactVersionId,
      },
      checkpointId: context.checkpointId,
      details: Object.fromEntries(Object.entries(details).map(([key, value]) => [
        key,
        key === "prompt"
          ? clipped(value, MAX_PROMPT_CHARACTERS)
          : key === "modelOutput"
            ? clipped(value, MAX_MODEL_OUTPUT_CHARACTERS)
            : jsonValue(value, MAX_TOOL_CHARACTERS),
      ])),
      event,
      executionId: context.executionId,
      sessionId: context.sessionId,
      timestamp: new Date().toISOString(),
    };
    try {
      appendFileSync(logPath(), `${JSON.stringify(record)}\n`);
    } catch (error) {
      // Logging cannot make an Artifact review fail.
      console.error("[reviewer-specialist] failed to write execution log", error);
    }
  },
  safeText,
};

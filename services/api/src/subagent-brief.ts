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

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

import type { JsonSchema, SubagentBrief } from "@sciencediscovery/schema";

const BRIEF_GOAL_LIMIT = 2_000;
const BRIEF_ITEM_LIMIT = 1_000;
const BRIEF_SCHEMA_BYTES_LIMIT = 20_000;
const BRIEF_SCHEMA_DEPTH_LIMIT = 64;
const BRIEF_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateSchema: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (!cleaned) throw new Error(`${field} is required`);
  if (cleaned.length > maxLength) throw new Error(`${field} must contain at most ${maxLength} characters`);
  return cleaned;
}

function normalizedTextList(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${field} requires at least one item`);
  const cleaned = value.map((item) => normalizedText(item, field, BRIEF_ITEM_LIMIT));
  if (cleaned.length > maxItems) throw new Error(`${field} supports at most ${maxItems} items`);
  return cleaned;
}

function maxJsonDepth(value: unknown, seen = new WeakSet<object>()): number {
  if (!value || typeof value !== "object") return 0;
  if (seen.has(value)) throw new Error("Subagent output JSON schema must be serializable JSON");
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  return 1 + Math.max(0, ...children.map((child) => maxJsonDepth(child, seen)));
}

export function assertValidSubagentOutputSchema(value: unknown): asserts value is JsonSchema {
  if (!isRecord(value)) throw new Error("Subagent output JSON schema must be an object");
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Subagent output JSON schema must be serializable JSON");
  }
  if (serialized.length > BRIEF_SCHEMA_BYTES_LIMIT) {
    throw new Error(`Subagent output JSON schema must not exceed ${BRIEF_SCHEMA_BYTES_LIMIT} bytes`);
  }
  if (maxJsonDepth(value) > BRIEF_SCHEMA_DEPTH_LIMIT) {
    throw new Error(`Subagent output JSON schema must not exceed depth ${BRIEF_SCHEMA_DEPTH_LIMIT}`);
  }
  try {
    ajv.compile(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Subagent output JSON schema is invalid for ${BRIEF_SCHEMA_DIALECT}: ${message}`);
  }
}

export function validateSubagentOutputValue(value: unknown, schema: JsonSchema): string[] {
  assertValidSubagentOutputSchema(schema);
  const validator = ajv.compile(schema);
  if (validator(value)) return [];
  return (validator.errors ?? []).map((error: ErrorObject) => {
    const location = error.instancePath ? `$${error.instancePath}` : "$";
    return `${location} ${error.message ?? "failed validation"}`;
  });
}

export function normalizeSubagentBrief(value: unknown, options: { version?: number } = {}): SubagentBrief | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("Subagent brief must be an object");
  if (value.outputJsonSchema !== undefined) assertValidSubagentOutputSchema(value.outputJsonSchema);
  return {
    collaborationRules: normalizedTextList(value.collaborationRules, "Subagent collaboration rules", 12),
    constraints: normalizedTextList(value.constraints, "Subagent constraints", 20),
    goal: normalizedText(value.goal, "Subagent goal", BRIEF_GOAL_LIMIT),
    ...(value.outputJsonSchema ? { outputJsonSchema: structuredClone(value.outputJsonSchema) } : {}),
    outputRequirements: normalizedTextList(value.outputRequirements, "Subagent output requirements", 20),
    ...(options.version === undefined ? {} : { version: options.version }),
  };
}

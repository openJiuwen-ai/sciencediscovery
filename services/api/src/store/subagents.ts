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

import { randomUUID } from "node:crypto";

import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
} from "@sciencediscovery/orchestration";
import type {
  ModelRunInfo,
  Subagent,
  SubagentBrief,
  SubagentInput,
  SubagentResultValidation,
} from "@sciencediscovery/schema";

import { normalizeSubagentBrief } from "../subagent-brief.js";
import { hasOwn, isRecord } from "./catalog.js";

function persistedBriefVersion(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const version = Number(value.version);
  return Number.isInteger(version) && version >= 1 && version <= 1000 ? version : undefined;
}

export function normalizePersistedSubagent(value: unknown): Subagent | undefined {
  if (!isRecord(value)) return undefined;
  const rawInput = isRecord(value.input) ? value.input : undefined;
  const legacyBrief = isRecord(value.brief) ? value.brief : undefined;
  const description = typeof rawInput?.description === "string"
    ? rawInput.description
    : typeof legacyBrief?.title === "string" ? legacyBrief.title : "Migrated subagent";
  const legacyPrompt = legacyBrief ? [
    typeof legacyBrief.role === "string" ? `Role: ${legacyBrief.role}` : "",
    typeof legacyBrief.title === "string" ? `Task: ${legacyBrief.title}` : "",
    Array.isArray(legacyBrief.intendedSteps)
      ? `Intended steps:\n${legacyBrief.intendedSteps.map((step, index) => `${index + 1}. ${String(step)}`).join("\n")}`
      : "",
    typeof legacyBrief.outputSchema === "string" ? `Required output schema:\n${legacyBrief.outputSchema}` : "",
  ].filter(Boolean).join("\n\n") : "";
  const prompt = typeof rawInput?.prompt === "string" ? rawInput.prompt : legacyPrompt || description;
  const specialistId = typeof rawInput?.specialistId === "string"
    ? rawInput.specialistId
    : typeof value.specialistId === "string" ? value.specialistId : undefined;
  let brief: SubagentBrief | undefined;
  try {
    const version = persistedBriefVersion(rawInput?.brief);
    brief = normalizeSubagentBrief(rawInput?.brief, version ? { version } : {});
  } catch {
    brief = undefined;
  }
  const input: SubagentInput = {
    ...(brief ? { brief } : {}),
    description,
    ...(Array.isArray(rawInput?.inputPaths)
      ? { inputPaths: rawInput.inputPaths.filter((item): item is string => typeof item === "string") }
      : {}),
    prompt,
    ...(specialistId ? { specialistId } : {}),
    subagentType: typeof rawInput?.subagentType === "string" ? rawInput.subagentType : "general-purpose",
    ...(Array.isArray(rawInput?.tools)
      ? { tools: rawInput.tools.filter((tool): tool is string => typeof tool === "string") }
      : rawInput?.tools === null ? { tools: null } : {}),
  };
  const persistedStatus = ["cancelled", "completed", "failed", "running", "timed_out"].includes(String(value.status))
    ? value.status as Subagent["status"]
    : "failed";
  const interrupted = persistedStatus === "running";
  const recoveredAt = interrupted ? new Date().toISOString() : undefined;
  const status: Subagent["status"] = interrupted ? "failed" : persistedStatus;
  const error = typeof value.error === "string"
    ? value.error
    : interrupted ? "Subagent interrupted by API restart before completion" : undefined;
  const finishedAt = typeof value.finishedAt === "string" ? value.finishedAt : recoveredAt;
  const rawHandoff = isRecord(value.handoff) ? value.handoff : undefined;
  const handoff = rawHandoff
    && Array.isArray(rawHandoff.inputPaths)
    && typeof rawHandoff.manifestPath === "string"
    && typeof rawHandoff.privateWorkspacePath === "string"
    ? {
        inputPaths: rawHandoff.inputPaths.filter((item): item is string => typeof item === "string"),
        manifestPath: rawHandoff.manifestPath,
        privateWorkspacePath: rawHandoff.privateWorkspacePath,
        ...(Array.isArray(rawHandoff.skippedInputPaths) ? {
          skippedInputPaths: rawHandoff.skippedInputPaths.flatMap((item) => {
            if (!isRecord(item) || typeof item.path !== "string" || typeof item.reason !== "string") return [];
            return [{
              path: item.path,
              reason: item.reason,
              ...(typeof item.size === "number" ? { size: item.size } : {}),
            }];
          }),
        } : {}),
      }
    : undefined;
  const rawSteps = Array.isArray(value.steps) ? value.steps : Array.isArray(value.transcript) ? value.transcript : [];
  const model = isRecord(value.model)
    && typeof value.model.id === "string"
    && typeof value.model.model === "string"
    && typeof value.model.name === "string"
    ? value.model as unknown as ModelRunInfo
    : undefined;
  const rawUsage = isRecord(value.usage) ? value.usage : undefined;
  const rawResultValidation = isRecord(value.resultValidation) ? value.resultValidation : undefined;
  const resultValidation = rawResultValidation
    && ["failed", "passed", "skipped"].includes(String(rawResultValidation.status))
    && Array.isArray(rawResultValidation.errors)
    ? {
        errors: rawResultValidation.errors.filter((item): item is string => typeof item === "string"),
        ...(isRecord(rawResultValidation.schema) ? { schema: structuredClone(rawResultValidation.schema) } : {}),
        status: rawResultValidation.status as SubagentResultValidation["status"],
        validatedAt: typeof rawResultValidation.validatedAt === "string" ? rawResultValidation.validatedAt : new Date().toISOString(),
      }
    : undefined;
  const usage = rawUsage
    && typeof rawUsage.inputTokens === "number"
    && typeof rawUsage.outputTokens === "number"
    && typeof rawUsage.totalTokens === "number"
    ? {
        inputTokens: rawUsage.inputTokens,
        outputTokens: rawUsage.outputTokens,
        totalTokens: rawUsage.totalTokens,
      }
    : undefined;
  return {
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    ...(error ? { error } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(handoff ? { handoff } : {}),
    id: typeof value.id === "string" ? value.id : randomUUID(),
    input,
    maxTurns: typeof value.maxTurns === "number" && value.maxTurns > 0 ? value.maxTurns : DEFAULT_SUBAGENT_MAX_TURNS,
    ...(model ? { model } : {}),
    parentTurnId: typeof value.parentTurnId === "string" ? value.parentTurnId : "migrated",
    ...(typeof value.rawStructuredResult === "string" ? { rawStructuredResult: value.rawStructuredResult } : {}),
    ...(resultValidation ? { resultValidation } : {}),
    ...(hasOwn(value, "structuredResult") ? { structuredResult: structuredClone(value.structuredResult) } : {}),
    sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
    ...(specialistId ? { specialistId } : {}),
    status,
    steps: rawSteps as Subagent["steps"],
    timeoutSeconds: typeof value.timeoutSeconds === "number" && value.timeoutSeconds > 0 ? value.timeoutSeconds : DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
    turnCount: typeof value.turnCount === "number" && value.turnCount >= 0 ? value.turnCount : 0,
    ...(usage ? { usage } : {}),
  };
}

export function normalizeSubagentInputPaths(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("Subagent input paths must be an array");
  const paths = [...new Set(value.map((item) => {
    if (typeof item !== "string") throw new Error("Subagent input paths must contain strings");
    const path = item.trim().replace(/^\.\/+/, "");
    if (!path || path.includes("\0") || path.includes("\n") || path.length > 2_000) {
      throw new Error("Subagent input paths must be non-empty workspace-relative paths");
    }
    return path;
  }))];
  if (paths.length > 50) throw new Error("Subagent handoff supports at most 50 input paths");
  return paths.length ? paths : undefined;
}

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

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveWorkspaceFile } from "@science-agent/agent-runtime";
import type { Subagent, SubagentBrief, SubagentInput, WorkspaceFile } from "@science-agent/schema";

import { validateSubagentOutputValue } from "../subagent-brief.js";
import { SessionStore } from "../store.js";
import { listWorkspaceFiles } from "../artifacts/index.js";

/** Session-workspace prefix holding each subagent's private handoff scratch space. */
export const SUBAGENT_PRIVATE_WORKSPACE_PREFIX = "subagents/";

/** Files below the prefix are subagent-internal bookkeeping, not user workspace content. */
export function isSubagentPrivateWorkspacePath(path: string): boolean {
  return path.startsWith(SUBAGENT_PRIVATE_WORKSPACE_PREFIX);
}

const MAX_SUBAGENT_HANDOFF_FILES = 100;

const MAX_SUBAGENT_HANDOFF_FILE_BYTES = 10_000_000;

const MAX_SUBAGENT_HANDOFF_TOTAL_BYTES = 25_000_000;

const SUBAGENT_RAW_STRUCTURED_RESULT_LIMIT = 20_000;

export function subagentInputReferenceText(input: SubagentInput | undefined): string {
  const brief = input?.brief;
  return [
    input?.description,
    input?.prompt,
    brief?.goal,
    ...(brief?.constraints ?? []),
    ...(brief?.outputRequirements ?? []),
    ...(brief?.collaborationRules ?? []),
  ].filter((item): item is string => typeof item === "string").join("\n");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionsWorkspacePath(text: string, path: string): boolean {
  const boundary = "[^A-Za-z0-9._/-]";
  return new RegExp(`(^|${boundary})(?:\\./)?${escapeRegExp(path)}($|${boundary})`).test(text);
}

export function selectSubagentHandoffInputs(parentInputFiles: WorkspaceFile[], input: SubagentInput | undefined): {
  files: WorkspaceFile[];
  skippedInputPaths: NonNullable<NonNullable<Subagent["handoff"]>["skippedInputPaths"]>;
} {
  const available = new Map(parentInputFiles.map((file) => [file.path, file]));
  const explicitPaths = [...new Set((input?.inputPaths ?? []).map((path) => path.trim().replace(/^\.\/+/, "")).filter(Boolean))];
  const skippedInputPaths: NonNullable<NonNullable<Subagent["handoff"]>["skippedInputPaths"]> = [];
  if (explicitPaths.length) {
    const files = explicitPaths.flatMap((path) => {
      const file = available.get(path);
      if (!file) {
        skippedInputPaths.push({ path, reason: "handoff requested input not found" });
        return [];
      }
      return [file];
    });
    return { files, skippedInputPaths };
  }
  const referenceText = subagentInputReferenceText(input);
  const referencedFiles = parentInputFiles.filter((file) => mentionsWorkspacePath(referenceText, file.path));
  return {
    files: referencedFiles,
    skippedInputPaths,
  };
}

export async function prepareSubagentHandoff(store: SessionStore, sessionId: string, subagentId: string, input?: SubagentInput): Promise<NonNullable<Subagent["handoff"]>> {
  const privateWorkspacePath = `${SUBAGENT_PRIVATE_WORKSPACE_PREFIX}${subagentId}`;
  const manifestPath = `${privateWorkspacePath}/handoff.json`;
  const workspaceRoot = store.workspacePath(sessionId);
  const availableParentInputFiles = (await listWorkspaceFiles(store, sessionId))
    .filter((file) => !isSubagentPrivateWorkspacePath(file.path) && !file.path.startsWith("tracks/"));
  const selected = selectSubagentHandoffInputs(availableParentInputFiles, input);
  const parentInputFiles = selected.files;
  await mkdir(resolveWorkspaceFile(workspaceRoot, privateWorkspacePath), { recursive: true });
  const inputPaths: string[] = [];
  const skippedInputPaths: NonNullable<NonNullable<Subagent["handoff"]>["skippedInputPaths"]> = [...selected.skippedInputPaths];
  let copiedBytes = 0;
  let copiedFiles = 0;
  for (const file of parentInputFiles) {
    if (copiedFiles >= MAX_SUBAGENT_HANDOFF_FILES) {
      skippedInputPaths.push({ path: file.path, reason: "handoff file count limit exceeded", size: file.size });
      continue;
    }
    if (file.size > MAX_SUBAGENT_HANDOFF_FILE_BYTES) {
      skippedInputPaths.push({ path: file.path, reason: "handoff single file size limit exceeded", size: file.size });
      continue;
    }
    if (copiedBytes + file.size > MAX_SUBAGENT_HANDOFF_TOTAL_BYTES) {
      skippedInputPaths.push({ path: file.path, reason: "handoff total size limit exceeded", size: file.size });
      continue;
    }
    const copiedPath = `inputs/${file.path}`;
    const source = resolveWorkspaceFile(workspaceRoot, file.path);
    const snapshotDestination = resolveWorkspaceFile(workspaceRoot, `${privateWorkspacePath}/${copiedPath}`);
    const originalPathDestination = resolveWorkspaceFile(workspaceRoot, `${privateWorkspacePath}/${file.path}`);
    try {
      await mkdir(dirname(snapshotDestination), { recursive: true });
      await copyFile(source, snapshotDestination);
      if (originalPathDestination !== snapshotDestination) {
        await mkdir(dirname(originalPathDestination), { recursive: true });
        await copyFile(source, originalPathDestination);
      }
      inputPaths.push(copiedPath);
      copiedBytes += file.size;
      copiedFiles += 1;
    } catch (error) {
      skippedInputPaths.push({
        path: file.path,
        reason: error instanceof Error ? `handoff copy failed: ${error.message}` : "handoff copy failed",
        size: file.size,
      });
    }
  }
  await writeFile(resolveWorkspaceFile(workspaceRoot, manifestPath), `${JSON.stringify({
    createdAt: new Date().toISOString(),
    inputPaths,
    parentInputPaths: parentInputFiles.map((file) => file.path),
    privateWorkspacePath,
    ...(skippedInputPaths.length ? { skippedInputPaths } : {}),
    subagentId,
  }, null, 2)}\n`, "utf8");
  return {
    inputPaths,
    manifestPath,
    privateWorkspacePath,
    ...(skippedInputPaths.length ? { skippedInputPaths } : {}),
  };
}

export function numberedLines(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

export function formatSubagentExecutionPrompt(input: SubagentInput, handoff: NonNullable<Subagent["handoff"]>): string {
  const brief = input.brief;
  return [
    ...(brief ? [
      `Brief version: ${brief.version ?? 1}`,
      `Task: ${input.description}`,
      `Goal:\n${brief.goal}`,
      `Constraints:\n${numberedLines(brief.constraints)}`,
      `Output requirements:\n${numberedLines(brief.outputRequirements)}`,
      `Collaboration rules:\n${numberedLines(brief.collaborationRules)}`,
    ] : []),
    input.prompt,
    `Private workspace root: ${handoff.privateWorkspacePath}`,
    "Code execution starts in the writable private root inside /workspace. The parent Session workspace is visible read-only at /workspace; write outputs with relative paths so they stay in the private root.",
    "Handoff manifest visible inside your workspace: handoff.json",
    handoff.inputPaths.length
      ? `Input snapshots visible inside your workspace:\n${handoff.inputPaths.join("\n")}`
      : "No parent workspace input files were selected for this subagent.",
    handoff.skippedInputPaths?.length
      ? "Some parent workspace files were not copied into this private workspace; see handoff.json for the skipped input list."
      : "",
    brief?.outputJsonSchema ? [
      "Final output requirement:",
      "End your response with a single JSON object that satisfies this JSON Schema.",
      JSON.stringify(brief.outputJsonSchema),
    ].join("\n") : "",
  ].filter(Boolean).join("\n\n");
}

export function parseFinalJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Subagent produced no final text to validate");
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Subagent final text must be a single JSON object");
  }
  return parsed;
}

export function validateSubagentStructuredResult(brief: SubagentBrief | undefined, assistantOutput: string): Partial<Pick<Subagent, "rawStructuredResult" | "resultValidation" | "structuredResult">> {
  if (!brief?.outputJsonSchema) return {};
  let structuredResult: unknown;
  let errors: string[] = [];
  let passed = false;
  try {
    structuredResult = parseFinalJsonObject(assistantOutput);
    errors = validateSubagentOutputValue(structuredResult, brief.outputJsonSchema);
    passed = errors.length === 0;
  } catch (error) {
    errors = [error instanceof Error ? error.message : "Subagent structured result parsing failed"];
  }
  return {
    ...(passed ? { structuredResult } : { rawStructuredResult: assistantOutput.trim().slice(0, SUBAGENT_RAW_STRUCTURED_RESULT_LIMIT) }),
    resultValidation: {
      errors,
      schema: brief.outputJsonSchema,
      status: errors.length ? "failed" : "passed",
      validatedAt: new Date().toISOString(),
    },
  };
}

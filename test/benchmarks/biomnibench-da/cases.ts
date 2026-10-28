// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
export const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
export const cases: Array<{ id: string; title: string; files: Array<{ path: string; bytes: number; oid: string; lfs_pointer_bytes?: number }> }> = manifest.tasks;

export const researchTeamReference = {
  id: "science-research-team",
  kind: "skill",
  label: "science-research-team",
} as const;

export const researchTeamParameters = [
  '<skill_invocation_parameters skill_id="science-research-team">',
  "knowledge_domain: disabled",
  "web_search: disabled",
  "</skill_invocation_parameters>",
].join("\n");

export function selectedCases(value = process.env.E2E_BIOMNI_CASE_IDS) {
  if (value === undefined) return [...cases];
  const ids = value.split(",").map(s => s.trim());
  if (ids.some(id => !cases.some(c => c.id === id)) || new Set(ids).size !== ids.length) {
    throw new Error("E2E_BIOMNI_CASE_IDS must contain unique public BiomniBench-DA IDs");
  }
  return cases.filter(c => ids.includes(c.id));
}

export function analysisPrompt(_id: string, instruction: string, input = "data/") {
  return [instruction, researchTeamParameters,
    `<platform_delivery>\nThe original task above defines the scientific scope and required outputs. The provided data directory is in this session workspace: ${input}. Preserve its nested paths. Resolve paths using the actual workspace; /app/data in the original instruction maps to workspace data/ and /app outputs map to workspace-relative outputs. Save and declare the required trace.md and answer.txt artifacts with those exact logical names.\n</platform_delivery>`,
  ].join("\n\n");
}

/** Read the selected task's verified source verbatim; never substitute a title or another task. */
export async function loadAnalysisPrompt(dataRoot: string, id: string) {
  if (!cases.some(item => item.id === id)) throw new Error(`Unknown public BiomniBench-DA task: ${id}`);
  const instruction = await readFile(join(dataRoot, id, "instruction.md"), "utf8");
  if (!instruction.trim()) throw new Error(`Empty BiomniBench-DA instruction: ${id}`);
  return analysisPrompt(id, instruction);
}

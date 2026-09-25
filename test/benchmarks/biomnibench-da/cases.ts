// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
export const cases = [
  { id: "da-13-3", title: "Protein–body composition associations", file: "41591_2025_4023_MOESM2_ESM(Supplementary Table 4).csv",
    dataOid: "19ea87551b23b83220c4f2fa483489c6ae9399a9", instructionOid: "387cea6de4a2f5ce61176277be4e75119c9b6ea9", rubricOid: "b54c2480ba3da6f95a64fa2a49bd8aa9bdd76082" },
  { id: "da-14-1", title: "Sepsis endotype score clustering", file: "subspace_score_table.csv",
    dataOid: "407614681347795b6a200746c275239a617f1764", instructionOid: "29747ddf4d164521bcf0510da82b5b169ac1e964", rubricOid: "003bdfb90af0d3b13df50aeb137c51c4bf7d3ea3" },
] as const;

export function selectedCases(value = process.env.E2E_BIOMNI_CASE_IDS) {
  if (value === undefined) return [...cases];
  const ids = value.split(",").map(s => s.trim());
  if (ids.some(id => !cases.some(c => c.id === id)) || new Set(ids).size !== ids.length) {
    throw new Error("E2E_BIOMNI_CASE_IDS must contain unique da-13-3 and/or da-14-1 IDs");
  }
  return cases.filter(c => ids.includes(c.id));
}

export function analysisPrompt(_id: string, instruction: string, file: string) {
  return `${instruction}\n\n<platform_delivery>\nThe original task above defines the scientific scope and required outputs. The provided data file is in this session workspace: ${file}. Resolve paths using the actual workspace; /app/data in the original instruction maps to the workspace input and /app outputs map to workspace-relative outputs. Save and declare the required trace.md and answer.txt artifacts with those exact logical names.\n</platform_delivery>`;
}

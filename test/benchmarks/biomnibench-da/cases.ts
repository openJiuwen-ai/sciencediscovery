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

export function outputContract(id: string) {
  return id === "da-13-3"
    ? 'analysis.json: {"phenotypes":{"Percent_Fat":{"significant_count":N,"top":[{"protein_id":"...","estimate":0.1,"adjusted_p":0.01}]},"Breast_Volume":{"significant_count":N,"top":[...]}}}. Export up to 10 strongest significant associations per phenotype, preserving identifiers and numeric precision.'
    : 'analysis.json: {"columns":["score_name",...],"method":"spearman" or "pearson","missing":"pairwise" or "complete","correlation":[[1,...],...],"distance":"1-correlation","linkage_method":"average" or "complete" or "single" or "ward","linkage":[[left,right,distance,count],...]}. Use selected score columns only (not clinical covariates), export the unreordered correlation matrix and scipy-format linkage indexed by columns; explain feature selection and methods in trace.md. Do not round exported numeric values.';
}

export function analysisPrompt(id: string, instruction: string, file: string) {
  return `${instruction}\n\n<platform_delivery>\nThe original task above defines the scientific scope. The provided data file is in this session workspace: ${file}. Resolve paths using the actual workspace; /app/data in the original instruction maps to the workspace input and /app outputs map to workspace-relative outputs. Do not replace data with synthetic examples or search for the source paper/its answers. Prefer completing this small task yourself; do not create subagents. Do not load the full CSV into LLM context. Execute reproducible Python analysis using the available execution tools. Save and declare these artifacts with exact logical names: trace.md, answer.txt, analysis.py, analysis.json. trace.md must include actual executed code and intermediate results. analysis.py is the reproducible analysis script, not a prose description.\nAdditional platform evaluation export (not part of the original benchmark): ${outputContract(id)}\nMention the delivered artifacts in your final answer.\n</platform_delivery>`;
}

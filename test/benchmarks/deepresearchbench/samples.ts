// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
// Verbatim prompts from DeepResearchBench data/prompt_data/query.jsonl.
// Source: Ayanami0730/deep_research_bench (Apache-2.0).
// Difficulty is our original local workload stratification, NOT an upstream label.
export const drbSamples = [
  { id: 59, difficulty: "easy", topic: "Science & Technology",
    question: "In ecology, how do birds achieve precise location and direction navigation during migration? What cues and disturbances influence this process?" },
  { id: 64, difficulty: "medium", topic: "Science & Technology",
    question: "Regarding the attitude control problem for UAVs, most open-source flight controllers currently implement cascaded PID control algorithms. However, a single set of PID controller parameters typically performs well only under specific flight conditions. In practical applications, UAVs operate across diverse flight states. What methods can be employed to enhance the actual control performance of PID algorithms, and how should PID parameters be optimally selected?" },
  { id: 58, difficulty: "medium-hard", topic: "Science & Technology",
    question: "Exploring Horizontal Gene Transfer (HGT) in Plants and animals (ie Non-Microbial Systems)\nYou could examine instances of horizontal gene transfer in eukaryotes—particularly plants and animals—and evaluate the evolutionary significance of these transfers. Its very rare and therefore must have a really interesting reason behind this adaptation!\nEspecially as this horizontal gene transfer has been well -studied in microbial systems, but not in plants and animals (this is a relatively new discovery).  Understanding  how commonly genes move between eukaryotic species and whether these transfers confer benefits would be really interesting to find out" },
  { id: 62, difficulty: "hard", topic: "Science & Technology",
    question: "What are the most effective approaches to scaling ion trap quantum computing from small-scale demonstration projects to large-scale systems capable of solving real-world problems? This research should investigate the various proposed scaling strategies, assess their feasibility, and evaluate which approaches are most likely to succeed based on current technological advancements and practical implementation challenges." },
  { id: 75, difficulty: "very-hard", topic: "Health",
    question: "Could the rapeutic interventions aimed at modulating plasma metal ion concentrations represent effective preventive or therapeutic strategies against cardiovascular diseases? What types of interventions—such as supplementation—have been proposed, and is there clinical evidence supporting their feasibility and efficacy?" },
] as const;

export function selectedDrbSamples(value = process.env.E2E_DRB_CASE_IDS) {
  if (value === undefined) return [...drbSamples];
  const ids = value.split(",").map(v => Number(v.trim()));
  if (!value.trim() || ids.some(id => !drbSamples.some(c => c.id === id)) || new Set(ids).size !== ids.length)
    throw new Error("E2E_DRB_CASE_IDS must contain unique sampled IDs: 59,64,58,62,75");
  return ids.map(id => drbSamples.find(c => c.id === id)!);
}

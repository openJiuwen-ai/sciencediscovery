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

import type { Label } from "./types.js";

const label = (en: string, zh: string): Label => ({ en, zh });

export const DOMAIN_LABELS: Record<string, Label> = {
  astronomy: label("Astronomy", "天文学"),
  biology: label("Biology", "生物学"),
  chemistry_and_materials: label("Chemistry and materials", "化学与材料"),
  earth_sciences: label("Earth sciences", "地球科学"),
  economics: label("Economics", "经济学"),
  electromagnetics: label("Electromagnetics", "电磁学"),
  energy: label("Energy", "能源"),
  fluid_dynamics: label("Fluid dynamics", "流体力学"),
  machine_learning: label("Machine learning", "机器学习"),
  mathematics: label("Mathematics", "数学"),
  medical_and_pharmacy: label("Medicine and pharmacy", "医学与药学"),
  quantum: label("Quantum", "量子"),
  research_tools: label("Research tools", "科研工具"),
};

export const SUBDOMAIN_LABELS: Record<string, Label> = {
  astronomical_analysis: label("Astronomical analysis", "天文分析"),
  bioinformatics: label("Bioinformatics", "生物信息"),
  cancer_genomics: label("Cancer genomics", "癌症基因组"),
  cheminformatics: label("Cheminformatics", "化学信息学"),
  clinical: label("Clinical medicine", "临床医学"),
  data_analysis_and_processing: label("Data analysis and processing", "数据分析与处理"),
  database_and_knowledge: label("Databases and knowledge", "数据库与知识"),
  drug_development: label("Drug development", "药物研发"),
  economic_analysis: label("Economic analysis", "经济分析"),
  electromagnetics: label("Electromagnetic simulation", "电磁仿真"),
  energy: label("Energy", "能源"),
  fluid_dynamics: label("Fluid simulation", "流体仿真"),
  general_tools: label("General tools", "通用工具"),
  genomic_medicine: label("Genomic medicine", "基因组医学"),
  genomics_and_genetics: label("Genomics and genetics", "基因组与遗传"),
  geophysics: label("Geophysics", "地球物理"),
  geospatial: label("Geospatial", "地理空间"),
  hpc_orchestration: label("HPC orchestration", "HPC 编排"),
  machine_learning: label("Machine learning", "机器学习"),
  medical_imaging_and__signal_processing: label("Medical imaging and signal processing", "医学影像与信号处理"),
  meteorology: label("Meteorology", "气象"),
  molecular_dynamics: label("Molecular dynamics", "分子动力学"),
  multi_omics_integration: label("Multi-omics integration", "多组学整合"),
  numerical_computing: label("Numerical computing", "数值计算"),
  protein_and_structure: label("Proteins and structure", "蛋白质与结构"),
  quantum: label("Quantum computing", "量子计算"),
  quantum_chemistry: label("Quantum chemistry", "量子化学"),
  real_world_workstations: label("Laboratory workstations", "实验室工作站"),
  scientific_writing: label("Scientific writing", "科学写作"),
  transcriptomics_and_sc_omics: label("Transcriptomics and single-cell", "转录组与单细胞"),
  visualization_tools: label("Visualization", "可视化"),
};

export const CONNECTOR_FUNCTION_LABELS: Record<string, Label> = {
  "compound-drug": label("Compounds and drugs", "化合物与药物查询"),
  "dataset-knowledge": label("Datasets and knowledge", "数据集与知识库检索"),
  "genome-variant-pathway": label("Genome, variants and pathways", "基因组、变异与通路查询"),
  literature: label("Literature search", "文献检索"),
  "sequence-structure": label("Sequences and structures", "序列与结构查询"),
};

export const SESSION_TASK_LABELS: Record<string, Label> = {
  "capability-evolution": label("Capability building and evolution", "能力构建与演进"),
  "data-analysis": label("Data analysis", "数据分析"),
  "literature-review": label("Literature review", "文献调研"),
  "simulation-modeling": label("Simulation and modeling", "计算模拟"),
  uncategorized: label("Uncategorized", "未分类"),
};

export const SKILL_TYPE_LABELS: Record<string, Label> = {
  "ai-model": label("AI4S model", "AI4S 模型"),
  api: label("Data API", "数据 API"),
  "hpc-software": label("Domain software", "领域软件"),
  "know-how": label("Know-how", "经验方法"),
  "laboratory-automation": label("Laboratory automation", "实验室自动化"),
  "python-package": label("Domain library", "领域工具库"),
};

export const HARDWARE_LABELS: Record<string, Label> = {
  cpu: label("CPU", "CPU"),
  "cpu-gpu": label("CPU + GPU", "CPU + GPU"),
  gpu: label("GPU", "GPU"),
  "gpu-cpu": label("GPU + CPU", "GPU + CPU"),
  npu: label("NPU", "NPU"),
};

export const SOURCE_LABELS: Record<string, Label> = {
  biomni: label("BiomniBench", "BiomniBench"),
  builtin: label("Built in", "内置"),
  evolve: label("Evolve", "Evolve"),
  manual: label("Manual example", "手工示例"),
  mindscience: label("MindScienceSkills", "MindScienceSkills"),
  srbench: label("SRBench", "SRBench"),
};

export function labelFor(map: Record<string, Label>, id: string | null | undefined): Label | null {
  if (!id) return null;
  return map[id] ?? null;
}

// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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

/**
 * Extraction schema vocabularies. Domain policy lives OUTSIDE the code
 * (mechanism/policy separation, same as DeepAnalyze's plugin schema files):
 * the biomedical defaults below mirror the Ebola demo KB; other domains
 * supply their own schema JSON.
 */

export interface ExtractionSchema {
  readonly entityTypes: readonly string[];
  readonly edgeTypes: readonly string[];
}

/** Biomedical/virology vocabulary for the Ebola demo KB (and a sane default
 *  for life-science KBs generally). */
export const BIOMEDICAL_SCHEMA: ExtractionSchema = {
  entityTypes: [
    "virus",
    "protein",
    "antibody",
    "gene",
    "epitope",
    "cell-line",
    "assay",
    "drug",
    "method",
    "dataset",
    "host-factor",
    "disease",
    "other",
  ],
  edgeTypes: [
    "binds",
    "neutralizes",
    "inhibits",
    "enhances",
    "enters-via",
    "encodes",
    "expresses",
    "interacts-with",
    "contradicts",
    "contrasts_with",
    "uses",
    "evaluates_on",
    "part_of",
    "related_to",
  ],
};

/** Generic fallback (the DeepAnalyze M0 default vocabulary). */
export const DEFAULT_SCHEMA: ExtractionSchema = {
  entityTypes: [
    "concept",
    "method",
    "framework",
    "architecture",
    "metric",
    "dataset",
    "benchmark",
    "task",
    "theory",
    "material",
    "tool",
    "other",
  ],
  edgeTypes: ["related_to", "part_of", "improves", "evaluates_on", "uses", "contrasts_with"],
};

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
 * Deterministic entity-name normalization.
 *
 * LOCKSTEP: this must stay semantically identical to
 * services/api/src/knowledge-engine/store.ts `normalizeEntityName` (storage
 * dedup key) and graph/explore.ts `normalizeName` (consumption lookup) — the
 * resolver's L0/L1 gates only hit when all three agree.
 *
 * KNOWN DIVERGENCE from DeepAnalyze: DA additionally folded hyphens and
 * underscores (`[\s\-_]+` → space), so DA's L0 merges "SARS-CoV-2" ↔
 * "SARS CoV 2" and "large_language_model" ↔ "large language model". SD's
 * normalization is the pre-existing (kb, name, type) storage dedup key and
 * cannot change retroactively, so L0/L1 recall here is correspondingly
 * narrower — those pairs fall through to L3/L4 or stay split. The
 * DA-calibrated thresholds and eval baselines remain valid (they were
 * measured against the DA-normalized names; this port's sample-dataset
 * baseline is pinned in eval-dataset.test.ts).
 */
export function normalizeEntityName(name: string): string {
  return name.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

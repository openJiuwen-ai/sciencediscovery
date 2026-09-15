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
 * Canonical-survivor selection for entity merges, ported from the DeepAnalyze
 * scholarly/entity-merge module (the physical merge itself lives in the
 * services store — it needs SQL transactions).
 *
 * Priority: LLM-suggested name match > support_count > trust core > name
 * informativeness (more words; bare uppercase abbreviations deprioritized)
 * > earlier created_at. Deterministic given the same inputs.
 */

import { normalizeEntityName } from "./normalize.js";

/** Minimal entity shape accepted by chooseCanonical (row or mapped). */
export interface CanonicalCandidate {
  id: string;
  canonicalName: string;
  supportCount: number;
  trustLevel: string;
  createdAt: string;
}

const ABBREV_FORM_RE = /^[A-Z0-9][A-Z0-9-]{0,9}$/;

function nameInformativeness(name: string): number {
  const words = name.trim().split(/\s+/).length;
  const abbrevPenalty = ABBREV_FORM_RE.test(name.trim()) ? -0.5 : 0;
  return words + abbrevPenalty;
}

export function chooseCanonical(
  a: CanonicalCandidate,
  b: CanonicalCandidate,
  llmSuggestion?: string,
): CanonicalCandidate {
  if (llmSuggestion) {
    const sug = normalizeEntityName(llmSuggestion);
    if (sug === normalizeEntityName(a.canonicalName)) return a;
    if (sug === normalizeEntityName(b.canonicalName)) return b;
  }
  if (a.supportCount !== b.supportCount) return a.supportCount > b.supportCount ? a : b;
  const coreA = a.trustLevel === "core" ? 1 : 0;
  const coreB = b.trustLevel === "core" ? 1 : 0;
  if (coreA !== coreB) return coreA > coreB ? a : b;
  const infoA = nameInformativeness(a.canonicalName);
  const infoB = nameInformativeness(b.canonicalName);
  if (infoA !== infoB) return infoA > infoB ? a : b;
  return a.createdAt <= b.createdAt ? a : b;
}

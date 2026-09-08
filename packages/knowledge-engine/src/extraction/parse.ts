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
 * Extraction response parsing and deterministic filters — ported from the
 * DeepAnalyze extraction-pipeline (parseExtractionResponse + the
 * bibliographic/generic filters). JSON salvage goes through the shared
 * llm-text utilities (thinking stripped by the caller).
 */

import { salvageJson } from "../text/llm-text.js";
import type { ExtractionSchema } from "./schema.js";

export interface RawEntity {
  readonly name: string;
  readonly type: string;
  readonly definition?: string;
  readonly aliases?: string[];
}

export interface RawRelation {
  readonly source: string;
  readonly target: string;
  readonly type: string;
  readonly evidence_quote: string;
}

/** Institution / bibliographic-metadata patterns — never subject knowledge. */
const BIBLIOGRAPHIC_RE =
  /university|institut|laborator|college|academy|school of|dept\.|department|inc\.|ltd\.|corp\.|llc|gmbh|ieee|acm|springer|elsevier|arxiv|proceedings|conference|journal|研究[院所]|大学|学院|实验室|公司|集团/i;

/** Exact-match generic words that carry no subject knowledge. */
const GENERIC_STOPWORDS = new Set([
  "result",
  "results",
  "performance",
  "experiment",
  "experiments",
  "method",
  "methods",
  "approach",
  "approaches",
  "model",
  "models",
  "work",
  "paper",
  "study",
  "studies",
  "analysis",
  "conclusion",
  "introduction",
  "related work",
  "discussion",
  "evaluation",
  "baseline",
  "baselines",
  "future work",
  "overview",
  "summary",
  "background",
]);

export function isBibliographicOrGeneric(name: string): boolean {
  const value = name.trim();
  if (value.length < 2) return true;
  if (/^[\d\W]+$/.test(value)) return true; // pure numbers / symbols
  if (/^[a-zA-Z]$/.test(value)) return true; // single-letter variables
  if (BIBLIOGRAPHIC_RE.test(value)) return true;
  if (GENERIC_STOPWORDS.has(value.toLowerCase())) return true;
  return false;
}

/**
 * Parse the model's extraction response. Unparseable input yields empty
 * lists (never throws) — the caller treats zero entities as a retryable
 * model failure.
 */
export function parseExtractionResponse(
  response: string,
  schema: ExtractionSchema,
): { entities: RawEntity[]; relations: RawRelation[] } {
  const salvaged = salvageJson(response);
  if (salvaged === null) {
    return { entities: [], relations: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(salvaged);
  } catch {
    try {
      // Trailing-comma repair, then give up.
      parsed = JSON.parse(salvaged.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return { entities: [], relations: [] };
    }
  }

  const obj = parsed as Record<string, unknown>;
  const entityTypes = new Set(schema.entityTypes);
  const edgeTypes = new Set(schema.edgeTypes);

  const entities: RawEntity[] = (Array.isArray(obj["entities"]) ? (obj["entities"] as unknown[]) : [])
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      name: String(entry["name"] ?? "").trim(),
      type: entityTypes.has(String(entry["type"])) ? String(entry["type"]) : "other",
      definition: typeof entry["definition"] === "string" ? entry["definition"] : undefined,
      aliases: Array.isArray(entry["aliases"])
        ? (entry["aliases"] as unknown[]).filter((alias): alias is string => typeof alias === "string")
        : undefined,
    }))
    .filter((entity) => entity.name.length > 0 && !isBibliographicOrGeneric(entity.name));

  const relations: RawRelation[] = (Array.isArray(obj["relations"]) ? (obj["relations"] as unknown[]) : [])
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      source: String(entry["source"] ?? "").trim(),
      target: String(entry["target"] ?? "").trim(),
      type: edgeTypes.has(String(entry["type"])) ? String(entry["type"]) : String(entry["type"] ?? "related_to"),
      evidence_quote: String(entry["evidence_quote"] ?? "").trim(),
    }))
    .filter((relation) => relation.source && relation.target && relation.evidence_quote.length >= 10);

  return { entities, relations };
}

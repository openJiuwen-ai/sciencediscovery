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
 *
 * @deprecated Lenient legacy parser (unknown types coerced, invalid rows
 * silently dropped). New callers use {@link validateExtractionProposal},
 * which keeps every rejection as inspectable evidence; this remains for
 * backwards compatibility.
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

// ---------------------------------------------------------------------------
// C3① proposal-validation gate (OpenDDE typed-proposal contract): LLM output
// is always a PROPOSAL — the executor validates deterministically, rejects
// carry a reason and a truncated excerpt so failures stay inspectable
// instead of silently vanishing, and the caller can feed the reasons back
// for a bounded corrective retry.
// ---------------------------------------------------------------------------

/** Longer quotes can never verify verbatim against a capped haystack. */
export const MAX_EVIDENCE_QUOTE_CHARS = 1_000;

const MIN_EVIDENCE_QUOTE_CHARS = 10;
const REJECT_EXCERPT_CHARS = 200;

export interface ProposalReject {
  readonly section: "response" | "entities" | "relations";
  readonly index: number;
  readonly reason: string;
  readonly excerpt: string;
}

export interface ValidatedProposal {
  readonly entities: RawEntity[];
  readonly relations: RawRelation[];
  readonly rejects: ProposalReject[];
  /** Non-null when the response itself was not a parseable proposal. */
  readonly parseError: string | null;
}

function rejectExcerpt(value: unknown): string {
  const text = typeof value === "string"
    ? value
    : (() => {
        try {
          return JSON.stringify(value) ?? "";
        } catch {
          return String(value);
        }
      })();
  return text.slice(0, REJECT_EXCERPT_CHARS);
}

/**
 * Strict structural validation of an extraction proposal.
 *
 * Differences from the legacy parser: schema-enum violations are REJECTIONS
 * (no coercion to "other", no raw unknown edge types), quote length has an
 * upper bound, and every dropped row is reported with a reason + excerpt.
 * The bibliographic/generic screen stays a silent deterministic policy drop
 * (it is a quality filter, not a model contract violation).
 */
export function validateExtractionProposal(
  response: string,
  schema: ExtractionSchema,
): ValidatedProposal {
  const rejects: ProposalReject[] = [];
  const salvaged = salvageJson(response);
  if (salvaged === null) {
    return {
      entities: [],
      relations: [],
      rejects: [{ section: "response", index: 0, reason: "response is not parseable JSON", excerpt: rejectExcerpt(response) }],
      parseError: "unparseable-json",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(salvaged);
  } catch {
    try {
      parsed = JSON.parse(salvaged.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return {
        entities: [],
        relations: [],
        rejects: [{ section: "response", index: 0, reason: "response is not parseable JSON", excerpt: rejectExcerpt(response) }],
        parseError: "unparseable-json",
      };
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      entities: [],
      relations: [],
      rejects: [{ section: "response", index: 0, reason: "top-level value must be a JSON object", excerpt: rejectExcerpt(parsed) }],
      parseError: "invalid-shape",
    };
  }
  const obj = parsed as Record<string, unknown>;
  const entityTypes = new Set(schema.entityTypes);
  const edgeTypes = new Set(schema.edgeTypes);

  const entities: RawEntity[] = [];
  const entityRows = Array.isArray(obj["entities"]) ? (obj["entities"] as unknown[]) : [];
  if (!Array.isArray(obj["entities"])) {
    rejects.push({ section: "response", index: 0, reason: "entities must be an array", excerpt: rejectExcerpt(obj["entities"]) });
  }
  entityRows.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      rejects.push({ section: "entities", index, reason: "entity must be an object", excerpt: rejectExcerpt(entry) });
      return;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record["name"] === "string" ? record["name"].trim() : "";
    if (!name) {
      rejects.push({ section: "entities", index, reason: "entity.name is required", excerpt: rejectExcerpt(entry) });
      return;
    }
    if (typeof record["type"] !== "string" || !entityTypes.has(record["type"])) {
      rejects.push({
        section: "entities",
        index,
        reason: `entity.type must be one of: ${schema.entityTypes.join(", ")}`,
        excerpt: rejectExcerpt(entry),
      });
      return;
    }
    if (record["definition"] !== undefined && typeof record["definition"] !== "string") {
      rejects.push({ section: "entities", index, reason: "entity.definition must be a string when present", excerpt: rejectExcerpt(entry) });
      return;
    }
    if (record["aliases"] !== undefined
      && (!Array.isArray(record["aliases"]) || record["aliases"].some((alias) => typeof alias !== "string"))) {
      rejects.push({ section: "entities", index, reason: "entity.aliases must be an array of strings when present", excerpt: rejectExcerpt(entry) });
      return;
    }
    if (isBibliographicOrGeneric(name)) return; // deterministic policy screen — not a model error
    entities.push({
      name,
      type: record["type"],
      definition: typeof record["definition"] === "string" ? record["definition"] : undefined,
      aliases: Array.isArray(record["aliases"]) ? (record["aliases"] as string[]) : undefined,
    });
  });

  const relations: RawRelation[] = [];
  const relationRows = Array.isArray(obj["relations"]) ? (obj["relations"] as unknown[]) : [];
  if (!Array.isArray(obj["relations"])) {
    rejects.push({ section: "response", index: 0, reason: "relations must be an array", excerpt: rejectExcerpt(obj["relations"]) });
  }
  relationRows.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      rejects.push({ section: "relations", index, reason: "relation must be an object", excerpt: rejectExcerpt(entry) });
      return;
    }
    const record = entry as Record<string, unknown>;
    const source = typeof record["source"] === "string" ? record["source"].trim() : "";
    const target = typeof record["target"] === "string" ? record["target"].trim() : "";
    const quote = typeof record["evidence_quote"] === "string" ? record["evidence_quote"].trim() : "";
    if (!source || !target) {
      rejects.push({ section: "relations", index, reason: "relation.source and relation.target are required", excerpt: rejectExcerpt(entry) });
      return;
    }
    if (typeof record["type"] !== "string" || !edgeTypes.has(record["type"])) {
      rejects.push({
        section: "relations",
        index,
        reason: `relation.type must be one of: ${schema.edgeTypes.join(", ")}`,
        excerpt: rejectExcerpt(entry),
      });
      return;
    }
    if (quote.length < MIN_EVIDENCE_QUOTE_CHARS) {
      rejects.push({
        section: "relations",
        index,
        reason: `relation.evidence_quote must be at least ${MIN_EVIDENCE_QUOTE_CHARS} characters`,
        excerpt: rejectExcerpt(entry),
      });
      return;
    }
    if (quote.length > MAX_EVIDENCE_QUOTE_CHARS) {
      rejects.push({
        section: "relations",
        index,
        reason: `relation.evidence_quote exceeds ${MAX_EVIDENCE_QUOTE_CHARS} characters`,
        excerpt: rejectExcerpt(entry),
      });
      return;
    }
    relations.push({ source, target, type: record["type"], evidence_quote: quote });
  });

  return { entities, relations, rejects, parseError: null };
}

/**
 * Correction feedback for the bounded retry loop: itemized rejection
 * reasons the model is asked to fix in one complete re-emission.
 */
export function buildExtractionCorrectionPrompt(
  validation: ValidatedProposal,
  schema: ExtractionSchema,
): string {
  const lines: string[] = [];
  if (validation.parseError) {
    lines.push(`Your previous response could not be parsed (${validation.parseError}).`);
  } else {
    lines.push("Your previous extraction response failed deterministic validation:");
  }
  for (const reject of validation.rejects.slice(0, 20)) {
    lines.push(`- ${reject.section}[${reject.index}]: ${reject.reason}`);
  }
  if (validation.rejects.length > 20) {
    lines.push(`- ...and ${validation.rejects.length - 20} more`);
  }
  lines.push("");
  lines.push("Fix every listed problem and re-emit the COMPLETE corrected JSON object with \"entities\" and \"relations\" arrays.");
  lines.push(`Entity types (exact): ${schema.entityTypes.join(" / ")}.`);
  lines.push(`Edge types (exact): ${schema.edgeTypes.join(" / ")}.`);
  lines.push(
    `Every relation needs source and target names that exactly match emitted entity names, a listed edge type, ` +
      `and a verbatim evidence_quote (${MIN_EVIDENCE_QUOTE_CHARS}-${MAX_EVIDENCE_QUOTE_CHARS} characters) copied from the document.`,
  );
  return lines.join("\n");
}

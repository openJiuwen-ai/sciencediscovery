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
 * GraphRAG-style community reports: one LLM-written structured digest per
 * detected community, keyed to the graph fingerprint the partition came
 * from. The report is a NAVIGATION AND ORIENTATION artifact — findings must
 * only restate the provided entities/relations, ratings are heuristic
 * importance signals (not ground truth), and the whole record is stale the
 * moment the graph fingerprint moves.
 */

/** Members listed in the prompt (highest support first; the rest are counts). */
export const REPORT_MAX_MEMBERS = 40;
/** Intra-community relations listed in the prompt (highest support first). */
export const REPORT_MAX_EDGES = 50;
export const REPORT_MAX_FINDINGS = 8;
export const REPORT_TITLE_MAX_CHARS = 120;
export const REPORT_SUMMARY_MAX_CHARS = 2_000;
export const REPORT_EXPLANATION_MAX_CHARS = 800;
export const REPORT_EVIDENCE_MAX_CHARS = 400;
export const REPORT_RATING_MIN = 0;
export const REPORT_RATING_MAX = 10;

export interface ReportMemberInput {
  readonly name: string;
  readonly type: string;
  readonly support: number;
  readonly definition?: string | null;
}

export interface ReportRelationInput {
  readonly source: string;
  readonly target: string;
  readonly type: string;
  readonly support: number;
  readonly evidence?: string | null;
}

export interface CommunityReportContext {
  readonly kbId: string;
  readonly fingerprint: string;
  readonly communityId: number;
  readonly communityName?: string | null;
  readonly memberCount: number;
  readonly members: readonly ReportMemberInput[];
  readonly relations: readonly ReportRelationInput[];
}

export interface ReportFinding {
  readonly summary: string;
  readonly explanation: string;
  /** Verbatim relation evidence the finding rests on (clamped, no paraphrase). */
  readonly evidence?: string;
}

export interface CommunityReportDraft {
  readonly title: string;
  readonly summary: string;
  readonly rating: number;
  readonly ratingExplanation: string;
  readonly findings: readonly ReportFinding[];
}

export const COMMUNITY_REPORT_SYSTEM_PROMPT =
  "You are a knowledge-graph community analyst. You write one structured report about a SINGLE community of " +
  "related entities, for a researcher who is deciding whether this cluster is worth drilling into. " +
  "Only output the JSON object the user asked for — no prose, no markdown fences, no preamble. " +
  "STRICT GROUNDING RULES: use ONLY the entities and relations provided in the user message. " +
  "Never invent entities, relations, numbers, or dates. Evidence quotes must be copied VERBATIM from the " +
  "provided relations. If context is thin, say so plainly instead of padding. " +
  "The rating is your heuristic importance signal (how central/rich this community looks), not ground truth. " +
  "Write the report in the dominant language of the entity names.";

/**
 * Build the user prompt for one community. Members and relations are already
 * ranked (support DESC) by the caller; here they are clamped to the prompt
 * budget and rendered deterministically.
 */
export function buildCommunityReportPrompt(context: CommunityReportContext): string {
  const members = context.members.slice(0, REPORT_MAX_MEMBERS);
  const relations = context.relations.slice(0, REPORT_MAX_EDGES);
  const lines: string[] = [];
  lines.push(`Knowledge base: ${context.kbId}`);
  lines.push(`Community #${context.communityId}${context.communityName ? ` (${context.communityName})` : ""}`);
  lines.push(`Total members: ${context.memberCount} (top ${members.length} listed by support)`);
  lines.push("");
  lines.push("Entities (name | type | support | definition):");
  for (const m of members) {
    const def = m.definition ? clampText(m.definition, 200) : "";
    lines.push(`- ${m.name} | ${m.type} | ${m.support}${def ? ` | ${def}` : ""}`);
  }
  lines.push("");
  lines.push("Relations within the community (source -> target | type | support | evidence):");
  if (relations.length === 0) {
    lines.push("- (none recorded)");
  } else {
    for (const r of relations) {
      const ev = r.evidence ? clampText(r.evidence, REPORT_EVIDENCE_MAX_CHARS) : "";
      lines.push(`- ${r.source} -> ${r.target} | ${r.type} | ${r.support}${ev ? ` | "${ev}"` : ""}`);
    }
  }
  lines.push("");
  lines.push("Produce ONE JSON object with exactly these keys:");
  lines.push('{"title": string (<=120 chars, descriptive),');
  lines.push(' "summary": string (<=2000 chars, what this community is about and how it hangs together),');
  lines.push(' "rating": integer 0-10 (heuristic importance of this community),');
  lines.push(' "rating_explanation": string (<=800 chars, why this rating),');
  lines.push(' "findings": array of at most 8 objects {"summary": string (<=200 chars), "explanation": string (<=800 chars), "evidence": string (optional, VERBATIM quote from the relations above)}}');
  return lines.join("\n");
}

function clampText(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Defensive normalization of the LLM's JSON: clamp lengths, coerce rating,
 * drop empty findings, cap the findings array. Returns null when the output
 * has no usable summary at all (caller retries via job attempts).
 */
export function normalizeCommunityReport(
  raw: unknown,
  context: CommunityReportContext,
): CommunityReportDraft | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const summary = str(obj["summary"]).trim();
  if (summary.length < 10) return null;

  const rawFindings = Array.isArray(obj["findings"]) ? obj["findings"] : [];
  const findings: ReportFinding[] = [];
  for (const item of rawFindings) {
    if (findings.length >= REPORT_MAX_FINDINGS) break;
    if (typeof item !== "object" || item === null) continue;
    const f = item as Record<string, unknown>;
    const fSummary = str(f["summary"]).trim();
    if (!fSummary) continue;
    const evidence = str(f["evidence"]).trim();
    findings.push({
      summary: clampText(fSummary, 200),
      explanation: clampText(str(f["explanation"]).trim(), REPORT_EXPLANATION_MAX_CHARS),
      ...(evidence ? { evidence: clampText(evidence, REPORT_EVIDENCE_MAX_CHARS) } : {}),
    });
  }

  const ratingRaw = num(obj["rating"]) ?? REPORT_RATING_MIN;
  const rating = Math.min(REPORT_RATING_MAX, Math.max(REPORT_RATING_MIN, Math.round(ratingRaw)));

  const title = str(obj["title"]).trim() || context.communityName || `Community #${context.communityId}`;

  return {
    title: clampText(title, REPORT_TITLE_MAX_CHARS),
    summary: clampText(summary, REPORT_SUMMARY_MAX_CHARS),
    rating,
    ratingExplanation: clampText(str(obj["rating_explanation"]).trim(), REPORT_EXPLANATION_MAX_CHARS),
    findings,
  };
}

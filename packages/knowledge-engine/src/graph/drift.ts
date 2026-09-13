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
 * V2-Z2 `drift_search` — DRIFT-style two-stage retrieval: a global pass over
 * the community reports (GraphRAG corpus-level themes) selects which
 * communities the query lives in, then a local pass returns that community's
 * query-matched seed entities and evidence-backed relations. Deterministic
 * end to end: no LLM, lexical term scoring only, every ordering fully
 * tie-broken (support, then id) — the agent is the reasoner, this is the
 * navigation surface.
 *
 * Stage 1 binds to the CURRENT graph fingerprint because community ids are
 * only stable within a fingerprint (the V2-Z1 keying). When reports exist
 * only for an older generation the result says so instead of silently
 * matching members against a partition that no longer exists.
 */

import { extractQueryTerms } from "../text/search.js";

export const DRIFT_MAX_COMMUNITIES = 3;
export const DRIFT_SEEDS_PER_COMMUNITY = 5;
export const DRIFT_EDGES_PER_COMMUNITY = 6;
export const DRIFT_EVIDENCE_MAX_CHARS = 240;

/** Report digest the global stage scores. Findings contribute their summary
 *  lines only — evidence quotes stay in the report record, not here. */
export interface DriftReportCard {
  readonly communityId: number;
  readonly communityName: string | null;
  readonly title: string;
  readonly summary: string;
  readonly rating: number | null;
  readonly findingSummaries: readonly string[];
}

export interface DriftMember {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly description: string | null;
  readonly supportCount: number;
}

export interface DriftIntraEdge {
  readonly id: string;
  readonly srcId: string;
  readonly dstId: string;
  readonly type: string;
  readonly supportCount: number;
  readonly evidenceQuote: string | null;
  readonly evidenceDocId: string | null;
}

/** Storage port (implemented by the KE store via the tools adapter). */
export interface DriftDataAccess {
  /** Fingerprint of the current graph partition; null when no graph yet. */
  graphFingerprint(kbId: string): Promise<string | null>;
  /** Reports of exactly this fingerprint (a generation, any status). */
  listCommunityReports(kbId: string, fingerprint: string): Promise<readonly DriftReportCard[]>;
  /** Community members (the adapter caps the read; ordering is re-derived). */
  listEntitiesByCommunity(kbId: string, communityId: number): Promise<readonly DriftMember[]>;
  /** Relations with both endpoints inside the community. */
  listEdgesWithinCommunity(kbId: string, communityId: number): Promise<readonly DriftIntraEdge[]>;
  /** Optional: fingerprint of the newest ready generation across ALL
   *  generations — lets an empty current-fingerprint result distinguish
   *  "never generated" from "stale generation". */
  latestReadyFingerprint?(kbId: string): Promise<string | null>;
}

export interface DriftSeedEntity {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly supportCount: number;
  /** Query terms found in this member's name/description (empty for the
   *  support-fill members that orient without a lexical hit). */
  readonly matchedTerms: readonly string[];
}

export interface DriftEvidenceEdge {
  readonly source: string;
  readonly target: string;
  readonly type: string;
  readonly supportCount: number;
  readonly evidenceQuote: string | null;
  readonly evidenceDocId: string | null;
  readonly matchedTerms: readonly string[];
}

export interface DriftCommunitySection {
  readonly communityId: number;
  readonly communityName: string | null;
  readonly title: string;
  readonly rating: number | null;
  /** Query terms that matched this report (stage-1 explanation). */
  readonly reportMatchedTerms: readonly string[];
  readonly reportScore: number;
  readonly memberCount: number;
  readonly seedEntities: readonly DriftSeedEntity[];
  readonly evidenceEdges: readonly DriftEvidenceEdge[];
  /** true when the community had more query-relevant edges than the cap. */
  readonly edgeTruncated: boolean;
}

export interface DriftSearchResult {
  readonly kbId: string;
  readonly query: string;
  readonly fingerprint: string;
  readonly status: "ok" | "no-graph" | "no-reports" | "no-terms";
  readonly communities: readonly DriftCommunitySection[];
  readonly elapsedMs: number;
  /** Why an empty status is empty (guidance, never a silent miss). */
  readonly note?: string;
}

const NOTE_NO_GRAPH = "no graph has been computed for this knowledge base yet — add documents and let extraction run before drift_search";
const NOTE_NO_TERMS = "query has no searchable terms";
const GUIDANCE_FALLBACK = "or fall back to kb_search / entity_unified_search which do not need reports";

/** Distinct terms present in `text` (substring, case-insensitive) with a
 *  small capped frequency bonus — same semantics as the kb_search scorer. */
function termHits(text: string, terms: readonly string[]): Map<string, number> {
  const lower = text.toLowerCase();
  const hits = new Map<string, number>();
  for (const term of terms) {
    let from = 0;
    let count = 0;
    for (;;) {
      const at = lower.indexOf(term, from);
      if (at === -1) break;
      count += 1;
      from = at + term.length;
      if (count >= 5) break;
    }
    if (count > 0) hits.set(term, 1 + Math.min(count, 5) * 0.2);
  }
  return hits;
}

function clampQuote(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= DRIFT_EVIDENCE_MAX_CHARS ? clean : `${clean.slice(0, DRIFT_EVIDENCE_MAX_CHARS - 1)}…`;
}

/** Stage 1: score reports against the query. Title hits count double (a title
 *  term is a stronger theme signal than a buried summary mention). */
function scoreReport(report: DriftReportCard, terms: readonly string[]): { score: number; matched: string[] } {
  const title = termHits(report.title, terms);
  const body = termHits(`${report.summary}\n${report.findingSummaries.join("\n")}`, terms);
  let score = 0;
  const matched: string[] = [];
  for (const term of terms) {
    const t = title.get(term);
    const b = body.get(term);
    if (t === undefined && b === undefined) continue;
    matched.push(term);
    score += (t ?? 0) * 2 + (b ?? 0);
  }
  return { score, matched };
}

export async function driftSearch(
  kbId: string,
  query: string,
  data: DriftDataAccess,
  opts: { maxCommunities?: number; seedsPerCommunity?: number; edgesPerCommunity?: number } = {},
): Promise<DriftSearchResult> {
  const started = Date.now();
  const maxCommunities = Math.max(1, Math.min(opts.maxCommunities ?? DRIFT_MAX_COMMUNITIES, 5));
  const seedsPerCommunity = Math.max(1, Math.min(opts.seedsPerCommunity ?? DRIFT_SEEDS_PER_COMMUNITY, 10));
  const edgesPerCommunity = Math.max(1, Math.min(opts.edgesPerCommunity ?? DRIFT_EDGES_PER_COMMUNITY, 15));

  const empty = (status: DriftSearchResult["status"], note: string, fingerprint = ""): DriftSearchResult => ({
    kbId,
    query,
    fingerprint,
    status,
    communities: [],
    elapsedMs: Date.now() - started,
    note,
  });

  const terms = extractQueryTerms(query);
  if (terms.length === 0) return empty("no-terms", NOTE_NO_TERMS);

  const fingerprint = await data.graphFingerprint(kbId);
  if (fingerprint === null) return empty("no-graph", NOTE_NO_GRAPH);

  const reports = await data.listCommunityReports(kbId, fingerprint);
  const ready = reports.filter((report) => report.summary.trim().length > 0);
  if (ready.length === 0) {
    // Distinguish never-generated from stale: the optional port knows whether
    // ANY ready generation exists for another fingerprint.
    let note = "no community reports exist for the current graph generation — generate them first (reports/generate), " + GUIDANCE_FALLBACK;
    if (data.latestReadyFingerprint) {
      const latest = await data.latestReadyFingerprint(kbId);
      if (latest !== null && latest !== fingerprint) {
        note = `community reports exist only for an older graph generation (${latest.slice(0, 24)}…, graph has since moved) — regenerate them for the current partition before drift_search, ` + GUIDANCE_FALLBACK;
      }
    }
    return empty("no-reports", note, fingerprint);
  }

  const scored = ready
    .map((report) => {
      const { score, matched } = scoreReport(report, terms);
      return { report, score, matched };
    })
    .filter((entry) => entry.matched.length > 0)
    .sort((a, b) =>
      b.score - a.score
      || (b.report.rating ?? 0) - (a.report.rating ?? 0)
      || a.report.communityId - b.report.communityId,
    );

  if (scored.length === 0) {
    return {
      ...empty("ok", "no community report lexically matches these terms — reports are theme-level digests, try kb_search for passage recall or rephrase with the corpus vocabulary", fingerprint),
    };
  }

  const communities: DriftCommunitySection[] = [];
  for (const entry of scored.slice(0, maxCommunities)) {
    const { report } = entry;

    const members = [...await data.listEntitiesByCommunity(kbId, report.communityId)]
      .sort((a, b) => b.supportCount - a.supportCount || a.id.localeCompare(b.id));
    const nameById = new Map(members.map((member) => [member.id, member.name]));

    // Stage 2a — seeds: query-matched members first (name hits weigh double),
    // then support-fill so the section still orients when the match was made
    // in the report prose rather than any member name (the DRIFT point: the
    // global layer's semantics decide WHERE to look, not the local lexicon).
    const seedScored = members
      .map((member) => {
        const name = termHits(member.name, terms);
        const desc = member.description ? termHits(member.description, terms) : new Map<string, number>();
        let score = 0;
        const matched: string[] = [];
        for (const term of terms) {
          const n = name.get(term);
          const d = desc.get(term);
          if (n === undefined && d === undefined) continue;
          matched.push(term);
          score += (n ?? 0) * 2 + (d ?? 0);
        }
        return { member, score, matched };
      })
      .sort((a, b) =>
        b.score - a.score
        || b.member.supportCount - a.member.supportCount
        || a.member.id.localeCompare(b.member.id),
      );
    const seeds: DriftSeedEntity[] = seedScored
      .filter((candidate) => candidate.score > 0)
      .slice(0, seedsPerCommunity)
      .map((candidate) => ({
        id: candidate.member.id,
        name: candidate.member.name,
        type: candidate.member.type,
        supportCount: candidate.member.supportCount,
        matchedTerms: candidate.matched,
      }));
    for (const candidate of seedScored) {
      if (seeds.length >= seedsPerCommunity) break;
      if (candidate.score > 0) continue;
      seeds.push({
        id: candidate.member.id,
        name: candidate.member.name,
        type: candidate.member.type,
        supportCount: candidate.member.supportCount,
        matchedTerms: [],
      });
    }

    // Stage 2b — evidence: intra-community relations whose quote or endpoint
    // names mention the query. Unmatched edges are not padded in — an
    // evidence line must earn its place.
    const edges = [...await data.listEdgesWithinCommunity(kbId, report.communityId)]
      .sort((a, b) => b.supportCount - a.supportCount || a.id.localeCompare(b.id));
    const edgeScored = edges
      .map((edge) => {
        const quote = edge.evidenceQuote ? termHits(edge.evidenceQuote, terms) : new Map<string, number>();
        const endpoints = termHits(
          `${nameById.get(edge.srcId) ?? ""} ${nameById.get(edge.dstId) ?? ""}`,
          terms,
        );
        let score = 0;
        const matched: string[] = [];
        for (const term of terms) {
          const q = quote.get(term);
          const e = endpoints.get(term);
          if (q === undefined && e === undefined) continue;
          matched.push(term);
          score += (q ?? 0) + (e ?? 0);
        }
        return { edge, score, matched };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) =>
        b.score - a.score
        || b.edge.supportCount - a.edge.supportCount
        || a.edge.id.localeCompare(b.edge.id),
      );
    const evidenceEdges: DriftEvidenceEdge[] = edgeScored.slice(0, edgesPerCommunity).map((candidate) => ({
      source: nameById.get(candidate.edge.srcId) ?? candidate.edge.srcId.slice(0, 8),
      target: nameById.get(candidate.edge.dstId) ?? candidate.edge.dstId.slice(0, 8),
      type: candidate.edge.type,
      supportCount: candidate.edge.supportCount,
      evidenceQuote: candidate.edge.evidenceQuote ? clampQuote(candidate.edge.evidenceQuote) : null,
      evidenceDocId: candidate.edge.evidenceDocId,
      matchedTerms: candidate.matched,
    }));

    communities.push({
      communityId: report.communityId,
      communityName: report.communityName,
      title: report.title,
      rating: report.rating,
      reportMatchedTerms: entry.matched,
      reportScore: Number(entry.score.toFixed(2)),
      memberCount: members.length,
      seedEntities: seeds,
      evidenceEdges,
      edgeTruncated: edgeScored.length > edgesPerCommunity,
    });
  }

  return {
    kbId,
    query,
    fingerprint,
    status: "ok",
    communities,
    elapsedMs: Date.now() - started,
  };
}

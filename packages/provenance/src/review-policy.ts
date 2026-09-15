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

import { createHash } from "node:crypto";

import type {
  ComposerReference,
  EvidenceAssessment,
  EvidenceLevel,
  EvidenceLocator,
  ReviewClaim,
  ScientificArtifactVersion,
  SourceAssessment,
  SourceSnapshot,
} from "@sciencediscovery/schema";

import type { EvidenceReferenceTraceResult, TraceEvidenceReference } from "./computation-review.js";

// Bump whenever the Deep evidence protocol changes so old semantic verdicts are not reused.
export const SEMANTIC_REVIEWER_VERSION = "2.3.0-source-availability-gate";
export const REVIEW_POLICY_VERSION = "2.3.0";
// Bounds apply to one model task, never to the number of reviewable items in
// a locked Artifact. Every detected reference and Evidence-linked claim gets
// its own queued task.
export const MAX_CITATION_CLAIM_CHARACTERS = 4_000;
export const MAX_EVIDENCE_CHARACTERS = 4_000;

export interface EvidenceBundleItem {
  alias: string;
  evidenceId: string;
  evidence?: EvidenceReferenceTraceResult["evidence"];
  paper?: EvidenceReferenceTraceResult["paper"];
}

/** A bounded, auditable numeric claim explicitly linked to an Evidence chip. */
export interface QuantitativeEvidenceClaim {
  alias: string;
  excerpt: string;
  values: string[];
}

/** A numeric statement explicitly tied to a generated Artifact chip. */
export interface QuantitativeArtifactClaim extends QuantitativeEvidenceClaim {
  artifactId: string;
  artifactVersion?: number;
}

export interface SemanticReviewExecutionMetadata {
  citationSkillHash: string;
  computationSkillHash: string;
  graphReviewEnabled?: boolean;
  modelIdentity: string;
  policyVersion?: string;
}

export interface ReviewAgentRequest {
  artifactLogicalName: string;
  artifactVersionId: string;
  citation?: { key: string; label: string; reference: string };
  checkpointId: string;
  prompt: string;
  sessionId: string;
  stage: "computation" | "citation";
}

/** A bounded, governed source snapshot obtained before the Citation model pass. */
export interface CitationSourceProbe {
  content?: string;
  /** Already-authorized, CAS-pinned material from the current Session only. */
  materials?: CitationSourceMaterial[];
  message?: string;
  /** Stable identity of the governed source, normally the citation key. */
  sourceId?: string;
  sourceType?: "abstract" | "paper_metadata";
  status: "available" | "unavailable";
  url?: string;
}

/** A bounded excerpt and stable position issued by the Reviewer evidence gateway. */
export interface CitationSourceMaterial {
  content: string;
  evidenceLevel: "E2" | "E3";
  locator: EvidenceLocator["locator"];
  sourceId: string;
  sourceType: "paper_fulltext" | "supplement" | "table";
}

export interface CitationEvidenceRecord {
  assessment: SourceAssessment;
  claim: ReviewClaim;
  locators: EvidenceLocator[];
  snapshots: SourceSnapshot[];
}

/** Read-only, version-pinned computation material. E4 is never inferred from prose. */
export interface ComputationSourceProbe {
  materials?: Array<{
    content: string;
    locator: EvidenceLocator["locator"];
    sourceId: string;
    sourceType: "artifact" | "code" | "execution";
  }>;
  message?: string;
  status: "available" | "unavailable";
}

export interface LiteratureCitationCandidate {
  /** Normalized first-author/year alias used by prose and table short citations. */
  authorYearKey?: string;
  key: string;
  label: string;
  marker?: string;
  reference: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Turn a single citation occurrence into a version-pinned claim. The planner
 * is deliberately deterministic at this stage: a model may later explain an
 * assessment but cannot invent a new claim or lower its evidence threshold.
 */
export function citationReviewClaim(
  content: string,
  version: ScientificArtifactVersion,
  candidate: LiteratureCitationCandidate,
): ReviewClaim {
  const text = citationClaimExcerpt(content, candidate);
  return {
    artifactVersionId: version.id,
    citationKeys: [candidate.key],
    id: `citation:${sha256(`${version.id}\u0000${candidate.key}\u0000${text}`).slice(0, 24)}`,
    kind: "citation",
    requiredEvidenceLevel: citationRequiredEvidenceLevel(text),
    text,
  };
}

function citationRequiredEvidenceLevel(text: string): EvidenceLevel {
  // Exact results need a table/figure/supplement locator; an abstract cannot
  // establish their denominator, unit, subgroup, or statistical scope.
  if (/(?:\bn\s*=|\bp\s*[<=>]|\b(?:95%\s*)?ci\b|\bhazard ratio\b|\bodds ratio\b|\brisk ratio\b|\b\d+(?:\.\d+)?\s*%|\btable\s*\d+\b|\bfigure\s*\d+\b)/iu.test(text)) return "E3";
  // Method, mechanism and scope claims require the paper body or a figure
  // legend. Keep this deliberately conservative: uncertain language stays E1.
  if (/\b(?:method|methods|protocol|cohort|randomi[sz]ed|mechanism|pathway|limitation|in vitro|in vivo|assay)\b/iu.test(text)) return "E2";
  return "E1";
}

/**
 * Convert a governed source response to immutable source facts. These facts
 * are useful without ScienceMemory and contain no provider-owned full text.
 */
export function citationEvidenceRecord(
  claim: ReviewClaim,
  probe: CitationSourceProbe,
): Omit<CitationEvidenceRecord, "assessment"> {
  const retrievedAt = new Date().toISOString();
  const material = [{
    content: probe.content?.slice(0, MAX_EVIDENCE_CHARACTERS) ?? "",
    evidenceLevel: "E1" as const,
    locator: { field: "governed_metadata_or_abstract" },
    sourceId: probe.sourceId ?? claim.citationKeys[0] ?? "unknown",
    sourceType: probe.sourceType ?? "paper_metadata",
  }, ...((probe.materials ?? []).map((item) => ({ ...item, content: item.content.slice(0, MAX_EVIDENCE_CHARACTERS) })))];
  const snapshots: SourceSnapshot[] = [];
  const locators: EvidenceLocator[] = [];
  for (const item of material) {
    const snapshotHash = sha256(item.content);
    const snapshotId = `snapshot:${snapshotHash.slice(0, 24)}`;
    const locatorId = `locator:${sha256(`${snapshotId}\u0000${JSON.stringify(item.locator)}\u0000${item.content}`).slice(0, 24)}`;
    snapshots.push({
      availability: probe.status === "available" && item.content ? "available" : "unavailable",
      evidenceLevel: item.evidenceLevel,
      id: snapshotId,
      retrievedAt,
      snapshot: { hash: snapshotHash, size: Buffer.byteLength(item.content) },
      sourceId: item.sourceId,
      sourceType: item.sourceType,
    });
    if (item.content) locators.push({
      excerpt: item.content.slice(0, 1_500),
      excerptHash: sha256(item.content.slice(0, 1_500)),
      id: locatorId,
      locator: item.locator,
      snapshotId,
    });
  }
  return {
    claim,
    locators,
    snapshots,
  };
}

export function computationReviewClaim(
  version: ScientificArtifactVersion,
  candidate: QuantitativeArtifactClaim,
): ReviewClaim {
  return {
    artifactVersionId: version.id,
    citationKeys: [],
    id: `computation:${sha256(`${version.id}\u0000${candidate.artifactId}\u0000${candidate.excerpt}`).slice(0, 24)}`,
    kind: "computation",
    requiredEvidenceLevel: "E4",
    text: candidate.excerpt,
  };
}

/**
 * Persist only source snapshots issued by the Reviewer gateway.  In
 * particular, a model cannot turn an Artifact chip into an E4 source itself.
 */
export function computationEvidenceRecord(
  claim: ReviewClaim,
  probe: ComputationSourceProbe,
): Omit<CitationEvidenceRecord, "assessment"> {
  const retrievedAt = new Date().toISOString();
  const snapshots: SourceSnapshot[] = [];
  const locators: EvidenceLocator[] = [];
  for (const item of probe.materials ?? []) {
    const content = item.content.slice(0, MAX_EVIDENCE_CHARACTERS);
    if (!content) continue;
    const snapshotHash = sha256(content);
    const snapshotId = `snapshot:${snapshotHash.slice(0, 24)}`;
    const locatorId = `locator:${sha256(`${snapshotId}\u0000${JSON.stringify(item.locator)}\u0000${content}`).slice(0, 24)}`;
    snapshots.push({
      availability: probe.status === "available" ? "available" : "unavailable",
      evidenceLevel: "E4",
      id: snapshotId,
      retrievedAt,
      snapshot: { hash: snapshotHash, size: Buffer.byteLength(content) },
      sourceId: item.sourceId,
      sourceType: item.sourceType,
    });
    locators.push({
      excerpt: content.slice(0, 1_500),
      excerptHash: sha256(content.slice(0, 1_500)),
      id: locatorId,
      locator: item.locator,
      snapshotId,
    });
  }
  return { claim, locators, snapshots };
}

/** Strong source assessments are impossible without a matching issued locator. */
export function validatedSourceAssessment(
  claim: ReviewClaim,
  raw: { assessment?: unknown; locatorIds?: unknown; rationale?: unknown },
  allowedLocatorIds: ReadonlySet<string> | ReadonlyMap<string, EvidenceLevel>,
): SourceAssessment {
  const requested = typeof raw.assessment === "string" ? raw.assessment.toUpperCase() : "INCONCLUSIVE";
  const assessment: EvidenceAssessment = requested === "SUPPORTED" || requested === "PARTIALLY_SUPPORTED" || requested === "CONTRADICTED"
    ? requested
    : "INCONCLUSIVE";
  const locatorLevel = (id: string): EvidenceLevel | undefined => allowedLocatorIds instanceof Map
    ? allowedLocatorIds.get(id)
    : allowedLocatorIds.has(id) ? "E1" : undefined;
  const locatorIds = Array.isArray(raw.locatorIds)
    ? [...new Set(raw.locatorIds.filter((id): id is string => typeof id === "string" && locatorLevel(id) !== undefined))]
    : [];
  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim().slice(0, 1_000) : "";
  if (assessment !== "INCONCLUSIVE" && !locatorIds.length) {
    return { assessment: "INCONCLUSIVE", claimId: claim.id, locatorIds: [], policyVersion: REVIEW_POLICY_VERSION, rationale: "Model assessment omitted an issued evidence locator." };
  }
  const rank: Record<EvidenceLevel, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 };
  if (assessment !== "INCONCLUSIVE" && !locatorIds.some((id) => rank[locatorLevel(id)!] >= rank[claim.requiredEvidenceLevel])) {
    return { assessment: "INCONCLUSIVE", claimId: claim.id, locatorIds: [], policyVersion: REVIEW_POLICY_VERSION, rationale: `Model assessment did not cite an issued ${claim.requiredEvidenceLevel} locator.` };
  }
  return { assessment, claimId: claim.id, locatorIds, policyVersion: REVIEW_POLICY_VERSION, rationale };
}

/** Whether the gateway issued a locator that can support this claim's evidence level. */
export function hasRequiredEvidenceLocator(
  claim: ReviewClaim,
  locators: EvidenceLocator[],
  snapshots: SourceSnapshot[],
): boolean {
  const rank: Record<EvidenceLevel, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 };
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  return locators.some((locator) => {
    const level = snapshotsById.get(locator.snapshotId)?.evidenceLevel;
    return level !== undefined && rank[level] >= rank[claim.requiredEvidenceLevel];
  });
}

/** @deprecated Use validatedSourceAssessment for all issued evidence levels. */
export const validatedCitationAssessment = validatedSourceAssessment;

/** E4 conclusions require the result data, code, and recorded execution together. */
export function validatedComputationAssessment(
  claim: ReviewClaim,
  raw: { assessment?: unknown; locatorIds?: unknown; rationale?: unknown },
  locators: EvidenceLocator[],
  snapshots: SourceSnapshot[],
): SourceAssessment {
  const levels = new Map(locators.map((locator) => [locator.id, "E4" as const]));
  const assessment = validatedSourceAssessment(claim, raw, levels);
  if (assessment.assessment === "INCONCLUSIVE") return assessment;
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const sourceTypes = new Set(assessment.locatorIds
    .map((id) => locators.find((locator) => locator.id === id))
    .map((locator) => locator ? snapshotsById.get(locator.snapshotId)?.sourceType : undefined));
  const required = ["artifact", "code", "execution"];
  if (!required.every((sourceType) => sourceTypes.has(sourceType as SourceSnapshot["sourceType"]))) {
    return {
      assessment: "INCONCLUSIVE", claimId: claim.id, locatorIds: [], policyVersion: REVIEW_POLICY_VERSION,
      rationale: "Model assessment did not cite the issued Artifact, code, and execution locators together.",
    };
  }
  return assessment;
}

/** Extract stable, bounded units so a bibliography is reviewed one paper at a time. */
export function literatureCitationCandidates(content: string): LiteratureCitationCandidate[] {
  const candidates = new Map<string, LiteratureCitationCandidate>();
  const registeredReferenceLines: string[] = [];
  const referenceKeysByAuthorYear = new Set<string>();
  // Generated reports commonly add an explanatory parenthesis to this heading,
  // for example: "参考文献（本报告引用的核心证据）".
  const referenceHeading = /^\s*(?:#{1,6}\s*)?(?:\d+(?:\.\d+)*[.)、]?\s*)?(?:references|bibliography|参考文献|引用依据)(?:\s*[（(][^）)]*[）)])?\s*[:：]?\s*$/iu;
  let inReferenceSection = false;
  const normalizeAuthor = (value: string): string => value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  const authorYearKey = (reference: string): string | undefined => {
    const match = reference.match(/\b([\p{L}'’-]+)(?:\s+[A-Z][\p{L}.-]*)?\s*,?\s*et al\.,?[^\n]*?\b((?:19|20)\d{2})\b/iu);
    return match ? `${normalizeAuthor(match[1]!)}:${match[2]!}` : undefined;
  };
  const add = (key: string, label: string, reference: string, marker?: string, authorYear?: string) => {
    const existing = candidates.get(key);
    if (existing) {
      // A bibliography entry is richer than a table's abbreviated label. Keep
      // the full entry and remember its numbered marker when it arrives later.
      if (reference.length > existing.reference.length) existing.reference = reference.slice(0, 1_500);
      if (marker && !existing.marker) existing.marker = marker;
      if (authorYear && !existing.authorYearKey) existing.authorYearKey = authorYear;
      return existing;
    }
    const candidate: LiteratureCitationCandidate = {
      key,
      label: label.slice(0, 100),
      ...(marker ? { marker } : {}),
      reference: reference.slice(0, 1_500),
      ...(authorYear ? { authorYearKey: authorYear } : {}),
    };
    candidates.set(key, candidate);
    return candidate;
  };
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (referenceHeading.test(line)) {
      inReferenceSection = true;
      continue;
    }
    // A later Markdown heading ends the bibliography. This prevents numbered
    // "next steps" lists from being mistaken for reference [1], [2], etc.
    if (inReferenceSection && /^#{1,6}\s+\S/u.test(line)) inReferenceSection = false;
    const numbered = line.match(/^\s*(?:\[(\d+)\]|(\d+)[.)、])\s+(.+)$/u);
    const marker = numbered ? `[${numbered[1] ?? numbered[2]!}]` : undefined;
    const identifier = [
      ...line.matchAll(/\b(10\.\d{4,9}\/[\w.()\-;/]+)\b/giu),
    ].map((match) => ({ key: `doi:${match[1]!.toLowerCase()}`, label: `DOI: ${match[1]!.toLowerCase()}` }))[0]
      ?? [...line.matchAll(/\beurope[-_\s]?pmc\s*:\s*(pmc\d{4,10}|\d{4,9})\b/giu)].map((match) => {
        const value = match[1]!.toLowerCase();
        return value.startsWith("pmc")
          ? { key: `pmcid:${value}`, label: `PMCID: ${value}` }
          : { key: `pmid:${value}`, label: `PMID: ${value}` };
      })[0]
      ?? (["pmid", "pmcid", "arxiv"] as const).flatMap((prefix) => {
        const expression = prefix === "pmid" ? /\bpmid\s*:?\s*(\d{4,9})\b/giu
          : prefix === "pmcid" ? /\b(?:pmcid\s*:?\s*)?(pmc\d{4,10})\b/giu
          : /\barxiv\s*:\s*([\w.-]+\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)\b/giu;
        return [...line.matchAll(expression)].map((match) => ({ key: `${prefix}:${match[1]!.toLowerCase()}`, label: `${prefix.toUpperCase()}: ${match[1]!.toLowerCase()}` }));
      })[0]
      // Reports commonly render stable identifiers as links in Markdown
      // tables. Normalize canonical provider URLs before falling back to a
      // generic URL candidate so exact provider queries remain possible.
      ?? [...line.matchAll(/https?:\/\/(?:www\.)?(?:pubmed\.ncbi\.nlm\.nih\.gov\/(\d{4,9})|ncbi\.nlm\.nih\.gov\/pubmed\/(\d{4,9}))(?!\d)/giu)].map((match) => {
        const value = (match[1] ?? match[2]!).toLowerCase();
        return { key: `pmid:${value}`, label: `PMID: ${value}` };
      })[0]
      ?? [...line.matchAll(/https?:\/\/(?:www\.)?europepmc\.org\/article\/(PMC|MED)\/(PMC\d{4,10}|\d{4,9})(?!\d)/giu)].map((match) => {
        const namespace = match[1]!.toLowerCase();
        const value = match[2]!.toLowerCase();
        return namespace === "pmc" || value.startsWith("pmc")
          ? { key: `pmcid:${value}`, label: `PMCID: ${value}` }
          : { key: `pmid:${value}`, label: `PMID: ${value}` };
      })[0]
      ?? [...line.matchAll(/\bppr\s*(\d{4,10})\b/giu)].map((match) => {
        const value = `ppr${match[1]!}`.toLowerCase();
        return { key: `ppr:${value}`, label: `PPR: ${value}` };
      })[0]
      ?? [...line.matchAll(/https?:\/\/[^\s<>()\]]+/giu)].map((match) => {
        const value = match[0]!.replace(/[.,;:]+$/u, "");
        return { key: `url:${value.toLowerCase()}`, label: "Public source URL" };
      })[0];
    const referenceAuthorYear = authorYearKey(line);
    if (identifier) {
      add(identifier.key, identifier.label, line, marker, referenceAuthorYear);
      registeredReferenceLines.push(line.toLowerCase());
      if (inReferenceSection && referenceAuthorYear) referenceKeysByAuthorYear.add(referenceAuthorYear);
    } else if (numbered && inReferenceSection && /(?:19|20)\d{2}/u.test(numbered[3]!)) {
      const number = numbered[1] ?? numbered[2]!;
      add(`reference:${number}:${numbered[3]!.toLowerCase()}`, `[${number}]`, line, marker, referenceAuthorYear);
      registeredReferenceLines.push(line.toLowerCase());
      if (referenceAuthorYear) referenceKeysByAuthorYear.add(referenceAuthorYear);
    }
  }
  for (const match of content.matchAll(/\b([A-Z][A-Za-z'’-]+)\s+et al\.,?\s*(?:\(|,)?\s*((?:19|20)\d{2})\b/gu)) {
    const reference = match[0];
    const key = `${normalizeAuthor(match[1]!)}:${match[2]!}`;
    if (!referenceKeysByAuthorYear.has(key) && !registeredReferenceLines.some((line) => line.includes(reference.toLowerCase()))) {
      add(`author-year:${key}`, `${match[1]} et al., ${match[2]}`, reference, undefined, key);
    }
  }
  return [...candidates.values()];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Select only the narrative fragments explicitly linked to one bibliography item. */
export function citationClaimExcerpt(content: string, candidate: LiteratureCitationCandidate): string {
  const citationNumber = candidate.marker?.match(/\d+/u)?.[0];
  const marker = citationNumber
    ? new RegExp(`(?:\\[|【)[^\\]】]*\\b${escapeRegex(citationNumber)}\\b[^\\]】]*(?:\\]|】)`, "u")
    : undefined;
  const authorYear = candidate.authorYearKey?.match(/^([^:]+):(\d{4})$/u);
  const authorYearPattern = authorYear
    ? new RegExp(`\\b${escapeRegex(authorYear[1]!)}(?:\\s+[A-Z][\\p{L}.-]*)?\\s*,?\\s*et al\\.,?\\s*(?:\\(|,)?\\s*${escapeRegex(authorYear[2]!)}`, "iu")
    : undefined;
  const identifier = candidate.key.match(/^(?:doi|pmid|pmcid|arxiv):(.+)$/u)?.[1];
  const identifierContext = identifier
    ? content.split(/\r?\n/gu)
      .filter((line) => line.trim() && line.trim() !== candidate.reference.trim())
      .filter((line) => line.toLowerCase().includes(identifier.toLowerCase()))
    : [];
  const excerpts = content.split(/\r?\n/gu)
    .filter((line) => line.trim() && line.trim() !== candidate.reference.trim())
    .filter((line) => marker?.test(line) || authorYearPattern?.test(line.normalize("NFKD").replace(/\p{Diacritic}/gu, "")))
    .join("\n");
  // Inline Europe PMC identifiers often appear at the end of the sentence they
  // support instead of in a bibliography. Use that bounded line as the claim
  // context when there is no separate numeric/author-year marker.
  const fallback = candidate.reference.includes("Europe-pmc:") || candidate.reference.includes("EuropePMC:")
    ? candidate.reference
    : "No explicit nearby Artifact claim was located for this citation.";
  return (identifierContext.join("\n") || excerpts || fallback)
    .slice(0, MAX_CITATION_CLAIM_CHARACTERS);
}

export type ExecuteReviewAgent = (
  input: ReviewAgentRequest,
  signal?: AbortSignal,
) => Promise<string>;

export interface SemanticReviewOptions extends SemanticReviewExecutionMetadata {
  execute: ExecuteReviewAgent;
  probeComputation?: (claim: QuantitativeArtifactClaim, signal?: AbortSignal) => Promise<ComputationSourceProbe>;
  probeCitation?: (input: ReviewAgentRequest, signal?: AbortSignal) => Promise<CitationSourceProbe>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeEvidenceAlias(value: string): string {
  return value.trim().replace(/^\[|\]$/gu, "").toLowerCase();
}

export function artifactEvidenceAliases(content: string): string[] {
  return [...new Set(
    [...content.matchAll(/\[((?:ev|evidence)\d+)\]/giu)].map((match) => normalizeEvidenceAlias(match[1]!)),
  )];
}

function numericClaimExcerpts(content: string): string[] {
  return content.split(/\r?\n/gu).flatMap((line) => {
    const trimmed = line.trim();
    if (/^\|.*\|$/u.test(trimmed) && !/^\|?\s*:?-{3,}/u.test(trimmed)) {
      return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
    }
    return trimmed.split(/(?<=[.!?。！？])\s+/gu);
  }).map((excerpt) => excerpt.trim()).filter(Boolean);
}

function numericClaimValues(excerpt: string): string[] {
  const withoutReferences = excerpt.replace(/\[[^\]]+\]/gu, " ");
  const valuePattern = /\b\d+(?:\.\d+)?\s*[–-]\s*\d+(?:\.\d+)?\s*(?:%|‰)(?!\w)|\b\d+(?:\.\d+)?\s*(?:%|‰)(?!\w)|\b\d+(?:\.\d+)?\s*(?:mg\/?L|ng\/?mL|μg\/?mL|mmol\/?L)\b|\b(?:n\s*=\s*)\d+\b|\b\d+\s*(?:patients?|cases?|subjects?)\b|\b\d+\s*(?:例|人|名)\b|\b(?:p|hr|or|rr)\s*(?:=|<|>|≤|≥)\s*\d+(?:\.\d+)?\b/giu;
  return [...withoutReferences.matchAll(valuePattern)]
    .map((match) => match[0]!.trim())
    .filter((value, index, all) => Boolean(value) && all.indexOf(value) === index)
    .slice(0, 8);
}

/**
 * Keep Deep Computation focused on claims it can actually assess. A bare
 * `[evidenceN]` reference is still checked by Quick graph integrity, but does not
 * need a model-only numeric comparison.
 */
export function quantitativeEvidenceClaims(content: string): QuantitativeEvidenceClaim[] {
  const claims: QuantitativeEvidenceClaim[] = [];
  const seen = new Set<string>();
  for (const excerpt of numericClaimExcerpts(content)) {
    const aliases = [...new Set([...excerpt.matchAll(/\[((?:ev|evidence)\d+)\]/giu)]
      .map((match) => normalizeEvidenceAlias(match[1]!)))];
    if (!aliases.length) continue;
    const values = numericClaimValues(excerpt);
    if (!values.length) continue;
    for (const alias of aliases) {
      const claim = { alias, excerpt: excerpt.slice(0, 1_000), values };
      const key = `${claim.alias}\u0000${claim.excerpt}\u0000${claim.values.join("\u0000")}`;
      if (!seen.has(key)) {
        seen.add(key);
        claims.push(claim);
      }
    }
  }
  return claims;
}

/** Numeric claims with a declared generated-Artifact chip, planned for E4. */
export function quantitativeArtifactClaims(
  content: string,
  version: ScientificArtifactVersion,
): QuantitativeArtifactClaim[] {
  const artifactReferences = new Map(
    (version.references ?? [])
      .filter((reference): reference is ComposerReference => reference.kind === "artifact")
      .map((reference) => [normalizeEvidenceAlias(reference.label), reference]),
  );
  if (!artifactReferences.size) return [];
  const claims: QuantitativeArtifactClaim[] = [];
  const seen = new Set<string>();
  for (const rawExcerpt of numericClaimExcerpts(content)) {
    const values = numericClaimValues(rawExcerpt);
    if (!values.length) continue;
    for (const marker of rawExcerpt.matchAll(/\[([^\]]+)\]/gu)) {
      const reference = artifactReferences.get(normalizeEvidenceAlias(marker[1]!));
      if (!reference) continue;
      const claim = {
        alias: normalizeEvidenceAlias(marker[1]!),
        artifactId: reference.id,
        ...(reference.version !== undefined ? { artifactVersion: reference.version } : {}),
        excerpt: rawExcerpt.slice(0, 1_000),
        values,
      };
      const key = `${claim.artifactId}\u0000${claim.artifactVersion ?? "latest"}\u0000${claim.excerpt}`;
      if (!seen.has(key)) { seen.add(key); claims.push(claim); }
    }
  }
  return claims;
}

export async function buildEvidenceBundle(
  content: string,
  version: ScientificArtifactVersion,
  traceEvidenceReference: TraceEvidenceReference | undefined,
  signal?: AbortSignal,
): Promise<EvidenceBundleItem[]> {
  const references = new Map(
    (version.references ?? [])
      .filter((reference) => reference.kind === "evidence")
      .map((reference) => [normalizeEvidenceAlias(reference.label), reference.id]),
  );
  const bundle: EvidenceBundleItem[] = [];
  for (const alias of artifactEvidenceAliases(content)) {
    if (signal?.aborted) throw new DOMException("Review cancelled", "AbortError");
    const evidenceId = references.get(alias);
    if (!evidenceId) continue;
    const trace = traceEvidenceReference
      ? await traceEvidenceReference({ alias, evidenceId }, signal)
      : undefined;
    bundle.push({
      alias,
      evidenceId,
      ...(trace?.evidence ? { evidence: trace.evidence } : {}),
      ...(trace?.paper ? { paper: trace.paper } : {}),
    });
  }
  return bundle;
}

export function semanticReviewFingerprint(
  contentHash: string,
  version: ScientificArtifactVersion,
  bundle: EvidenceBundleItem[],
  metadata: SemanticReviewExecutionMetadata,
): string {
  const referenceMap = (version.references ?? [])
    .filter((reference) => reference.kind === "evidence")
    .map((reference) => ({ alias: normalizeEvidenceAlias(reference.label), evidenceId: reference.id }))
    .toSorted((left, right) => left.alias.localeCompare(right.alias));
  return createHash("sha256").update(canonicalJson({
    bundle,
    citationSkillHash: metadata.citationSkillHash,
    computationSkillHash: metadata.computationSkillHash,
    contentHash,
    graphReviewEnabled: metadata.graphReviewEnabled ?? true,
    modelIdentity: metadata.modelIdentity,
    policyVersion: metadata.policyVersion ?? REVIEW_POLICY_VERSION,
    referenceMap,
  })).digest("hex");
}

function clipped(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

export function promptEvidenceBundle(bundle: EvidenceBundleItem[]): unknown[] {
  return bundle.map((item) => ({
    alias: item.alias,
    evidenceId: item.evidenceId,
    evidence: item.evidence ? {
      content: clipped(item.evidence.content, MAX_EVIDENCE_CHARACTERS),
      evidenceType: clipped(item.evidence.evidenceType, 200),
      locator: clipped(item.evidence.locator, 500),
      strength: clipped(item.evidence.strength, 100),
    } : undefined,
    paper: item.paper ? {
      abstract: clipped(item.paper.abstract, MAX_EVIDENCE_CHARACTERS),
      authors: item.paper.authors,
      identifier: clipped(item.paper.identifier, 500),
      identifierType: clipped(item.paper.identifierType, 100),
      link: clipped(item.paper.link, 1_000),
      source: clipped(item.paper.source, 200),
      title: clipped(item.paper.title, 1_000),
      year: clipped(item.paper.year, 20),
    } : undefined,
  }));
}

export function parseReviewAgentObject(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const first = unfenced.indexOf("{");
  const last = unfenced.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("Reviewer Specialist returned no JSON object");
  const parsed = JSON.parse(unfenced.slice(first, last + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Reviewer Specialist result must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

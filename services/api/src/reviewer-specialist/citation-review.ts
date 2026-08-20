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

import { randomUUID } from "node:crypto";

import type {
  ArtifactReviewFinding,
  ArtifactReviewRun,
  ScientificArtifactVersion,
} from "@sciencediscovery/schema";
import { formatExternalUrl } from "@sciencediscovery/schema";

import { normalizeEvidenceAlias } from "./review-policy.js";
import type { CitationSourceProbe, LiteratureCitationCandidate } from "./review-policy.js";

export const SMART_CITATION_REVIEW_INSTRUCTIONS = [
  "Citation review: follow the built-in citation-reviewer protocol.",
  "The supplied source snapshot was returned by governed literature search. Do not call tools or search for other sources.",
  "Work in this strict order: (1) verify paper identity, then (2) check whether the nearby Artifact claim is supported. Use the target reference and source snapshot for identity verification.",
  "After identity verification, compare the target citation's nearby Artifact claim with the verified metadata, abstract, and supplied Evidence Bundle. Check the conclusion, population, intervention or method, outcome, and stated scope; an abstract supports only what it actually says.",
  "Return CITATION_CLAIM_NOT_SUPPORTED only for a clear contradiction or an over-broad claim that the available source information does not support. If abstract and public information are not enough to decide, set Citation status to INCONCLUSIVE without inventing a finding. Do not download full text.",
].join("\n");

const MAX_SOURCE_SNAPSHOT_CHARACTERS = 12_000;
// Deep review must prefer a missed finding to a false one. A model may only
// report a claim contradiction after the execution layer has verified that the
// governed source belongs to the cited stable identifier.
const MODEL_ACTIONABLE_CITATION_CODES = new Set([
  "CITATION_CLAIM_NOT_SUPPORTED",
]);

/** Resolve a reference to one public source URL without granting shell or arbitrary code access. */
export function citationSourceUrl(candidate: LiteratureCitationCandidate): string | undefined {
  const direct = candidate.reference.match(/https?:\/\/[^\s<>()\]]+/iu)?.[0];
  if (direct) return direct.replace(/[.,;:]+$/u, "");
  const [kind, value] = candidate.key.split(/:(.+)/u);
  if (!value) return undefined;
  if (kind === "doi") return formatExternalUrl("data_sources.doi.canonical_template", { doi: value });
  if (kind === "pmid") return formatExternalUrl("data_sources.ncbi.pubmed_article_template", { pmid: value });
  if (kind === "pmcid") {
    return formatExternalUrl("data_sources.europe_pmc.pmc_article_template", { identifier: value.toUpperCase() });
  }
  if (kind === "arxiv") return formatExternalUrl("data_sources.arxiv.article_template", { identifier: value });
  if (kind === "ppr") {
    return formatExternalUrl("data_sources.europe_pmc.article_template", {
      identifier: value.toUpperCase(),
      source: "PPR",
    });
  }
  if (kind === "url") return value;
  return undefined;
}

/** Keep provider results bounded before they are passed to a semantic model. */
export function citationSourceSnapshot(url: string, result: unknown): CitationSourceProbe {
  const content = typeof result === "string"
    ? result
    : result && typeof result === "object" && typeof (result as { content?: unknown }).content === "string"
      ? (result as { content: string }).content
      : JSON.stringify(result);
  return {
    content: content.slice(0, MAX_SOURCE_SNAPSHOT_CHARACTERS),
    status: "available",
    url,
  };
}

/** Deep Citation is for narrative Artifacts that make an identifiable literature claim. */
export function hasExplicitLiteratureCitation(content: string): boolean {
  return /\b(?:doi\s*:\s*10\.\d{4,9}\/|pmid\s*:\s*\d{4,9}|pmcid\s*:\s*pmc\d{4,10}|europe[-_\s]?pmc\s*:\s*(?:pmc\d{4,10}|\d{4,9})|arxiv\s*:\s*\d{4}\.\d{4,5}|ppr\d{4,10})/iu.test(content)
    || /(?:\[\d+\]|\[\^[^\]]+\]|\bet al\.,?\s*(?:\(|,)?\s*(?:19|20)\d{2}\b)/iu.test(content);
}

interface CitationFindingPayload {
  code?: unknown;
  evidenceAliases?: unknown;
  message?: unknown;
  severity?: unknown;
}

interface CitationStagePayload {
  findings?: unknown;
  status?: unknown;
}

export function parseSmartCitationReview(
  payload: unknown,
  version: ScientificArtifactVersion,
  allowedAliases: Set<string>,
): { findings: ArtifactReviewFinding[]; inconclusive: boolean } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Reviewer Specialist citation result is missing");
  }
  const stage = payload as CitationStagePayload;
  const status = typeof stage.status === "string" ? stage.status.toUpperCase() : "";
  if (status !== "COMPLETED" && status !== "INCONCLUSIVE") {
    throw new Error("Reviewer Specialist citation status is invalid");
  }
  if (!Array.isArray(stage.findings)) {
    throw new Error("Reviewer Specialist citation findings must be an array");
  }
  let discardedUnverifiedFinding = false;
  const findings = stage.findings.flatMap((raw): ArtifactReviewFinding[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Reviewer Specialist citation finding is invalid");
    }
    const finding = raw as CitationFindingPayload;
    const code = typeof finding.code === "string" ? finding.code.trim().toUpperCase() : "";
    const message = typeof finding.message === "string" ? finding.message.trim() : "";
    const severity = finding.severity === "critical"
      ? "critical"
      : finding.severity === "warning" ? "warning" : undefined;
    if (!code.startsWith("CITATION_") || !message || !severity) {
      throw new Error("Reviewer Specialist citation finding is invalid");
    }
    // Identifier resolution is established before the model sees a source
    // snapshot. Do not expose improvised or source-availability findings as
    // Artifact defects: they are operationally inconclusive, not evidence of
    // a bad citation.
    if (!MODEL_ACTIONABLE_CITATION_CODES.has(code)) {
      discardedUnverifiedFinding = true;
      return [];
    }
    const aliases = Array.isArray(finding.evidenceAliases)
      ? [...new Set(finding.evidenceAliases
        .filter((alias): alias is string => typeof alias === "string")
        .map(normalizeEvidenceAlias)
        .filter((alias) => allowedAliases.has(alias)))]
      : [];
    return [{
      code,
      evidenceRefs: [`artifact:${version.id}`, ...aliases.map((alias) => `evidence-alias:${alias}`)],
      id: randomUUID(),
      message: message.slice(0, 1_000),
      severity,
      status: "open",
    }];
  });
  return { findings, inconclusive: status === "INCONCLUSIVE" || discardedUnverifiedFinding };
}

export function reviewerSpecialistRequested(message: string): boolean {
  return /\breviewer[\s_-]*specialist\b/iu.test(message);
}

export function reviewerSpecialistAvailable(enabled: boolean, message: string): boolean {
  return enabled && reviewerSpecialistRequested(message);
}

export function offlineCitationPrecheck(content: Buffer, versionId: string): {
  decision: ArtifactReviewRun["decision"];
  findings: ArtifactReviewFinding[];
} {
  const text = content.toString("utf8");
  const lines = text.split(/\r?\n/u);
  const identifiers = [
    /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/giu,
    /\barxiv\s*:\s*(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+\/\d{7})(?!\w)/giu,
    /\bpmid\s*:\s*\d{4,9}\b/giu,
    /\bpmc\d{4,10}\b/giu,
    /\beurope[-_\s]?pmc\s*:\s*(?:pmc\d{4,10}|\d{4,9})\b/giu,
    /https?:\/\/[^\s<>()\]]+/giu,
  ].flatMap((pattern) => text.match(pattern) ?? []);
  const referenceHeading = /^(?:#{1,6}\s*)?(?:references|bibliography|参考文献|引用依据)\s*[:：]?\s*$/iu;
  const numericDefinition = /^\s*(?:\[(\d+)\]|(\d+)[.)、])\s+\S/u;
  const footnoteDefinition = /^\s*\[\^([^\]]+)\]:\s*\S/u;
  const definitionNumbers = new Set<string>();
  const footnoteDefinitions = new Set<string>();
  let hasReferenceHeading = false;
  let hasReferenceEntry = false;
  const proseLines = lines.filter((line) => {
    if (referenceHeading.test(line.trim())) {
      hasReferenceHeading = true;
      return false;
    }
    const numeric = line.match(numericDefinition);
    if (numeric) {
      definitionNumbers.add(numeric[1] ?? numeric[2]!);
      hasReferenceEntry = true;
      return false;
    }
    const footnote = line.match(footnoteDefinition);
    if (footnote) {
      footnoteDefinitions.add(footnote[1]!);
      hasReferenceEntry = true;
      return false;
    }
    if (hasReferenceHeading) {
      if (line.trim()) hasReferenceEntry = true;
      return false;
    }
    return true;
  });
  const prose = proseLines.join("\n");
  const numericMarkers = [...prose.matchAll(/(?:\[|【)(\d+(?:\s*[-,，]\s*\d+)*)(?:\]|】)/gu)]
    .flatMap((match) => match[1]!.split(/\s*[-,，]\s*/u));
  const footnoteMarkers = [...prose.matchAll(/\[\^([^\]]+)\]/gu)].map((match) => match[1]!);
  const evidenceMarkers = [...prose.matchAll(/\[(ev\d+)\]/giu)].map((match) => match[1]!);
  const hasAuthorYearMarker = /\([^()\n]*(?:19|20)\d{2}[a-z]?[^()\n]*\)|\bet al\.,?\s*(?:\(|,)?\s*(?:19|20)\d{2}\b/iu.test(prose);
  const hasSuperscriptMarker = /<sup>\s*\d+(?:\s*[-,]\s*\d+)*\s*<\/sup>|[¹²³⁴⁵⁶⁷⁸⁹⁰]+/iu.test(prose);
  const hasInlineSourceLink = /\[[^\]]+\]\(https?:\/\/[^)]+\)|https?:\/\/\S+/iu.test(prose);
  const hasInlineMarker = numericMarkers.length > 0
    || footnoteMarkers.length > 0
    || evidenceMarkers.length > 0
    || hasAuthorYearMarker
    || hasSuperscriptMarker
    || hasInlineSourceLink;
  const obviousMissingIdentifier = /\b(?:doi|arxiv|pmid|pmcid)\s*:\s*(?:todo|tbd|missing|n\/?a|\?+)?\s*(?:$|[\n,;])/iu.test(text);
  const hasCitation = identifiers.length > 0
    || hasReferenceHeading
    || hasInlineMarker
    || obviousMissingIdentifier;

  if (!hasCitation) return { decision: "SKIPPED", findings: [] };
  const findings: ArtifactReviewFinding[] = [];
  const missingFootnotes = [...new Set(footnoteMarkers.filter((id) => !footnoteDefinitions.has(id)))];
  const missingNumericReferences = [...new Set(numericMarkers.filter((id) => !definitionNumbers.has(id)))]
    .filter(() => !hasReferenceHeading && identifiers.length === 0);
  if (obviousMissingIdentifier) {
    findings.push({
      code: "CITATION_IDENTIFIER_MISSING",
      evidenceRefs: [`artifact:${versionId}`],
      id: randomUUID(),
      message: "A citation identifier is marked as missing or unfinished.",
      severity: "warning",
      status: "open",
    });
  }
  if (missingFootnotes.length || missingNumericReferences.length || (hasReferenceHeading && !hasReferenceEntry)) {
    const missing = [...missingFootnotes, ...missingNumericReferences];
    findings.push({
      code: "CITATION_REFERENCE_MISSING",
      evidenceRefs: [`artifact:${versionId}`],
      id: randomUUID(),
      message: missing.length
        ? `Citation marker(s) ${missing.join(", ")} have no matching reference entry.`
        : "The references section is empty.",
      severity: "warning",
      status: "open",
    });
  } else if (identifiers.length && !hasInlineMarker) {
    findings.push({
      code: "CITATION_MARKER_MISSING",
      evidenceRefs: [`artifact:${versionId}`],
      id: randomUUID(),
      message: "A source identifier was found, but no inline citation marker links it to the text.",
      severity: "warning",
      status: "open",
    });
  }
  return {
    decision: findings.length ? "REVISE_AND_RETRY" : "ACCEPT_AND_PROCEED",
    findings,
  };
}

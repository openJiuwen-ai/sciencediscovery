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
  MemoryGraphTraceResult,
  ScientificArtifactVersion,
} from "@science-agent/schema";

import type { MemoryGraphClient } from "../memory-graph.js";
import { normalizeEvidenceAlias } from "./review-policy.js";

export const SMART_COMPUTATION_REVIEW_INSTRUCTIONS = [
  "Computation review: load and follow computation-reviewer before citation review.",
  "Use only the supplied locked Artifact and Evidence Bundle. Do not call MCP literature tools, web_search, or web_fetch.",
  "For every quantitative claim carrying [evidenceN], compare the value, unit, population, condition, and interpretation with the supplied Evidence Bundle.",
  "Report only material unsupported or contradictory claims; do not infer missing source content.",
].join("\n");

interface ComputationFindingPayload {
  code?: unknown;
  evidenceAliases?: unknown;
  message?: unknown;
  severity?: unknown;
}

interface ComputationStagePayload {
  findings?: unknown;
  status?: unknown;
}

export function parseSmartComputationReview(
  payload: unknown,
  version: ScientificArtifactVersion,
  allowedAliases: Set<string>,
): { findings: ArtifactReviewFinding[]; inconclusive: boolean } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Reviewer Specialist computation result is missing");
  }
  const stage = payload as ComputationStagePayload;
  const status = typeof stage.status === "string" ? stage.status.toUpperCase() : "";
  if (status !== "COMPLETED" && status !== "INCONCLUSIVE") {
    throw new Error("Reviewer Specialist computation status is invalid");
  }
  if (!Array.isArray(stage.findings)) {
    throw new Error("Reviewer Specialist computation findings must be an array");
  }
  const findings = stage.findings.map((raw): ArtifactReviewFinding => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Reviewer Specialist computation finding is invalid");
    }
    const finding = raw as ComputationFindingPayload;
    const code = typeof finding.code === "string" ? finding.code.trim().toUpperCase() : "";
    const message = typeof finding.message === "string" ? finding.message.trim() : "";
    const severity = finding.severity === "critical"
      ? "critical"
      : finding.severity === "warning" ? "warning" : undefined;
    if (!code.startsWith("COMPUTATION_") || !message || !severity) {
      throw new Error("Reviewer Specialist computation finding is invalid");
    }
    const aliases = Array.isArray(finding.evidenceAliases)
      ? [...new Set(finding.evidenceAliases
        .filter((alias): alias is string => typeof alias === "string")
        .map(normalizeEvidenceAlias)
        .filter((alias) => allowedAliases.has(alias)))]
      : [];
    return {
      code,
      evidenceRefs: [`artifact:${version.id}`, ...aliases.map((alias) => `evidence-alias:${alias}`)],
      id: randomUUID(),
      message: message.slice(0, 1_000),
      severity,
      status: "open",
    };
  });
  return { findings, inconclusive: status === "INCONCLUSIVE" };
}

export interface ArtifactProvenanceReference {
  artifactId: string;
  artifactVersion: number;
  provenanceRef: string;
}

export type TraceArtifactProvenance = (
  reference: ArtifactProvenanceReference,
  signal?: AbortSignal,
) => Promise<MemoryGraphTraceResult>;

export interface QuickComputationReviewResult {
  findings: ArtifactReviewFinding[];
  provenanceRef: string;
}

export interface EvidenceReferenceTraceResult {
  evidence?: {
    content?: string;
    evidenceType?: string;
    locator?: string;
    strength?: string;
  };
  evidenceFound: boolean;
  paper?: {
    abstract?: string;
    authors?: string[];
    identifier?: string;
    identifierType?: string;
    link?: string;
    source?: string;
    title?: string;
    year?: string;
  };
  paperLinked: boolean;
  reason?: string;
  truncated?: boolean;
}

export type TraceEvidenceReference = (
  reference: { alias: string; evidenceId: string },
  signal?: AbortSignal,
) => Promise<EvidenceReferenceTraceResult>;

const QUICK_PROVENANCE_TIMEOUT_MS = 5_000;

export function artifactProvenanceReference(
  version: ScientificArtifactVersion,
): ArtifactProvenanceReference {
  return {
    artifactId: version.artifactId,
    artifactVersion: version.version,
    provenanceRef: `${version.artifactId}#v${version.version}`,
  };
}

function finding(
  version: ScientificArtifactVersion,
  provenanceRef: string,
  code: string,
  message: string,
  severity: ArtifactReviewFinding["severity"],
): ArtifactReviewFinding {
  return {
    code,
    evidenceRefs: [`artifact:${version.id}`, `provenance:${provenanceRef}`],
    id: randomUUID(),
    message,
    severity,
    status: "open",
  };
}

function unavailable(reason?: string): boolean {
  return reason === "memory_graph_disabled"
    || reason === "memory_graph_unreachable"
    || reason === "network_error";
}

function artifactNodeVersion(nodeId: string, artifactId: string): number | undefined {
  if (nodeId === artifactId) return undefined;
  const prefix = `${artifactId}#v`;
  if (!nodeId.startsWith(prefix)) return undefined;
  const version = Number(nodeId.slice(prefix.length));
  return Number.isInteger(version) && version > 0 ? version : undefined;
}

async function traceWithCancellation(
  trace: TraceArtifactProvenance,
  reference: ArtifactProvenanceReference,
  signal?: AbortSignal,
): Promise<MemoryGraphTraceResult> {
  if (signal?.aborted) throw new DOMException("Review cancelled", "AbortError");
  return new Promise<MemoryGraphTraceResult>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const finishResolve = (result: MemoryGraphTraceResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => finishReject(new DOMException("Review cancelled", "AbortError"));
    timeout = setTimeout(
      () => finishReject(new Error("provenance query timed out")),
      QUICK_PROVENANCE_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", abort, { once: true });
    void trace(reference, signal).then(finishResolve, finishReject);
  });
}

export async function quickComputationReview(
  version: ScientificArtifactVersion,
  trace: TraceArtifactProvenance | undefined,
  signal?: AbortSignal,
): Promise<QuickComputationReviewResult> {
  const reference = artifactProvenanceReference(version);
  if (signal?.aborted) throw new DOMException("Review cancelled", "AbortError");
  if (!trace) {
    return {
      findings: [finding(
        version,
        reference.provenanceRef,
        "COMPUTATION_PROVENANCE_QUERY_FAILED",
        "The Artifact provenance graph is unavailable.",
        "warning",
      )],
      provenanceRef: reference.provenanceRef,
    };
  }

  let result: MemoryGraphTraceResult;
  try {
    result = await traceWithCancellation(trace, reference, signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return {
      findings: [finding(
        version,
        reference.provenanceRef,
        "COMPUTATION_PROVENANCE_QUERY_FAILED",
        `The Artifact provenance query failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      )],
      provenanceRef: reference.provenanceRef,
    };
  }
  if (signal?.aborted) throw new DOMException("Review cancelled", "AbortError");
  if (unavailable(result.reason)) {
    return {
      findings: [finding(
        version,
        reference.provenanceRef,
        "COMPUTATION_PROVENANCE_QUERY_FAILED",
        `The Artifact provenance could not be checked${result.reason ? `: ${result.reason}` : "."}`,
        "warning",
      )],
      provenanceRef: reference.provenanceRef,
    };
  }
  if (!result.startNode) {
    return {
      findings: [finding(
        version,
        reference.provenanceRef,
        "COMPUTATION_PROVENANCE_MARKER_MISSING",
        "The Artifact version has no matching provenance graph node.",
        "critical",
      )],
      provenanceRef: reference.provenanceRef,
    };
  }
  const startId = result.startNode.id;
  const resolvedVersion = artifactNodeVersion(startId, version.artifactId);
  const sameArtifactLineage = startId === version.artifactId || resolvedVersion !== undefined;
  if (result.startNode.label !== "Artifact"
    || !sameArtifactLineage) {
    return {
      findings: [finding(
        version,
        reference.provenanceRef,
        "COMPUTATION_PROVENANCE_MARKER_INVALID",
        "The provenance reference resolved to a different graph node.",
        "critical",
      )],
      provenanceRef: reference.provenanceRef,
    };
  }
  // trace_provenance currently resolves a bare artifact id and can return an
  // older node from the same supersedes lineage. Only compare the locked
  // content hash when the graph actually resolved this exact version; an
  // older same-Artifact node is valid lineage evidence, not a version mismatch.
  const resolvedExactVersion = startId === reference.provenanceRef
    || (startId === version.artifactId && version.version === 1);
  if (resolvedExactVersion
    && result.startNode.contentHash
    && result.startNode.contentHash !== version.content.hash) {
    return {
      findings: [finding(
        version,
        reference.provenanceRef,
        "COMPUTATION_RESULT_VERSION_MISMATCH",
        "The provenance graph points to a different Artifact content version.",
        "critical",
      )],
      provenanceRef: reference.provenanceRef,
    };
  }
  if (result.truncated) {
    return {
      findings: [finding(
        version,
        reference.provenanceRef,
        "COMPUTATION_PROVENANCE_CHAIN_INCOMPLETE",
        `The Artifact provenance chain was truncated before reaching its origin${result.reason ? `: ${result.reason}` : "."}`,
        "warning",
      )],
      provenanceRef: reference.provenanceRef,
    };
  }
  if (result.broken) {
    return {
      findings: [finding(
        version,
        reference.provenanceRef,
        "COMPUTATION_PROVENANCE_CHAIN_INCOMPLETE",
        `The Artifact provenance chain is incomplete${result.reason ? `: ${result.reason}` : "."}`,
        "critical",
      )],
      provenanceRef: reference.provenanceRef,
    };
  }
  return { findings: [], provenanceRef: reference.provenanceRef };
}

function evidenceFinding(
  code: string,
  message: string,
  versionId: string,
  evidenceId?: string,
): ArtifactReviewFinding {
  return {
    code,
    evidenceRefs: [
      `artifact:${versionId}`,
      ...(evidenceId ? [`evidence:${evidenceId}`] : []),
    ],
    id: randomUUID(),
    message,
    severity: "warning",
    status: "open",
  };
}

export function evidenceAliases(content: Buffer): string[] {
  return [...new Set(
    [...content.toString("utf8").matchAll(/\[((?:ev|evidence)\d+)\]/giu)]
      .map((match) => match[1]!.toLowerCase()),
  )];
}

/** Exclude Markdown structure and copied source text before local claim checks. */
function narrativeLines(content: string): string[] {
  const lines: string[] = [];
  let inCodeFence = false;
  let inFrontMatter = false;
  for (const rawLine of content.split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (line === "```") {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (line === "---" && !lines.length) {
      inFrontMatter = !inFrontMatter;
      continue;
    }
    if (!line || inCodeFence || inFrontMatter) continue;
    // Headings and block quotes describe document structure or copied source
    // material; they are not authored numeric assertions in this Artifact.
    if (/^#{1,6}\s/u.test(line) || /^>\s?/u.test(line) || /^\|?\s*:?-{3,}/u.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

/**
 * A numeric statement with an ordinary paper citation still needs an explicit
 * Evidence mapping before Computation can validate its data provenance. This
 * is intentionally a local completeness check: it never asks the model to
 * infer evidence from a bibliography entry.
 */
export function quickNumericEvidenceCoverageReview(
  content: Buffer,
  version: ScientificArtifactVersion,
): ArtifactReviewFinding[] {
  const findings: ArtifactReviewFinding[] = [];
  // A publication year or section number is not a data claim. A bare decimal
  // therefore needs quantitative language; percentages, units and counts are
  // unambiguous enough to stand alone.
  const explicitMeasurement = /\b\d+(?:\.\d+)?\s*(?:%|‰|mg\/?L|ng\/?mL|years?|months?|days?|patients?|cases?)/iu;
  const contextualDecimal = /\b\d+\.\d+\b/iu;
  const quantitativeContext = /\b(?:mean|median|average|rate|frequency|prevalence|incidence|ratio|hazard|odds|fold)\b|(?:均值|中位数|平均|频率|比例|发生率|患病率|风险比|比值|倍)/iu;
  const literatureMarker = /(?:\[(?!(?:ev|evidence)\d+\])\d+(?:\s*[,，]\s*\d+)*\]|【\d+(?:\s*[,，]\s*\d+)*】|\[\^[^\]]+\]|\b[A-Z][A-Za-z'’-]+\s+et al\.,?\s*(?:\(|,)?\s*(?:19|20)\d{2}\b)/u;
  const evidenceMarker = /\[(?:ev|evidence)\d+\]/iu;
  const bibliographyEntry = /^\s*(?:\[\d+\]|\d+[.)、])\s+/u;
  const artifactAliases = new Set(
    (version.references ?? [])
      .filter((reference) => reference.kind === "artifact")
      .map((reference) => reference.label.toLowerCase()),
  );

  for (const line of narrativeLines(content.toString("utf8"))) {
    if (bibliographyEntry.test(line)) continue;
    for (const rawSentence of line.split(/(?<=[.!?。！？])\s+/gu)) {
      const sentence = rawSentence.trim();
      const citation = sentence.match(literatureMarker)?.[0];
      const isNumericClaim = explicitMeasurement.test(sentence)
        || (contextualDecimal.test(sentence) && quantitativeContext.test(sentence));
      if (evidenceMarker.test(sentence) || !isNumericClaim) continue;
      const aliases = [...sentence.matchAll(/\[([a-z][\w-]*)\]/giu)]
        .map((match) => match[1]!.toLowerCase());
      if (aliases.some((alias) => artifactAliases.has(alias))) continue;
      const unresolvedArtifactAlias = aliases.find((alias) => /^artifact\d*$/iu.test(alias));
      if (unresolvedArtifactAlias) {
        findings.push(evidenceFinding(
          "COMPUTATION_NUMERIC_CLAIM_PROVENANCE_UNRESOLVED",
          `Numeric claim ${JSON.stringify(sentence.slice(0, 500))} cites [${unresolvedArtifactAlias}], but this Artifact version has no matching generated-data reference. Link the claim to the produced Artifact before treating the value as traceable.`,
          version.id,
        ));
        continue;
      }
      findings.push(evidenceFinding(
        citation ? "COMPUTATION_NUMERIC_CLAIM_EVIDENCE_MISSING" : "COMPUTATION_NUMERIC_CLAIM_UNSUPPORTED",
        citation
          ? `Numeric claim ${JSON.stringify(sentence.slice(0, 500))} cites ${citation} but has no [evidenceN] Evidence or [artifactN] Artifact mapping. Add a version-linked Evidence reference (for a literature source) or an Artifact reference (for a generated-data file) via declare_claim so its data provenance can be checked.`
          : `Numeric claim ${JSON.stringify(sentence.slice(0, 500))} has no literature citation, [evidenceN] Evidence mapping, or [artifactN] generated-data Artifact. Add a traceable source via declare_claim before treating the value as supported.`,
        version.id,
      ));
    }
  }
  return findings;
}

/** Quick graph-integrity check for report Evidence chips; no semantic judgment. */
export async function quickEvidenceReferenceReview(
  content: Buffer,
  version: ScientificArtifactVersion,
  traceEvidenceReference?: TraceEvidenceReference,
  signal?: AbortSignal,
): Promise<{ findings: ArtifactReviewFinding[]; evidenceIds: string[] }> {
  const aliases = evidenceAliases(content);
  if (!aliases.length) return { evidenceIds: [], findings: [] };
  const references = new Map(
    (version.references ?? []).map((reference) => [reference.label.toLowerCase(), reference]),
  );
  const findings: ArtifactReviewFinding[] = [];
  const evidenceIds: string[] = [];

  for (const alias of aliases) {
    if (signal?.aborted) throw new DOMException("Review cancelled", "AbortError");
    const reference = references.get(alias);
    if (!reference || reference.kind !== "evidence") {
      findings.push(evidenceFinding(
        "CITATION_EVIDENCE_ALIAS_UNRESOLVED",
        `Evidence marker [${alias}] has no matching Evidence reference on this Artifact version.`,
        version.id,
      ));
      continue;
    }
    evidenceIds.push(reference.id);
    if (!traceEvidenceReference) {
      findings.push(evidenceFinding(
        "CITATION_EVIDENCE_QUERY_FAILED",
        `Evidence marker [${alias}] could not be checked because the graph query is unavailable.`,
        version.id,
        reference.id,
      ));
      continue;
    }
    let trace: EvidenceReferenceTraceResult;
    try {
      trace = await traceEvidenceReference({ alias, evidenceId: reference.id }, signal);
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      findings.push(evidenceFinding(
        "CITATION_EVIDENCE_QUERY_FAILED",
        `Evidence marker [${alias}] could not be checked: ${error instanceof Error ? error.message : "graph query failed"}.`,
        version.id,
        reference.id,
      ));
      continue;
    }
    if (trace.reason || trace.truncated) {
      findings.push(evidenceFinding(
        "CITATION_EVIDENCE_QUERY_FAILED",
        `Evidence marker [${alias}] could not be checked reliably: ${trace.reason ?? "graph result was truncated"}.`,
        version.id,
        reference.id,
      ));
    } else if (!trace.evidenceFound) {
      findings.push(evidenceFinding(
        "CITATION_EVIDENCE_NODE_MISSING",
        `Evidence marker [${alias}] points to an Evidence node that does not exist.`,
        version.id,
        reference.id,
      ));
    } else if (!trace.paperLinked) {
      findings.push(evidenceFinding(
        "CITATION_EVIDENCE_CHAIN_BROKEN",
        `Evidence marker [${alias}] does not have an extracted_from link to a Paper node.`,
        version.id,
        reference.id,
      ));
    }
  }

  return { evidenceIds: [...new Set(evidenceIds)], findings };
}

export function createEvidenceReferenceTracer(
  memoryGraphClient: MemoryGraphClient | null | undefined,
  sessionId: string,
  /** Live toggle check; returns disabled when off. Defaults to "on" so the
   *  contract holds for callers that haven't been wired to the store toggle. */
  isEnabled: () => boolean = () => true,
): TraceEvidenceReference {
  let extractedFromQuery: ReturnType<MemoryGraphClient["byEdgeType"]> | undefined;
  return async ({ evidenceId }, signal) => {
    if (signal?.aborted) throw new DOMException("Review cancelled", "AbortError");
    if (!memoryGraphClient || !isEnabled()) {
      return { evidenceFound: false, paperLinked: false, reason: "memory_graph_disabled" };
    }
    let evidence;
    try {
      evidence = await memoryGraphClient.getNode("Evidence", evidenceId);
    } catch {
      return { evidenceFound: false, paperLinked: false, reason: "memory_graph_unreachable" };
    }
    if (!evidence) return { evidenceFound: false, paperLinked: false };
    try {
      extractedFromQuery ??= memoryGraphClient.byEdgeType(["extracted_from"], sessionId);
      const graph = await extractedFromQuery;
      if (graph.reason) {
        return { evidenceFound: true, paperLinked: false, reason: graph.reason, truncated: graph.truncated };
      }
      const linkedPaperId = graph.edges.find((edge) =>
        edge.type === "extracted_from"
        && edge.source === evidenceId
        && graph.nodes.some((node) => node.label === "Paper" && node.id === edge.target))?.target;
      const paper = linkedPaperId
        ? graph.nodes.find((node) => node.label === "Paper" && node.id === linkedPaperId)
        : undefined;
      const evidenceExtra = evidence.extra ?? {};
      const paperExtra = paper?.extra ?? {};
      const authors = Array.isArray(paperExtra?.authors)
        ? paperExtra.authors.filter((author): author is string => typeof author === "string")
        : undefined;
      return {
        evidence: {
          ...(typeof evidenceExtra.content === "string" ? { content: evidenceExtra.content } : {}),
          ...(typeof evidenceExtra.evidence_type === "string" ? { evidenceType: evidenceExtra.evidence_type } : {}),
          ...(typeof evidenceExtra.locator === "string" ? { locator: evidenceExtra.locator } : {}),
          ...(typeof evidenceExtra.strength === "string" ? { strength: evidenceExtra.strength } : {}),
        },
        evidenceFound: true,
        ...(paper ? {
          paper: {
            ...(typeof paperExtra.abstract === "string" ? { abstract: paperExtra.abstract } : {}),
            ...(authors ? { authors } : {}),
            ...(typeof paperExtra.identifier === "string" ? { identifier: paperExtra.identifier } : {}),
            ...(typeof paperExtra.identifierType === "string"
              ? { identifierType: paperExtra.identifierType }
              : typeof paperExtra.identifier_type === "string" ? { identifierType: paperExtra.identifier_type } : {}),
            ...(typeof paperExtra.link === "string" ? { link: paperExtra.link } : {}),
            ...(typeof paperExtra.source === "string" ? { source: paperExtra.source } : {}),
            ...(typeof paperExtra.title === "string" ? { title: paperExtra.title } : {}),
            ...(typeof paperExtra.year === "string" || typeof paperExtra.year === "number"
              ? { year: String(paperExtra.year) }
              : {}),
          },
        } : {}),
        paperLinked: Boolean(paper),
        truncated: graph.truncated,
      };
    } catch {
      return { evidenceFound: true, paperLinked: false, reason: "memory_graph_unreachable" };
    }
  };
}

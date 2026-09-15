// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { CasStore } from "@sciencediscovery/cas";
import type { ExecutionRun, ScientificArtifactVersion } from "@sciencediscovery/schema";
import type { ComputationSourceProbe, QuantitativeArtifactClaim } from "@sciencediscovery/provenance";

import type { SessionStore } from "../store.js";

const MAX_SOURCE_CHARACTERS = 4_000;
const MAX_ARTIFACT_CHARACTERS = 128_000;

/**
 * Read-only bridge from a report's declared Artifact chip to the immutable
 * generated data and ExecutionRun that produced it. It deliberately refuses
 * unpinned versions, failed executions, mutable workspace files, and any
 * attempt to execute or re-run code.
 */
export class ReviewerComputationEvidenceGateway {
  constructor(
    private readonly store: Pick<SessionStore, "getArtifact" | "getArtifactVersion" | "listArtifactVersions" | "listExecutionRuns">,
    private readonly cas: Pick<CasStore, "read" | "verify">,
  ) {}

  async resolve(sessionId: string, claim: QuantitativeArtifactClaim): Promise<ComputationSourceProbe> {
    const version = this.resolveVersion(sessionId, claim);
    if (!version) return { message: "The generated Artifact reference is not available in this Session.", status: "unavailable" };
    const runs = (await this.store.listExecutionRuns(sessionId))
      .filter((run) => run.sessionId === sessionId && run.status === "succeeded" && version.executionRunIds.includes(run.id));
    if (!runs.length) return { message: "The referenced Artifact has no successful recorded ExecutionRun.", status: "unavailable" };
    const run = runs.toSorted((left, right) => right.finishedAt.localeCompare(left.finishedAt))[0]!;
    try {
      const [artifactContent, code, stdout] = await Promise.all([
        this.readLocked(version.content, MAX_ARTIFACT_CHARACTERS),
        this.readLocked(run.code),
        this.readLocked(run.stdout),
      ]);
      if (!artifactContent || !code || !stdout) {
        return { message: "The referenced Artifact's data, code, or execution output is not readable from the recorded CAS snapshot.", status: "unavailable" };
      }
      const dataFields = locateClaimValues(artifactContent, version.mediaType, claim.values, run.id, version.sourcePath);
      if (!dataFields) {
        return { message: "The report's numeric values could not be located exactly in the locked generated Artifact.", status: "unavailable" };
      }
      const sourceId = `artifact-version:${version.id}`;
      return {
        materials: [
          ...dataFields.map((item) => ({ ...item, sourceId, sourceType: "artifact" as const })),
          { content: code, locator: { executionId: run.id, field: "source_code" }, sourceId: `execution:${run.id}`, sourceType: "code" },
          { content: stdout, locator: { executionId: run.id, field: "stdout" }, sourceId: `execution:${run.id}`, sourceType: "execution" },
        ],
        status: "available",
      };
    } catch {
      return { message: "The recorded computation evidence could not be read.", status: "unavailable" };
    }
  }

  private resolveVersion(sessionId: string, claim: QuantitativeArtifactClaim): ScientificArtifactVersion | undefined {
    // A strong E4 verdict cannot silently follow an unpinned chip to a newer
    // Artifact version. Older links remain reviewable only as INCONCLUSIVE.
    if (claim.artifactVersion === undefined) return undefined;
    const artifact = this.store.getArtifact(sessionId, claim.artifactId);
    if (!artifact || artifact.createdInSessionId !== sessionId) return undefined;
    const candidates = this.store.listArtifactVersions(sessionId, claim.artifactId)
      .filter((version) => version.sessionId === sessionId)
      .filter((version) => version.version === claim.artifactVersion)
      .toSorted((left, right) => right.version - left.version);
    return candidates[0];
  }

  private async readLocked(reference: { hash: string; size: number }, maximum = MAX_SOURCE_CHARACTERS): Promise<string | undefined> {
    if (!await this.cas.verify(reference.hash)) return undefined;
    const content = await this.cas.read(reference.hash);
    if (content.length !== reference.size) return undefined;
    return content.toString("utf8").slice(0, maximum).trim() || undefined;
  }
}

function locateClaimValues(
  content: string,
  mediaType: string,
  values: string[],
  executionId: string,
  outputPath: string | undefined,
): Array<{ content: string; locator: { column?: string; executionId: string; field?: string; line?: number; outputPath?: string; row?: string; table?: string } }> | undefined {
  const normalizedType = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (normalizedType === "application/json" || normalizedType?.endsWith("+json")) {
    try {
      const fields = jsonFields(JSON.parse(content));
      return locateValues(values, fields.map((field) => ({
        content: `${field.path}: ${field.value}`,
        locator: { executionId, field: field.path, ...(outputPath ? { outputPath } : {}) },
        value: field.value,
      })));
    } catch { return undefined; }
  }
  if (normalizedType === "text/csv" || normalizedType === "text/tab-separated-values") {
    const delimiter = normalizedType === "text/tab-separated-values" ? "\t" : ",";
    const rows = content.split(/\r?\n/u).filter(Boolean).map((line) => line.split(delimiter).map((cell) => cell.trim()));
    const headers = rows[0] ?? [];
    const fields = rows.slice(1).flatMap((row, rowIndex) => row.map((value, columnIndex) => ({
      content: `${headers[columnIndex] ?? `column-${columnIndex + 1}`} (row ${rowIndex + 2}): ${value}`,
      locator: { column: headers[columnIndex] ?? `column-${columnIndex + 1}`, executionId, ...(outputPath ? { outputPath } : {}), row: String(rowIndex + 2), table: "data" },
      value,
    })));
    return locateValues(values, fields);
  }
  const fields = content.split(/\r?\n/u).map((line, index) => ({
    content: line,
    locator: { executionId, field: "text", line: index + 1, ...(outputPath ? { outputPath } : {}) },
    value: line,
  }));
  return locateValues(values, fields);
}

function locateValues<T extends { content: string; locator: object; value: string }>(
  values: string[],
  fields: T[],
): Array<Pick<T, "content" | "locator">> | undefined {
  const matches = values.map((value) => fields.find((field) => valueMatches(field.value, value)));
  if (matches.some((match) => !match)) return undefined;
  return [...new Map(matches.map((match) => [JSON.stringify(match!.locator), match!])).values()]
    .map(({ content, locator }) => ({ content, locator }));
}

/**
 * Exact text remains the default. The only non-text equivalence accepted here
 * is a unit-safe percent fraction (42% === 0.42); values with other or
 * incompatible units deliberately remain unmatched instead of being guessed.
 */
function valueMatches(source: string, claim: string): boolean {
  if (source.includes(claim)) return true;
  const sourcePercent = parsePercent(source);
  const claimPercent = parsePercent(claim);
  return sourcePercent !== undefined && claimPercent !== undefined
    && Math.abs(sourcePercent - claimPercent) < 1e-12;
}

function parsePercent(value: string): number | undefined {
  const text = value.trim();
  const percent = text.match(/^(-?\d+(?:\.\d+)?)\s*%$/u);
  if (percent) return Number(percent[1]) / 100;
  // Bare fractions are accepted only when they are a single scalar in [0, 1].
  // This prevents values such as 42 mg/L or n=42 from being conflated with 42%.
  const fraction = text.match(/^(-?\d+(?:\.\d+)?)$/u);
  if (!fraction) return undefined;
  const numeric = Number(fraction[1]);
  return numeric >= 0 && numeric <= 1 ? numeric : undefined;
}

function jsonFields(value: unknown, path = "$"): Array<{ path: string; value: string }> {
  if (Array.isArray(value)) return value.flatMap((item, index) => jsonFields(item, `${path}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value)
    .flatMap(([key, item]) => jsonFields(item, `${path}.${key}`));
  return value === null || value === undefined ? [] : [{ path, value: String(value) }];
}

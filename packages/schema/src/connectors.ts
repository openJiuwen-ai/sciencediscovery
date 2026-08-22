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

import { formatExternalUrl } from "@sciencediscovery/external-urls";

import type { CasObjectRef } from "./provenance.js";

export type ConnectorId = string;
/** Citation token prefixes (built-ins + extensions). */

export type EvidenceCitationType = string;

export type EvidenceIdentifierType = string;

export type EvidenceContentScope = "abstract" | "curated-record" | "metadata";

/** Built-in citation map; extensions may omit an entry if records set `citation` themselves. */

export const CONNECTOR_CITATION_TYPES: Record<string, EvidenceCitationType> = {
  arxiv: "arXiv",
  "europe-pmc": "EuropePMC",
  pubmed: "PMID",
  uniprot: "UniProt",
};

export interface ConnectorManifest {
  attributionTemplate: string;
  cacheTtlSeconds: number;
  citationTemplate: string;
  codeHash: string;
  commercialUseConstraints: string;
  dataClassification: "public" | string;
  enabledByDefault: boolean;
  id: ConnectorId;
  inputSchemaVersion: string;
  license: string;
  maxResponseBytes: number;
  networkHosts: string[];
  publisher: string;
  /** Optional compatibility projection; omitted means no rate pacing is configured. */
  rateLimitPerSecond?: number;
  redirectPolicy: "deny" | string;
  requestedCapabilities: string[];
  requestedSecrets: string[];
  schemaVersion: string;
  signature: string | null;
  termsUrl: string;
  trustLevel: "bundled" | "extension" | string;
  version: string;
}

export interface ConnectorRecord {
  abstract?: string;
  authors: string[];
  citation: string;
  /** The strongest content actually returned by this connector search. */
  contentScope: EvidenceContentScope;
  /** Search never implies that a separately available PDF was retrieved. */
  fullTextRetrieved: false;
  identifier: string;
  identifierType: EvidenceIdentifierType;
  metadata: Record<string, string>;
  pdfAvailable?: boolean;
  source: ConnectorId;
  title: string;
  url: string;
  year?: string;
}

/** Returns the canonical, clickable Markdown citation supplied to the agent. */

export function formatConnectorCitation(record: Pick<ConnectorRecord, "identifier" | "source" | "url">): string {
  const type = CONNECTOR_CITATION_TYPES[record.source] ?? record.source;
  return `[${type}:${record.identifier}](${record.url})`;
}

/** Normalizes a no-space citation type without regard to letter case. */

export function normalizeEvidenceCitationType(type: string): EvidenceCitationType | undefined {
  return ({
    arxiv: "arXiv",
    europepmc: "EuropePMC",
    pmid: "PMID",
    uniprot: "UniProt",
  } as Record<string, EvidenceCitationType>)[type.toLowerCase()];
}

/** Resolves a canonical citation token when rendering older or plain-text responses. */

export function evidenceCitationUrl(type: string, identifier: string): string | undefined {
  const normalizedType = normalizeEvidenceCitationType(type);
  if (normalizedType === "arXiv" && /^(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?$/i.test(identifier)) {
    return formatExternalUrl("data_sources.arxiv.article_template", { identifier });
  }
  if (normalizedType === "PMID" && /^\d{1,9}$/.test(identifier)) {
    return formatExternalUrl("data_sources.ncbi.pubmed_article_template", { pmid: identifier });
  }
  if (normalizedType === "EuropePMC" && /^[A-Za-z0-9._:-]{1,80}$/.test(identifier)) {
    if (/^PMC\d{1,12}$/i.test(identifier)) {
      return formatExternalUrl("data_sources.europe_pmc.pmc_article_template", { identifier: identifier.toUpperCase() });
    }
    if (/^\d{1,9}$/.test(identifier)) {
      return formatExternalUrl("data_sources.europe_pmc.article_template", { identifier, source: "MED" });
    }
    return formatExternalUrl("data_sources.europe_pmc.search_template", { identifier: encodeURIComponent(identifier) });
  }
  if (normalizedType === "UniProt" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(identifier)) {
    return formatExternalUrl("data_sources.uniprot.entry_template", { accession: encodeURIComponent(identifier) });
  }
  return undefined;
}

export interface ConnectorResult {
  attribution: string;
  connectorId: ConnectorId;
  records: ConnectorRecord[];
  retrievedAt: string;
  sourceVersion?: string;
  untrusted: true;
}

export interface ConnectorInvocation {
  cacheHit: boolean;
  connectorCodeHash: string;
  connectorId: ConnectorId;
  connectorVersion: string;
  error?: string;
  finishedAt: string;
  host: string;
  id: string;
  license: string;
  normalizedResult?: CasObjectRef;
  querySummary: string;
  request: CasObjectRef;
  response: CasObjectRef;
  resultCount: number;
  retrievedAt?: string;
  sessionId: string;
  sourceVersion?: string;
  startedAt: string;
  status: "failed" | "succeeded";
  turnId: string;
}

export interface InvokeConnectorRequest {
  limit?: number;
  query: string;
}

/** Science source id that can download a paper PDF (subset of ConnectorId). */

export interface UpdateConnectorsRequest {
  enabledConnectorIds: ConnectorId[];
}

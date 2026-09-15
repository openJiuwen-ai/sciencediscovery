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

import { CasStore } from "@sciencediscovery/cas";
import type { PaperAcquisition } from "@sciencediscovery/schema";
import type { CitationSourceMaterial, LiteratureCitationCandidate } from "@sciencediscovery/provenance";

import type { SessionStore } from "../store.js";

const MAX_FULLTEXT_CHARACTERS = 4_000;
const MAX_TABLES_PER_PAPER = 3;
const MAX_TABLE_CELLS_PER_PAPER = 32;

/**
 * Read-only bridge from a Paper Reader acquisition to Reviewer source facts.
 * It never opens the mutable workspace: every excerpt is read back through the
 * recorded data-CAS hash of the same Session's extracted file.
 */
export class ReviewerPaperEvidenceGateway {
  private readonly dataCas: CasStore;

  constructor(private readonly store: Pick<SessionStore,
    "dataDir" | "getWorkspaceFileProvenance" | "listPaperAcquisitions">) {
    this.dataCas = new CasStore(store.dataDir, "data");
  }

  async resolveCitation(sessionId: string, candidate: LiteratureCitationCandidate): Promise<CitationSourceMaterial[]> {
    const acquisitions = await this.store.listPaperAcquisitions(sessionId);
    const paper = acquisitions.find((item) => item.sessionId === sessionId && matchesCandidate(item, candidate));
    if (!paper) return [];
    const analysisRoot = paper.manifestPath.slice(0, paper.manifestPath.lastIndexOf("/"));
    const materials: CitationSourceMaterial[] = [];
    const fulltext = await this.readRecordedFile(sessionId, `${analysisRoot}/${paper.extraction.textPath}`, paper.id);
    if (fulltext) {
      materials.push({
        content: fulltext.slice(0, MAX_FULLTEXT_CHARACTERS),
        evidenceLevel: "E2",
        locator: { field: "extracted_fulltext" },
        sourceId: candidate.key,
        sourceType: "paper_fulltext",
      });
    }
    let issuedCells = 0;
    for (const [index, table] of paper.extraction.tables.slice(0, MAX_TABLES_PER_PAPER).entries()) {
      const csv = await this.readRecordedFile(sessionId, `${analysisRoot}/${table.csvPath}`, paper.id);
      if (!csv) continue;
      const [headers = [], ...rows] = parseCsv(csv);
      for (const [rowIndex, row] of rows.entries()) {
        for (const [columnIndex, value] of row.entries()) {
          if (issuedCells >= MAX_TABLE_CELLS_PER_PAPER) return materials;
          const column = headers[columnIndex]?.trim();
          const cell = value.trim();
          if (!column || !cell) continue;
          materials.push({
            content: `Table ${index + 1}; row ${rowIndex + 2}; ${column}: ${cell}`,
            evidenceLevel: "E3",
            locator: { column, page: table.page, row: String(rowIndex + 2), table: `table-${index + 1}` },
            sourceId: candidate.key,
            sourceType: "table",
          });
          issuedCells += 1;
        }
      }
    }
    return materials;
  }

  private async readRecordedFile(sessionId: string, path: string, paperId: string): Promise<string | undefined> {
    const provenance = this.store.getWorkspaceFileProvenance(sessionId, path);
    const revision = provenance?.currentRevision;
    // A later user edit replaces the revision and intentionally makes it
    // ineligible. Reviewer must not silently read a mutable replacement.
    if (!revision?.contentHash || revision.originMeta?.paperId !== paperId) return undefined;
    try {
      return (await this.dataCas.read(revision.contentHash)).toString("utf8");
    } catch {
      return undefined;
    }
  }
}

/** Bounded CSV decoding for Paper Reader's already-extracted tabular output. */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [[]];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '"') {
      if (quoted && input[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      rows.at(-1)!.push(cell); cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      rows.at(-1)!.push(cell); cell = "";
      if (rows.at(-1)!.some((value) => value.length)) rows.push([]);
    } else cell += character;
  }
  if (cell || rows.at(-1)!.length) rows.at(-1)!.push(cell);
  return rows.filter((row) => row.some((value) => value.trim()));
}

function matchesCandidate(paper: PaperAcquisition, candidate: LiteratureCitationCandidate): boolean {
  const normalized = normalizeIdentifier(paper.identifier);
  const key = normalizeIdentifier(candidate.key);
  if (normalized === key) return true;
  const url = paper.sourceUrl ? normalizeIdentifier(paper.sourceUrl) : "";
  return Boolean(url && (url.includes(candidate.key.toLowerCase()) || key.includes(url)));
}

function normalizeIdentifier(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^https?:\/\/(?:www\.)?/u, "");
  const pmid = normalized.match(/(?:pubmed\.ncbi\.nlm\.nih\.gov\/|\bpmid:?)?(\d{4,9})\/?$/u);
  if (pmid && (normalized.startsWith("pmid") || normalized.includes("pubmed"))) return `pmid:${pmid[1]}`;
  const pmcid = normalized.match(/(?:pmcid:?)?(pmc\d{4,10})\b/u);
  if (pmcid) return `pmcid:${pmcid[1]}`;
  const doi = normalized.match(/(?:doi\.org\/|doi:)?(10\.\d{4,9}\/[\w.()\-;/]+)/u);
  if (doi) return `doi:${doi[1]}`;
  return normalized.replace(/\/$/u, "");
}

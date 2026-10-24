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

import {
  DEFAULT_MCP_RATE_LIMIT_QUEUE,
  externalUrl,
  externalUrlList,
  type JsonValue,
  type McpRawResult,
  type McpSourceAdapter,
  type McpSourceKind,
  type McpSourceManifest,
  type McpToolKind,
  type McpToolResult,
  type ValidationIssue,
  type ValidationResult,
} from "@sciencediscovery/schema";

interface ToolDefinition {
  description: string;
  inputSchema: Record<string, unknown>;
  kind?: McpToolKind;
  keywords: string[];
  priority?: number;
  timeoutMs?: number;
  resultType?: "analysis-result" | "artifact-plan" | "evidence-records" | "structured-data";
}

interface SourceDefinition {
  attribution: string;
  caveats: string[];
  description: string;
  displayName: string;
  hosts: string[];
  id: string;
  kinds: McpSourceKind[];
  license: string;
  publisher: string;
  /** Overrides for providers whose terms are stricter than the shared defaults. */
  rateLimit?: {
    maxConcurrentRequests?: number;
    minIntervalMs?: number;
    retryInitialDelayMs?: number;
  };
  termsUrl: string;
  tools: Record<string, ToolDefinition>;
}

const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({
  additionalProperties: false,
  properties,
  required,
  type: "object",
});
const text = (maxLength = 500) => ({ maxLength, minLength: 1, type: "string" });
const limit = { default: 5, maximum: 25, minimum: 1, type: "integer" };
const offset = { default: 0, minimum: 0, type: "integer" };
const accession = (pattern: string) => ({ maxLength: 80, minLength: 1, pattern, type: "string" });
const uniprotAccession = accession("^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-[0-9]+)?$");
const clinvarAccession = accession("^(?:(?:VCV|RCV)\\d{9}(?:\\.\\d+)?|\\d+)$");

const preprintTools: Record<string, ToolDefinition> = {
  lookup_doi: {
    description: "Look up one preprint DOI and preserve its version and publication status.",
    inputSchema: objectSchema({ doi: accession("^10\\.1101/.+$") }, ["doi"]),
    keywords: ["preprint DOI", "bioRxiv DOI", "medRxiv DOI"],
    priority: 90,
  },
  prepare_paper_download: {
    description: "Resolve the latest available preprint version and prepare its PDF as a governed download candidate.",
    inputSchema: objectSchema({
      doi: accession("^10\\.1101/.+$"),
      version: { maximum: 100, minimum: 1, type: "integer" },
    }, ["doi"]),
    keywords: ["download preprint", "paper PDF", "full text"],
    kind: "artifact-plan",
    priority: 98,
    resultType: "artifact-plan",
  },
  search_preprints: {
    description: "Search recent preprints by text, optional subject category, and recent-day window.",
    inputSchema: objectSchema({
      category: { maxLength: 100, minLength: 1, type: "string" },
      days: { default: 30, maximum: 365, minimum: 1, type: "integer" },
      limit,
      query: text(),
    }, ["query"]),
    keywords: ["preprint", "recent manuscript", "not peer reviewed"],
    priority: 85,
  },
};

export const PUBLIC_BIOMED_SOURCE_DEFINITIONS: SourceDefinition[] = [
  {
    attribution: "arXiv metadata and open e-prints provided by Cornell University.",
    caveats: ["Preserve the arXiv identifier and version; an available PDF has not been read until paper_extract_pdf succeeds."],
    description: "Scientific preprints and e-prints from arXiv.",
    displayName: "arXiv",
    hosts: [...externalUrlList("connector_hosts.arxiv")],
    id: "arxiv",
    kinds: ["literature"],
    license: "Per-record arXiv submission license; metadata subject to arXiv API terms",
    publisher: "Cornell University arXiv",
    // arXiv API terms of use: at most one request every three seconds, single connection.
    rateLimit: { maxConcurrentRequests: 1, minIntervalMs: 3_000, retryInitialDelayMs: 3_000 },
    termsUrl: externalUrl("terms.arxiv"),
    tools: {
      prepare_paper_download: {
        description: "Prepare an arXiv PDF as a governed download candidate.",
        inputSchema: objectSchema({ identifier: accession("^(?:\\d{4}\\.\\d{4,5}|[A-Za-z.-]+/\\d{7})(?:v\\d+)?$") }, ["identifier"]),
        keywords: ["download arXiv", "arXiv PDF", "full text"],
        kind: "artifact-plan",
        priority: 98,
        resultType: "artifact-plan",
      },
      search: {
        description: "Search arXiv metadata and abstracts.",
        inputSchema: objectSchema({ limit, query: text() }, ["query"]),
        keywords: ["arXiv", "preprint", "e-print"],
        priority: 90,
      },
    },
  },
  {
    attribution: "PubMed data provided by the U.S. National Library of Medicine.",
    caveats: ["PubMed search returns metadata or abstracts, not article full text. PDF candidates are limited to linked open-access PMC records."],
    description: "Biomedical literature metadata and abstracts from PubMed.",
    displayName: "PubMed",
    hosts: [...externalUrlList("connector_hosts.pubmed")],
    id: "pubmed",
    kinds: ["literature"],
    license: "NCBI/NLM data usage policies; article abstracts may have third-party copyright",
    publisher: "U.S. National Library of Medicine",
    termsUrl: externalUrl("terms.ncbi"),
    tools: {
      prepare_paper_download: {
        description: "Resolve the linked PubMed Central open-access PDF for a PMID.",
        inputSchema: objectSchema({ identifier: accession("^\\d{1,9}$") }, ["identifier"]),
        keywords: ["download PubMed", "PMID PDF", "PMC full text"],
        kind: "artifact-plan",
        priority: 98,
        resultType: "artifact-plan",
      },
      search: {
        description: "Search PubMed metadata and abstracts.",
        inputSchema: objectSchema({ limit, query: text() }, ["query"]),
        keywords: ["PubMed", "PMID", "biomedical literature"],
        priority: 95,
      },
    },
  },
  {
    attribution: "Publication metadata provided by Europe PMC, an EMBL-EBI service.",
    caveats: ["PDF candidates are limited to open-access PMCID records and retain the per-article license."],
    description: "Biomedical literature, citations, and open-access records from Europe PMC.",
    displayName: "Europe PMC",
    hosts: [...externalUrlList("connector_hosts.europe_pmc")],
    id: "europe-pmc",
    kinds: ["literature"],
    license: "Europe PMC terms and per-article open-access license",
    publisher: "Europe PMC / EMBL-EBI",
    termsUrl: externalUrl("terms.europe_pmc"),
    tools: {
      prepare_paper_download: {
        description: "Resolve an open-access PMC PDF for a PMCID.",
        inputSchema: objectSchema({ identifier: accession("^PMC\\d{1,12}$") }, ["identifier"]),
        keywords: ["download Europe PMC", "PMCID PDF", "open access full text"],
        kind: "artifact-plan",
        priority: 98,
        resultType: "artifact-plan",
      },
      search: {
        description: "Search Europe PMC core metadata and abstracts.",
        inputSchema: objectSchema({ limit, query: text() }, ["query"]),
        keywords: ["Europe PMC", "PMCID", "open access literature"],
        priority: 93,
      },
    },
  },
  {
    attribution: "Preprint metadata provided by Cold Spring Harbor Laboratory.",
    caveats: ["Preprints are not peer reviewed; preserve server, version, date, and published DOI when present."],
    description: "Life-science preprints from bioRxiv.",
    displayName: "bioRxiv",
    hosts: [...externalUrlList("connector_hosts.biorxiv")],
    id: "biorxiv",
    kinds: ["literature"],
    license: "bioRxiv API terms",
    publisher: "Cold Spring Harbor Laboratory",
    termsUrl: externalUrl("terms.biorxiv"),
    tools: preprintTools,
  },
  {
    attribution: "Preprint metadata provided by medRxiv and Cold Spring Harbor Laboratory.",
    caveats: ["Medical preprints are preliminary and not peer reviewed; do not use them as clinical guidance."],
    description: "Health-science preprints from medRxiv.",
    displayName: "medRxiv",
    hosts: [...externalUrlList("connector_hosts.medrxiv")],
    id: "medrxiv",
    kinds: ["literature"],
    license: "medRxiv API terms",
    publisher: "medRxiv",
    termsUrl: externalUrl("terms.medrxiv"),
    tools: preprintTools,
  },
  {
    attribution: "Structure data provided by the RCSB Protein Data Bank.",
    caveats: ["Report experimental method, resolution when available, polymer entities, ligands, and release date."],
    description: "Macromolecular structures and metadata from the Protein Data Bank.",
    displayName: "PDB",
    hosts: [...externalUrlList("connector_hosts.rcsb")],
    id: "pdb",
    kinds: ["structure"],
    license: "RCSB PDB data usage policy",
    publisher: "RCSB PDB",
    termsUrl: externalUrl("terms.rcsb"),
    tools: {
      lookup_structure: {
        description: "Look up one four-character PDB entry.",
        inputSchema: objectSchema({ pdb_id: accession("^[A-Za-z0-9]{4}$") }, ["pdb_id"]),
        keywords: ["PDB ID", "structure entry"],
        priority: 95,
      },
      prepare_structure_download: {
        description: "Prepare an mmCIF or PDB structure-file download candidate.",
        inputSchema: objectSchema({
          format: { default: "cif", enum: ["cif", "pdb"], type: "string" },
          pdb_id: accession("^[A-Za-z0-9]{4}$"),
        }, ["pdb_id"]),
        keywords: ["download structure", "mmCIF", "PDB file"],
        kind: "artifact-plan",
        priority: 92,
        resultType: "artifact-plan",
      },
      search_structures: {
        description: "Full-text search across released PDB structure metadata.",
        inputSchema: objectSchema({ limit, offset, query: text() }, ["query"]),
        keywords: ["protein structure", "crystal structure", "PDB", "ligand structure"],
        priority: 90,
      },
    },
  },
  {
    attribution: "Predictions provided by AlphaFold DB (Google DeepMind and EMBL-EBI).",
    caveats: ["Existing predicted structures, not experimental evidence or new prediction jobs. Preserve model versions and interpret pLDDT and PAE separately. A candidate is not downloaded until its ArtifactJob completes."],
    description: "Existing predicted protein structures and confidence files from AlphaFold DB, addressed by UniProt accession.",
    displayName: "AlphaFold DB",
    hosts: [...externalUrlList("connector_hosts.alphafold")],
    id: "alphafold",
    kinds: ["structure", "protein"],
    license: "CC BY 4.0",
    publisher: "Google DeepMind / EMBL-EBI",
    termsUrl: externalUrl("terms.alphafold"),
    tools: {
      lookup_prediction: {
        description: "Retrieve existing AlphaFold models and confidence metadata by UniProt accession; does not run prediction.",
        inputSchema: objectSchema({ accession: uniprotAccession }, ["accession"]),
        keywords: ["AlphaFold", "predicted structure", "pLDDT", "PAE", "UniProt structure"],
        priority: 95,
      },
      prepare_prediction_download: {
        description: "Prepare an existing model (CIF/PDB), pLDDT or PAE JSON file for governed download; select model_id for a particular fragment.",
        inputSchema: objectSchema({
          accession: uniprotAccession,
          format: { default: "cif", enum: ["cif", "pdb", "plddt", "pae"], type: "string" },
          model_id: text(100),
        }, ["accession"]),
        keywords: ["download AlphaFold", "confidence file", "predicted model"],
        kind: "artifact-plan",
        priority: 92,
        resultType: "artifact-plan",
      },
    },
  },
  {
    attribution: "Genome annotations provided by Ensembl.",
    caveats: ["Preserve species, assembly name, stable ID version, coordinates, strand, and transcript consequence scope."],
    description: "Genes, transcripts, genomic overlap, and variant consequences from Ensembl.",
    displayName: "Ensembl",
    hosts: [...externalUrlList("connector_hosts.ensembl")],
    id: "ensembl",
    kinds: ["genomics", "variation"],
    license: "Ensembl data usage policy",
    publisher: "Ensembl",
    termsUrl: externalUrl("terms.ensembl"),
    tools: {
      lookup_gene: {
        description: "Look up an Ensembl gene stable ID.",
        inputSchema: objectSchema({ id: accession("^ENS[A-Z]*G\\d+(?:\\.\\d+)?$"), species: { default: "human", type: "string" } }, ["id"]),
        keywords: ["Ensembl gene", "gene stable ID"],
      },
      lookup_transcript: {
        description: "Look up an Ensembl transcript stable ID.",
        inputSchema: objectSchema({ id: accession("^ENS[A-Z]*T\\d+(?:\\.\\d+)?$"), species: { default: "human", type: "string" } }, ["id"]),
        keywords: ["Ensembl transcript", "transcript stable ID"],
      },
      overlap_region: {
        description: "Retrieve genes, transcripts, or variants overlapping a genomic region up to 5 Mb.",
        inputSchema: objectSchema({
          feature: { default: "gene", enum: ["gene", "transcript", "variation"], type: "string" },
          region: text(100),
          species: { default: "human", type: "string" },
        }, ["region"]),
        keywords: ["genomic region", "overlap", "coordinates"],
      },
      variant_consequence: {
        description: "Fetch Ensembl VEP consequences for a known variant identifier.",
        inputSchema: objectSchema({ id: text(100), species: { default: "human", type: "string" } }, ["id"]),
        keywords: ["variant consequence", "VEP", "rsID"],
        priority: 90,
      },
    },
  },
  {
    attribution: "Pathway knowledge provided by Reactome.",
    caveats: ["Preserve Reactome stable IDs, species, release version, pathway hierarchy, and enrichment correction values."],
    description: "Curated pathways and enrichment analysis from Reactome.",
    displayName: "Reactome",
    hosts: [...externalUrlList("connector_hosts.reactome")],
    id: "reactome",
    kinds: ["pathway"],
    license: "Reactome Content License",
    publisher: "Reactome",
    termsUrl: externalUrl("terms.reactome"),
    tools: {
      enrichment: {
        description: "Run Reactome over-representation analysis for a bounded identifier list.",
        inputSchema: objectSchema({
          identifiers: { items: text(100), maxItems: 500, minItems: 1, type: "array" },
          species: { default: "Homo sapiens", type: "string" },
        }, ["identifiers"]),
        keywords: ["pathway enrichment", "over-representation", "gene list"],
        kind: "analysis",
        priority: 92,
        resultType: "analysis-result",
      },
      lookup_pathway: {
        description: "Look up one Reactome stable pathway identifier.",
        inputSchema: objectSchema({ id: accession("^R-[A-Z]{3}-\\d+$") }, ["id"]),
        keywords: ["Reactome ID", "pathway details"],
      },
      search_pathways: {
        description: "Search Reactome pathways and reactions.",
        inputSchema: objectSchema({ limit, query: text(), species: { default: "Homo sapiens", type: "string" } }, ["query"]),
        keywords: ["pathway", "reaction", "Reactome"],
      },
    },
  },
  {
    attribution: "Clinical variant assertions provided by NCBI ClinVar.",
    caveats: ["Keep VCV/RCV/SCV accessions, review status, assertion dates, conditions, and conflicting submissions distinct."],
    description: "Clinical variant interpretations and submission assertions from ClinVar.",
    displayName: "ClinVar",
    hosts: [...externalUrlList("connector_hosts.clinvar")],
    id: "clinvar",
    kinds: ["variation"],
    license: "NCBI data usage policy",
    publisher: "NCBI",
    termsUrl: externalUrl("terms.ncbi"),
    tools: {
      get_assertions: {
        description: "Retrieve ClinVar evidence records with individual submitted assertions, versions, classifications, review status and conditions.",
        inputSchema: objectSchema({ accession: clinvarAccession }, ["accession"]),
        keywords: ["ClinVar assertions", "SCV", "conflicting submissions"],
        resultType: "evidence-records",
      },
      lookup_accession: {
        description: "Look up a ClinVar VCV, RCV, or Variation ID accession.",
        inputSchema: objectSchema({ accession: clinvarAccession }, ["accession"]),
        keywords: ["VCV", "RCV", "ClinVar accession"],
      },
      search_variants: {
        description: "Search ClinVar using Entrez query syntax.",
        inputSchema: objectSchema({ limit, query: text() }, ["query"]),
        keywords: ["clinical variant", "pathogenicity", "ClinVar", "gene variant"],
        priority: 95,
      },
    },
  },
  {
    attribution: "Bioactivity data provided by ChEMBL at EMBL-EBI.",
    caveats: ["Preserve assay type, target, organism, standard relation/value/units, confidence score, and document provenance."],
    description: "Molecules, targets, assays, and measured bioactivities from ChEMBL.",
    displayName: "ChEMBL",
    hosts: [...externalUrlList("connector_hosts.chembl")],
    id: "chembl",
    kinds: ["chemistry"],
    license: "ChEMBL data usage terms",
    publisher: "EMBL-EBI",
    termsUrl: externalUrl("terms.chembl"),
    tools: {
      search_activities: {
        description: "Retrieve a page of measured activities with molecule/target, assay, organism, confidence, and standard measurement filters. A value ceiling requires explicit type, units and relation. Preserve assay_metadata and follow pagination.nextOffset.",
        inputSchema: objectSchema({
          limit, offset,
          molecule_chembl_id: accession("^CHEMBL\\d+$"), target_chembl_id: accession("^CHEMBL\\d+$"),
          standard_type: text(50), standard_units: text(50),
          standard_relation: { enum: ["=", "<", "<=", ">", ">=", "~"], type: "string" },
          standard_value_max: { minimum: 0, type: "number" },
          assay_type: { enum: ["B", "F", "A", "T", "P", "U"], type: "string" },
          target_organism: text(100), confidence_score_min: { minimum: 0, maximum: 9, type: "integer" },
        }, []),
        keywords: ["bioactivity", "IC50", "Ki", "assay"],
        priority: 92,
        timeoutMs: 90_000,
      },
      search_molecules: {
        description: "Search ChEMBL molecules by name or identifier.",
        inputSchema: objectSchema({ limit, offset, query: text() }, ["query"]),
        keywords: ["small molecule", "compound", "drug", "ChEMBL molecule"],
      },
      search_targets: {
        description: "Search ChEMBL biological targets.",
        inputSchema: objectSchema({ limit, offset, query: text() }, ["query"]),
        keywords: ["drug target", "ChEMBL target", "target protein"],
      },
      similarity_search: {
        description: "Search ChEMBL molecules by SMILES similarity threshold.",
        inputSchema: objectSchema({
          limit, offset,
          similarity: { default: 70, maximum: 100, minimum: 40, type: "integer" },
          smiles: text(2_000),
        }, ["smiles"]),
        keywords: ["chemical similarity", "SMILES", "similar compound"],
      },
    },
  },
  {
    attribution: "Functional genomics metadata and files provided by NCBI GEO.",
    caveats: ["Distinguish Series, Samples, Platforms, curated DataSets, processed matrices, and raw supplementary files."],
    description: "Functional genomics studies and downloadable matrices from GEO.",
    displayName: "GEO",
    hosts: [...externalUrlList("connector_hosts.geo")],
    id: "geo",
    kinds: ["dataset", "genomics"],
    license: "NCBI data usage policy",
    publisher: "NCBI GEO",
    termsUrl: externalUrl("terms.ncbi"),
    tools: {
      get_samples: {
        description: "Retrieve up to five GEO sample metadata records per page without expression tables. Follow pagination.nextOffset; inspect data type before count-based analysis.",
        inputSchema: objectSchema({ accession: accession("^GSE\\d+$"), limit: { ...limit, maximum: 5 }, offset }, ["accession"]),
        keywords: ["GEO samples", "GSM", "sample conditions", "treatment groups", "GEO platform"],
        priority: 92,
        timeoutMs: 180_000,
      },
      list_files: {
        description: "Discover actual GEO matrix, SOFT and supplementary files from NCBI listings; follow pagination.nextOffset.",
        inputSchema: objectSchema({ accession: accession("^GSE\\d+$"), limit, offset }, ["accession"]),
        keywords: ["GEO files", "series matrix", "supplementary files"],
        resultType: "structured-data",
        timeoutMs: 120_000,
      },
      lookup_accession: {
        description: "Look up a GEO accession through Entrez GEO DataSets.",
        inputSchema: objectSchema({ accession: accession("^(GSE|GDS|GPL|GSM)\\d+$") }, ["accession"]),
        keywords: ["GEO accession", "GSE", "GDS", "GPL", "GSM"],
      },
      prepare_dataset_download: {
        description: "Prepare one discovered GEO file for governed download. Use file_name from list_files for multi-platform matrices or supplementary data; inspect matrix type before analysis.",
        inputSchema: objectSchema({
          accession: accession("^GSE\\d+$"),
          format: { default: "series-matrix", enum: ["series-matrix", "soft", "supplementary"], type: "string" },
          file_name: text(255),
        }, ["accession"]),
        keywords: ["download GEO", "expression matrix", "GEO SOFT"],
        kind: "artifact-plan",
        priority: 92,
        resultType: "artifact-plan",
        timeoutMs: 120_000,
      },
      search_studies: {
        description: "Search GEO Series and DataSets using Entrez query syntax.",
        inputSchema: objectSchema({ limit, query: text() }, ["query"]),
        keywords: ["gene expression dataset", "functional genomics", "GEO study"],
        priority: 90,
      },
    },
  },
];

function extractPayload(raw: McpRawResult): unknown {
  const structured = raw.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    if ("sourceId" in structured) return structured;
    if ("result" in structured && structured.result && typeof structured.result === "object") return structured.result;
  }
  for (const block of raw.content) {
    if (block.type === "json") return block.value;
    if (block.type === "text") {
      try {
        return JSON.parse(block.text) as unknown;
      } catch {
        // Try the next content block.
      }
    }
  }
  throw new Error("MCP response did not contain JSON");
}

function validateAgainstSchema(schema: Record<string, unknown>, input: unknown): ValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { issues: [{ message: "input must be an object", path: "" }], valid: false };
  }
  const object = input as Record<string, unknown>;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const issues: ValidationIssue[] = [];
  for (const required of (schema.required as string[] | undefined) ?? []) {
    if (object[required] === undefined) issues.push({ message: "is required", path: required });
  }
  for (const [key, value] of Object.entries(object)) {
    const property = properties[key];
    if (!property) {
      issues.push({ message: "is not allowed", path: key });
      continue;
    }
    if (property.type === "string" && typeof value !== "string") issues.push({ message: "must be a string", path: key });
    if (property.type === "integer" && !Number.isInteger(value)) issues.push({ message: "must be an integer", path: key });
    if (property.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) issues.push({ message: "must be a finite number", path: key });
    if (property.type === "array" && !Array.isArray(value)) issues.push({ message: "must be an array", path: key });
    if (typeof value === "string" && property.pattern && !new RegExp(String(property.pattern), "i").test(value)) {
      issues.push({ message: "has an invalid format", path: key });
    }
    if (typeof value === "string" && typeof property.minLength === "number" && value.trim().length < property.minLength) issues.push({ message: "is too short", path: key });
    if (typeof value === "string" && typeof property.maxLength === "number" && value.length > property.maxLength) issues.push({ message: "is too long", path: key });
    if (Array.isArray(property.enum) && !property.enum.includes(value)) issues.push({ message: "has an unsupported value", path: key });
    if (typeof value === "number" && typeof property.minimum === "number" && value < property.minimum) issues.push({ message: "is too small", path: key });
    if (typeof value === "number" && typeof property.maximum === "number" && value > property.maximum) issues.push({ message: "is too large", path: key });
  }
  return issues.length ? { issues, valid: false } : { input: structuredClone(object) as JsonValue, valid: true };
}

function manifest(definition: SourceDefinition): McpSourceManifest {
  return {
    cache: { enabled: true, scope: "global-public", ttlSeconds: 3_600 },
    description: definition.description,
    displayName: definition.displayName,
    enabledByDefault: false,
    governance: {
      attribution: definition.attribution,
      dataClassification: "public",
      license: definition.license,
      maxConcurrentRequests: definition.rateLimit?.maxConcurrentRequests ?? 2,
      maxQueueDepth: DEFAULT_MCP_RATE_LIMIT_QUEUE.maxQueueDepth,
      maxResponseBytes: 5_000_000,
      ...(definition.rateLimit?.minIntervalMs !== undefined
        ? { minIntervalMs: definition.rateLimit.minIntervalMs }
        : {}),
      networkHosts: definition.hosts,
      queueTimeoutMs: DEFAULT_MCP_RATE_LIMIT_QUEUE.queueTimeoutMs,
      rateLimitGroup: definition.hosts[0]!,
      rateLimitPerSecond: definition.hosts[0]?.includes("ncbi") ? 3 : 5,
      termsUrl: definition.termsUrl,
    },
    id: definition.id,
    kinds: definition.kinds,
    prompt: {
      caveats: definition.caveats,
      citationPolicy: `Use the canonical ${definition.displayName} citation returned in primaryCitation.`,
      summary: definition.description,
    },
    publisher: definition.publisher,
    schemaVersion: "1",
    tools: Object.fromEntries(Object.entries(definition.tools).map(([toolId, tool]) => [toolId, {
      description: tool.description,
      displayName: toolId.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" "),
      id: toolId,
      idempotent: true,
      inputSchema: tool.inputSchema,
      kind: tool.kind ?? "search",
      mcpToolName: `${definition.id}_${toolId}`,
      permission: {
        action: "connector" as const,
        resourceTemplate: `${definition.id}:${toolId}`,
        summaryTemplate: `${tool.description}`,
      },
      resultType: tool.resultType ?? "evidence-records",
      retryPolicy: {
        // Retries must not undercut the provider's pacing (e.g. arXiv's 3s interval).
        initialDelayMs: definition.rateLimit?.retryInitialDelayMs ?? 500,
        jitterRatio: 0.2, maxAttempts: 3, maxDelayMs: 10_000,
        multiplier: 2, respectRetryAfter: true,
        retryOn: ["transport-error", "rate-limited", "server-error"],
      },
      routing: { keywords: tool.keywords, mode: "prefer" as const, priority: tool.priority ?? 80 },
      timeoutMs: tool.timeoutMs ?? (tool.kind === "analysis" ? 60_000 : 30_000),
    }])),
    transport: { mcpServerId: "biomed", type: "mcp" },
    version: ["pdb", "clinvar", "chembl", "geo"].includes(definition.id) ? "2.0.0" : "1.0.0",
  };
}

export function assertMcpProviderResult(
  result: McpToolResult,
  source: McpSourceManifest,
  toolId: string,
): void {
  if (result.sourceId !== source.id || result.toolId !== toolId || result.untrusted !== true) {
    throw new Error("MCP result identity does not match the invoked source and tool");
  }
  if (!Array.isArray(result.records) || !Array.isArray(result.warnings)) {
    throw new Error("MCP result records and warnings must be arrays");
  }
  const allowedHosts = new Set(source.governance.networkHosts);
  const assertUrl = (value: unknown, label: string) => {
    if (typeof value !== "string") throw new Error(`${label} must be a URL`);
    const url = new URL(value);
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) {
      throw new Error(`${label} host is not allowlisted for ${source.id}`);
    }
  };
  for (const record of result.records) {
    if (!record || typeof record !== "object" || record.source !== source.id
      || !record.identifier || !record.title || !Array.isArray(record.citations)
      || !record.primaryCitation) {
      throw new Error("MCP result contains an invalid record");
    }
    assertUrl(record.url, "record URL");
    for (const citation of record.citations) {
      if (citation.source !== source.id || citation.identifier !== record.identifier) {
        throw new Error("MCP citation identity does not match its record");
      }
      assertUrl(citation.url, "citation URL");
    }
  }
  for (const candidate of result.artifacts ?? []) {
    if (candidate.sourceId !== source.id || !candidate.id || !candidate.sourceRecordId) {
      throw new Error("MCP result contains an invalid ArtifactCandidate");
    }
    assertUrl(candidate.sourceUrl, "artifact URL");
  }
}

export function createPublicBiomedSources(sourceIds?: readonly string[]): McpSourceAdapter[] {
  return PUBLIC_BIOMED_SOURCE_DEFINITIONS.filter((definition) => !sourceIds || sourceIds.includes(definition.id)).map((definition) => {
    const sourceManifest = manifest(definition);
    return {
      manifest: sourceManifest,
      async normalizeResult(context, raw) {
        const payload = extractPayload(raw);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid MCP result envelope");
        const result = structuredClone(payload) as McpToolResult;
        assertMcpProviderResult(result, sourceManifest, context.tool.id);
        return {
          ...result,
          attribution: sourceManifest.governance.attribution,
          license: sourceManifest.governance.license,
          retrievedAt: typeof result.retrievedAt === "string" ? result.retrievedAt : context.retrievedAt,
          sourceId: sourceManifest.id,
          toolId: context.tool.id,
          untrusted: true,
          warnings: Array.isArray(result.warnings) ? result.warnings : [],
        };
      },
      validateInput(toolId, input) {
        const tool = sourceManifest.tools[toolId];
        if (sourceManifest.id === "chembl" && toolId === "search_activities" && input && typeof input === "object" && !Array.isArray(input)) {
          const values = input as Record<string, unknown>;
          if (!values.molecule_chembl_id && !values.target_chembl_id) return { valid: false, issues: [{ path: "target_chembl_id", message: "molecule_chembl_id or target_chembl_id is required" }] };
          if (values.standard_value_max !== undefined && (!values.standard_type || !values.standard_units || !values.standard_relation)) return { valid: false, issues: [{ path: "standard_value_max", message: "requires standard_type, standard_units and standard_relation" }] };
        }
        return tool
          ? validateAgainstSchema(tool.inputSchema, input)
          : { issues: [{ message: `Unknown tool: ${toolId}`, path: "toolId" }], valid: false };
      },
    };
  });
}

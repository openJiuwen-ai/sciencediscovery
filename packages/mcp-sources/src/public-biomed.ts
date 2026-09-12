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
const accession = (pattern: string) => ({ maxLength: 80, minLength: 1, pattern, type: "string" });

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
        inputSchema: objectSchema({ limit, query: text() }, ["query"]),
        keywords: ["protein structure", "crystal structure", "PDB", "ligand structure"],
        priority: 90,
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
        description: "Retrieve the complete ClinVar XML assertion record for an accession.",
        inputSchema: objectSchema({ accession: text(100) }, ["accession"]),
        keywords: ["ClinVar assertions", "SCV", "conflicting submissions"],
        resultType: "structured-data",
      },
      lookup_accession: {
        description: "Look up a ClinVar VCV, RCV, or Variation ID accession.",
        inputSchema: objectSchema({ accession: text(100) }, ["accession"]),
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
        description: "Search measured ChEMBL activities with optional molecule and target filters.",
        inputSchema: objectSchema({ limit, molecule_chembl_id: text(50), target_chembl_id: text(50) }, []),
        keywords: ["bioactivity", "IC50", "Ki", "assay"],
        priority: 92,
      },
      search_molecules: {
        description: "Search ChEMBL molecules by name or identifier.",
        inputSchema: objectSchema({ limit, query: text() }, ["query"]),
        keywords: ["small molecule", "compound", "drug", "ChEMBL molecule"],
      },
      search_targets: {
        description: "Search ChEMBL biological targets.",
        inputSchema: objectSchema({ limit, query: text() }, ["query"]),
        keywords: ["drug target", "ChEMBL target", "target protein"],
      },
      similarity_search: {
        description: "Search ChEMBL molecules by SMILES similarity threshold.",
        inputSchema: objectSchema({
          limit,
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
      list_files: {
        description: "List standard GEO Series matrix and family-file candidates.",
        inputSchema: objectSchema({ accession: accession("^GSE\\d+$") }, ["accession"]),
        keywords: ["GEO files", "series matrix", "supplementary files"],
        resultType: "structured-data",
      },
      lookup_accession: {
        description: "Look up a GEO accession through Entrez GEO DataSets.",
        inputSchema: objectSchema({ accession: accession("^(GSE|GDS|GPL|GSM)\\d+$") }, ["accession"]),
        keywords: ["GEO accession", "GSE", "GDS", "GPL", "GSM"],
      },
      prepare_dataset_download: {
        description: "Prepare a standard GEO Series matrix or family SOFT download candidate.",
        inputSchema: objectSchema({
          accession: accession("^GSE\\d+$"),
          format: { default: "series-matrix", enum: ["series-matrix", "soft"], type: "string" },
        }, ["accession"]),
        keywords: ["download GEO", "expression matrix", "GEO SOFT"],
        kind: "artifact-plan",
        priority: 92,
        resultType: "artifact-plan",
      },
      search_studies: {
        description: "Search GEO Series and DataSets using Entrez query syntax.",
        inputSchema: objectSchema({ limit, query: text() }, ["query"]),
        keywords: ["gene expression dataset", "functional genomics", "GEO study"],
        priority: 90,
      },
    },
  },
  // Z6 biodata expansion (PubChem / AlphaFold DB / InterPro / OPTIMADE /
  // STRING / BioGRID). Every tool below is kind "lookup" on purpose: the
  // broker mirrors only kind "search" tools into the Memory Graph as Paper
  // nodes, and none of these sources return literature — mirroring a compound
  // or an interaction edge as a Paper would pollute the graph.
  {
    attribution: "Data provided by PubChem (NCBI/NLM).",
    caveats: [
      "PubChem aggregates depositor records: the same compound can carry conflicting depositor values; the CID is the stable identity.",
      "Property records report depositor-declared values; preserve units and the exact property names.",
    ],
    description: "Compound records, identifiers, and molecular properties from PubChem.",
    displayName: "PubChem",
    hosts: [...externalUrlList("connector_hosts.pubchem")],
    id: "pubchem",
    kinds: ["chemistry"],
    license: "Public domain (U.S. Government work)",
    publisher: "U.S. National Library of Medicine",
    termsUrl: externalUrl("terms.pubchem"),
    tools: {
      lookup: {
        description: "Look up one PubChem compound property record by CID.",
        inputSchema: objectSchema({ cid: accession("^\\d{1,9}$") }, ["cid"]),
        keywords: ["PubChem CID", "compound properties", "molecular weight", "SMILES lookup"],
        kind: "lookup",
        resultType: "structured-data",
      },
      resolve: {
        description: "Resolve a compound name, SMILES, or InChI into a PubChem property record.",
        inputSchema: objectSchema(
          // Capped below PUG-REST's GET URL limit — percent-encoded long
          // identifiers (macro-molecule SMILES/InChI) would 4xx at the
          // provider; PUG requires POST for those (a documented later port).
          { by: { default: "name", enum: ["name", "smiles", "inchi"], type: "string" }, value: text(1_000) },
          ["value"],
        ),
        keywords: ["resolve SMILES", "resolve InChI", "compound from name"],
        kind: "lookup",
        resultType: "structured-data",
      },
      search: {
        description: "Search PubChem compound names and return matching CIDs.",
        inputSchema: objectSchema({ limit, query: text() }, ["query"]),
        keywords: ["PubChem", "compound", "CID", "chemical search"],
        kind: "lookup",
        priority: 85,
        resultType: "structured-data",
      },
    },
  },
  {
    attribution: "Predictions from AlphaFold DB (EMBL-EBI & Google DeepMind).",
    caveats: [
      "Predicted structures are not experimentally determined: mean pLDDT >70 is trustworthy, <50 is usually a disordered region.",
      "For experimental structures prefer the PDB source.",
      // KNOWN GAP: the platform URL allowlist (assertMcpProviderResult) only
      // governs record landing pages, so the cifUrl/pdbUrl/paeUrl fields that
      // afdb_lookup passes through inside structuredData are unvetted — they
      // come from the upstream payload verbatim.
      "Model file links (cifUrl/pdbUrl/paeUrl) are passed through from the upstream payload verbatim; the connector URL allowlist only governs the record landing page.",
    ],
    description: "AlphaFold protein structure predictions from AlphaFold DB.",
    displayName: "AlphaFold DB",
    hosts: [...externalUrlList("connector_hosts.afdb")],
    id: "afdb",
    kinds: ["structure", "protein"],
    license: "CC-BY-4.0",
    publisher: "EMBL-EBI / Google DeepMind",
    termsUrl: externalUrl("terms.afdb"),
    tools: {
      lookup: {
        description: "Look up AlphaFold predicted structures for a UniProt accession.",
        inputSchema: objectSchema({ uniprot_acc: accession("^[A-Za-z0-9]{6,10}$") }, ["uniprot_acc"]),
        keywords: ["AlphaFold", "predicted structure", "pLDDT", "protein model"],
        kind: "lookup",
        priority: 90,
        resultType: "structured-data",
      },
    },
  },
  {
    attribution: "Data provided by InterPro (EMBL-EBI).",
    caveats: [
      "Pfam was folded into InterPro in 2022 (pfam.xfam.org is retired); Pfam signatures are served under the pfam database.",
      "Preserve the entry accession, type, and source database of every annotation.",
    ],
    description: "Protein family, domain, and signature annotations from InterPro.",
    displayName: "InterPro",
    hosts: [...externalUrlList("connector_hosts.interpro")],
    id: "interpro",
    kinds: ["protein"],
    license: "CC0 1.0",
    publisher: "EMBL-EBI",
    // Shares the www.ebi.ac.uk rate bucket with the other EBI sources.
    termsUrl: externalUrl("terms.interpro"),
    tools: {
      lookup_entry: {
        description: "Look up one InterPro protein family or domain entry (IPR or legacy Pfam accession).",
        inputSchema: objectSchema({ accession: accession("^(IPR|PF)\\d{4,8}$") }, ["accession"]),
        keywords: ["InterPro", "protein family", "domain", "Pfam signature"],
        kind: "lookup",
        priority: 85,
        resultType: "structured-data",
      },
      protein_entries: {
        description: "List the InterPro annotations of one UniProt accession.",
        inputSchema: objectSchema({ limit, uniprot_acc: accession("^[A-Za-z0-9]{6,10}$") }, ["uniprot_acc"]),
        keywords: ["InterPro annotations", "protein domains for accession"],
        kind: "lookup",
        resultType: "structured-data",
      },
    },
  },
  {
    attribution: "Data provided via OPTIMADE providers (OQMD, AFLOW, COD, Materials Project).",
    caveats: [
      "Providers do not uniformly honor page limits — results are truncated locally.",
      "Prefer COD for experimental crystal structures and OQMD/Materials Project for DFT-computed ones; proprietary databases (CSD/ICSD) are out of scope.",
    ],
    description: "Unified crystal-structure queries across OPTIMADE materials databases.",
    displayName: "OPTIMADE",
    hosts: [...externalUrlList("connector_hosts.optimade")],
    id: "optimade",
    kinds: ["dataset"],
    license: "CC-BY-4.0 / public domain (per provider; COD is public domain)",
    publisher: "OPTIMADE consortium (OQMD, AFLOW, COD, Materials Project)",
    rateLimit: { minIntervalMs: 500 },
    termsUrl: externalUrl("terms.optimade"),
    tools: {
      query_structures: {
        description: "Query crystal structures across OPTIMADE providers by filter, reduced formula, or element list.",
        inputSchema: objectSchema(
          {
            elements: text(200),
            filter: text(1_000),
            formula: text(100),
            limit,
            provider: { default: "oqmd", enum: ["oqmd", "aflow", "cod", "mp"], type: "string" },
          },
          [],
        ),
        keywords: ["OPTIMADE", "crystal structure", "materials database", "OQMD", "AFLOW", "COD", "Materials Project"],
        kind: "lookup",
        priority: 80,
        resultType: "structured-data",
      },
    },
  },
  {
    attribution: "Data provided by the STRING database.",
    caveats: [
      "Combined scores integrate experimental and predicted evidence (0-1000; >=700 is high confidence).",
      "Predicted interactions need experimental review before being treated as established.",
    ],
    description: "Protein-protein interaction networks and identifier resolution from STRING.",
    displayName: "STRING",
    hosts: [...externalUrlList("connector_hosts.string")],
    id: "string",
    kinds: ["protein"],
    license: "CC-BY-4.0",
    publisher: "STRING Consortium (EMBL, SIB, CPR)",
    rateLimit: { minIntervalMs: 1_000 },
    termsUrl: externalUrl("terms.string"),
    tools: {
      network: {
        description: "Retrieve protein-interaction network edges for a set of protein identifiers.",
        inputSchema: objectSchema(
          {
            limit,
            proteins: text(1_000),
            species: { default: 9606, maximum: 2_147_483_647, minimum: 1, type: "integer" },
          },
          ["proteins"],
        ),
        keywords: ["STRING", "protein interaction", "PPI", "interaction network", "combined score"],
        kind: "lookup",
        priority: 88,
        resultType: "structured-data",
      },
      resolve: {
        description: "Resolve a protein name to its STRING identifier.",
        inputSchema: objectSchema(
          { name: text(200), species: { default: 9606, maximum: 2_147_483_647, minimum: 1, type: "integer" } },
          ["name"],
        ),
        keywords: ["STRING identifier", "protein name resolution"],
        kind: "lookup",
        resultType: "structured-data",
      },
    },
  },
  {
    attribution: "Data provided by BioGRID.",
    caveats: [
      "All BioGRID edges are manually curated experimental interactions; preserve the PubMed evidence identifiers.",
      "Requires the BIOGRID_API_KEY environment variable on the gateway; without it the tool reports unauthorized.",
    ],
    description: "Manually curated experimental protein and genetic interactions from BioGRID.",
    displayName: "BioGRID",
    hosts: [...externalUrlList("connector_hosts.biogrid")],
    id: "biogrid",
    kinds: ["protein"],
    license: "BioGRID academic-use terms (registration required)",
    publisher: "BioGRID (Princeton / Lunenfeld-Tanenbaum)",
    rateLimit: { minIntervalMs: 500 },
    termsUrl: externalUrl("terms.biogrid"),
    tools: {
      interactions: {
        description: "Look up curated experimental interactions for a gene.",
        inputSchema: objectSchema(
          {
            gene: text(100),
            limit,
            taxon_id: { default: 9606, maximum: 2_147_483_647, minimum: 1, type: "integer" },
          },
          ["gene"],
        ),
        keywords: ["BioGRID", "experimental interaction", "curated PPI", "genetic interaction"],
        kind: "lookup",
        priority: 85,
        resultType: "structured-data",
      },
    },
  },
  {
    attribution: "Data provided by the Genome Aggregation Database (gnomAD), Broad Institute.",
    caveats: [
      // DA-measured: the public API tolerates ~10 req/min — point queries only;
      // bulk analyses must use the official VCF downloads.
      "API rate limit is ~10 requests/min — suitable for point lookups only; use official VCF downloads for bulk analysis.",
      "Allele frequencies are population references, not pathogenicity verdicts.",
    ],
    description: "Population allele frequencies and gene constraint metrics from gnomAD.",
    displayName: "gnomAD",
    hosts: [...externalUrlList("connector_hosts.gnomad")],
    id: "gnomad",
    kinds: ["genomics", "variation"],
    license: "ODC-BY / Broad Institute terms",
    publisher: "Broad Institute",
    rateLimit: { minIntervalMs: 6_000 },
    termsUrl: externalUrl("terms.gnomad"),
    tools: {
      gene: {
        description: "Look up gene-level constraint metrics (observed/expected LOF and missense ratios).",
        inputSchema: objectSchema(
          {
            gene: text(50),
            reference_genome: { default: "GRCh38", enum: ["GRCh37", "GRCh38"], type: "string" },
          },
          ["gene"],
        ),
        keywords: ["gnomAD", "gene constraint", "LOEUF", "pLI alternative", "intolerance"],
        kind: "lookup",
        priority: 85,
        resultType: "structured-data",
      },
      variant: {
        description: "Look up population allele frequencies for a variant id (chr-pos-ref-alt).",
        inputSchema: objectSchema(
          {
            reference_genome: { default: "GRCh38", enum: ["GRCh37", "GRCh38"], type: "string" },
            variant_id: accession("^\\d{1,2}[XYM]?-\\d+-[ACGT]+-[ACGT]+$"),
          },
          ["variant_id"],
        ),
        keywords: ["gnomAD", "allele frequency", "population frequency", "variant"],
        kind: "lookup",
        priority: 85,
        resultType: "structured-data",
      },
    },
  },
  {
    attribution: "Data provided by the NHGRI-EBI GWAS Catalog.",
    caveats: [
      "Association is not causation: verify ancestry and statistical model in the cited publication before interpreting OR/beta.",
      // DA-measured (2026-08-31): the v1 findBy* endpoints retired with HTTP 404;
      // only the v2 associations endpoint remains.
    ],
    description: "Curated SNP-trait associations from the NHGRI-EBI GWAS Catalog.",
    displayName: "GWAS Catalog",
    hosts: [...externalUrlList("connector_hosts.gwas")],
    id: "gwas",
    kinds: ["genomics"],
    license: "EMBL-EBI terms of use",
    publisher: "EMBL-EBI / NHGRI",
    // Shares the www.ebi.ac.uk rate bucket with the other EBI sources.
    rateLimit: { minIntervalMs: 200 },
    termsUrl: externalUrl("terms.gwas"),
    tools: {
      search_gene: {
        description: "Search GWAS associations mapped to a gene.",
        inputSchema: objectSchema({ gene: text(100), limit }, ["gene"]),
        keywords: ["GWAS", "association", "gene", "risk variant"],
        kind: "lookup",
        priority: 80,
        resultType: "structured-data",
      },
      search_trait: {
        description: "Search SNP-trait associations by trait name (variant, gene, p-value, odds ratio).",
        inputSchema: objectSchema({ limit, trait: text(200) }, ["trait"]),
        keywords: ["GWAS", "association", "trait", "p-value", "odds ratio"],
        kind: "lookup",
        priority: 80,
        resultType: "structured-data",
      },
    },
  },
  {
    attribution: "Data provided by the IUPHAR/BPS Guide to PHARMACOLOGY.",
    caveats: [
      "Expert-curated coverage of ~1,900 targets / ~12,000 ligands — deeper curation than ChEMBL but narrower breadth.",
      "CC-BY-SA licensed: query-only, never persist full records (share-alike contamination).",
    ],
    description: "Expert-curated pharmacological targets, ligands, and interaction affinities.",
    displayName: "Guide to PHARMACOLOGY",
    hosts: [...externalUrlList("connector_hosts.gtopdb")],
    id: "gtopdb",
    kinds: ["protein", "chemistry"],
    license: "CC-BY-SA-4.0 (query-only; do not persist)",
    publisher: "IUPHAR/BPS",
    rateLimit: { minIntervalMs: 500 },
    termsUrl: externalUrl("terms.gtopdb"),
    tools: {
      interactions: {
        description: "Look up ligand-target interactions (affinity, action type) for a ligand id.",
        inputSchema: objectSchema(
          { ligand_id: { maximum: 2_147_483_647, minimum: 1, type: "integer" } },
          ["ligand_id"],
        ),
        keywords: ["GtoPdb", "ligand target interaction", "affinity", "pharmacology"],
        kind: "lookup",
        priority: 80,
        resultType: "structured-data",
      },
      search_ligand: {
        description: "Search pharmacological ligands (drugs, endogenous ligands) by name.",
        inputSchema: objectSchema({ name: text(200) }, ["name"]),
        keywords: ["GtoPdb", "ligand", "drug", "agonist", "antagonist"],
        kind: "lookup",
        priority: 80,
        resultType: "structured-data",
      },
      search_target: {
        description: "Search pharmacological targets (receptors, ion channels, enzymes) by name.",
        inputSchema: objectSchema({ name: text(200) }, ["name"]),
        keywords: ["GtoPdb", "pharmacological target", "receptor", "ion channel"],
        kind: "lookup",
        priority: 80,
        resultType: "structured-data",
      },
    },
  },
  {
    attribution: "Data provided by KEGG (Kanehisa Laboratories).",
    caveats: [
      "Academic use is free; bulk scraping and mirroring are prohibited and no whole-database list operation is offered; commercial use needs a separate license.",
      "Responses are flat-file plain text; get records are truncated to ~4,000 characters.",
      "For openly cacheable pathway data prefer Reactome (CC-BY).",
    ],
    description: "KEGG pathway, compound, gene, and cross-database mappings (REST flat files).",
    displayName: "KEGG",
    hosts: [...externalUrlList("connector_hosts.kegg")],
    id: "kegg",
    kinds: ["pathway"],
    license: "KEGG academic-use terms (commercial use requires a Kanehisa Laboratories license)",
    publisher: "Kanehisa Laboratories (Kyoto University)",
    rateLimit: { minIntervalMs: 340 },
    termsUrl: externalUrl("terms.kegg"),
    tools: {
      find: {
        description: "Find entries in a KEGG database by keyword (pathway, compound, genes, ko, disease, or organism code like hsa).",
        inputSchema: objectSchema({ database: text(20), query: text(300) }, ["database", "query"]),
        keywords: ["KEGG", "pathway search", "compound search", "gene search"],
        kind: "lookup",
        priority: 75,
        resultType: "structured-data",
      },
      get: {
        description: "Get one KEGG flat-file record by entry id (e.g. hsa:10458, C00031, hsa04517), truncated.",
        inputSchema: objectSchema({ entry_id: accession("^[A-Za-z0-9:_.-]{1,64}$") }, ["entry_id"]),
        keywords: ["KEGG", "entry detail", "flat file", "pathway record"],
        kind: "lookup",
        priority: 75,
        resultType: "structured-data",
      },
      link: {
        description: "Cross-database mapping: find related entries in a target KEGG database for a source entry (e.g. gene to pathway).",
        inputSchema: objectSchema(
          {
            id: accession("^[A-Za-z0-9_.-]{1,64}$"),
            source_db: text(20),
            target_db: text(20),
          },
          ["source_db", "target_db", "id"],
        ),
        keywords: ["KEGG", "cross reference", "gene pathway mapping", "link"],
        kind: "lookup",
        priority: 75,
        resultType: "structured-data",
      },
    },
  },
  {
    attribution: "Data provided by PRIDE Archive (EMBL-EBI, ProteomeXchange).",
    caveats: [
      "Upstream rate-limit tolerance is low (community-reported ~50 req/min); bursts fall back to 429 retry pacing.",
      // DA-measured (2026-09-01): /files/byProject returns 200 with an empty body
      // on both v2 and v3 — the file list must use /projects/{accession}/files.
      "The files tool returns file metadata only (name, type, size, download URL); it never downloads file content.",
    ],
    description: "Proteomics mass-spectrometry dataset projects from PRIDE Archive.",
    displayName: "PRIDE Archive",
    hosts: [...externalUrlList("connector_hosts.pride")],
    id: "pride",
    kinds: ["dataset"],
    license: "ProteomeXchange terms (most datasets CC0; per-dataset licenses win)",
    publisher: "EMBL-EBI (ProteomeXchange consortium)",
    // Shares the www.ebi.ac.uk rate bucket with the other EBI sources.
    rateLimit: { minIntervalMs: 200 },
    termsUrl: externalUrl("terms.pride"),
    tools: {
      files: {
        description: "List a project's files by PXD accession (metadata only, first 50).",
        inputSchema: objectSchema({ accession: accession("^PXD\\d{1,9}$") }, ["accession"]),
        keywords: ["PRIDE", "proteomics files", "mass spectrometry", "dataset files"],
        kind: "lookup",
        priority: 75,
        resultType: "structured-data",
      },
      project: {
        description: "Look up one PRIDE project by PXD accession (description, species, instruments, references).",
        inputSchema: objectSchema({ accession: accession("^PXD\\d{1,9}$") }, ["accession"]),
        keywords: ["PRIDE", "proteomics project", "PXD accession"],
        kind: "lookup",
        priority: 80,
        resultType: "structured-data",
      },
      search_projects: {
        description: "Search proteomics dataset projects by keyword.",
        inputSchema: objectSchema({ keyword: text(300), limit }, ["keyword"]),
        keywords: ["PRIDE", "proteomics dataset", "mass spectrometry", "ProteomeXchange"],
        kind: "lookup",
        priority: 75,
        resultType: "structured-data",
      },
    },
  },
  {
    attribution: "Data provided by Wikidata.",
    caveats: [
      "The SPARQL endpoint enforces a 60s query timeout — complex queries are cut off; community data quality varies, verify critical facts against an authoritative source.",
    ],
    description: "Read-only Wikidata SPARQL queries and entity resolution for cross-database identifier mapping.",
    displayName: "Wikidata",
    hosts: [...externalUrlList("connector_hosts.wikidata")],
    id: "wikidata",
    kinds: ["dataset"],
    license: "CC0 1.0",
    publisher: "Wikimedia Foundation",
    rateLimit: { minIntervalMs: 3_000 },
    termsUrl: externalUrl("terms.wikidata"),
    tools: {
      resolve_entity: {
        description: "Resolve a name to Wikidata entities (Q ids) in a given language.",
        inputSchema: objectSchema(
          { language: { default: "en", maxLength: 10, minLength: 2, type: "string" }, name: text(300) },
          ["name"],
        ),
        keywords: ["Wikidata", "entity resolution", "Q id", "identifier mapping"],
        kind: "lookup",
        priority: 70,
        resultType: "structured-data",
      },
      sparql: {
        description: "Run a read-only SPARQL SELECT query (cross-database id mapping, entity properties, relations).",
        inputSchema: objectSchema({ limit, query: text(4_000) }, ["query"]),
        keywords: ["Wikidata", "SPARQL", "identifier mapping", "cross-reference"],
        kind: "lookup",
        priority: 70,
        resultType: "structured-data",
      },
    },
  },
  {
    attribution: "Metadata provided by DataCite.",
    caveats: [
      "One search covers DOI metadata from 100+ repositories (Zenodo, Figshare, Dryad, Dataverse…); the files themselves live in each repository.",
      "Metadata is CC0; each dataset carries its own license — check before download.",
    ],
    description: "Cross-repository research-dataset search and DOI metadata via DataCite.",
    displayName: "DataCite",
    hosts: [...externalUrlList("connector_hosts.datacite")],
    id: "datacite",
    kinds: ["dataset"],
    license: "Metadata CC0 (per-dataset licenses vary)",
    publisher: "DataCite",
    rateLimit: { minIntervalMs: 200 },
    termsUrl: externalUrl("terms.datacite"),
    tools: {
      lookup: {
        description: "Look up one dataset's metadata by DOI.",
        inputSchema: objectSchema({ doi: accession("^10\\.\\d{4,9}/..+$") }, ["doi"]),
        keywords: ["DataCite", "DOI", "dataset metadata", "data repository"],
        kind: "lookup",
        priority: 75,
        resultType: "structured-data",
      },
      search: {
        description: "Search research datasets across 100+ repositories by keyword and optional publication year.",
        inputSchema: objectSchema(
          {
            limit,
            query: text(500),
            year: { maximum: 3_000, minimum: 1_900, type: "integer" },
          },
          ["query"],
        ),
        keywords: ["DataCite", "dataset search", "research data", "Zenodo", "Dryad", "Figshare"],
        kind: "lookup",
        priority: 75,
        resultType: "structured-data",
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
    if (property.type === "array" && !Array.isArray(value)) issues.push({ message: "must be an array", path: key });
    if (typeof value === "string" && property.pattern && !new RegExp(String(property.pattern), "i").test(value)) {
      issues.push({ message: "has an invalid format", path: key });
    }
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
      timeoutMs: tool.kind === "analysis" ? 60_000 : 30_000,
    }])),
    transport: { mcpServerId: "biomed", type: "mcp" },
    version: "1.0.0",
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

export function createPublicBiomedSources(): McpSourceAdapter[] {
  return PUBLIC_BIOMED_SOURCE_DEFINITIONS.map((definition) => {
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
        return tool
          ? validateAgainstSchema(tool.inputSchema, input)
          : { issues: [{ message: `Unknown tool: ${toolId}`, path: "toolId" }], valid: false };
      },
    };
  });
}

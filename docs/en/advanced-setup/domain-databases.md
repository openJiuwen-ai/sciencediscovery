# Domain scientific databases through MCP

[中文](../../zh/advanced-setup/domain-databases.md)

ScienceDiscovery includes GEO, ChEMBL, ClinVar, RCSB PDB and AlphaFold DB connectors. These retrieve datasets and database records, independently of literature connectors. The bundled `biomed` MCP server calls official provider APIs over HTTPS. Public queries need no provider API key; the backend needs access to the provider hosts in `config/external-urls.json`.

## Setup and inspect

1. Start ScienceDiscovery normally. Source installations are managed in Settings → Plugins; keep the desired connector installed and enabled.
2. Select the desired connector for the target Session (or inherit its Project/global selection). Enabling a plugin alone does not select it for an Agent.
3. Open Settings → MCP servers → Built-in sources, expand the source, and open **MCP Inspector**. Select a tool and enter its JSON parameters. A Session is required for the audit trail.
4. Inspect the raw and normalized result and audit ID. A manual Inspector call authorizes that source for that call; it does not change the Session's Agent connector selection.
5. Ask the Agent to use the selected database and cite returned identifiers. Inspect completed download jobs before asking it to analyze a file.

For an external MCP service, see [Custom MCP configuration](configure-custom-mcp.md). Generic custom MCP returns remain raw/structured data; connecting an arbitrary server does not automatically produce the database evidence records described here.

## Reproducible starting queries

The Inspector shows the provider-facing tool names (for example `geo_get_samples`). Agent tools use the `mcp__<source>__<tool>` convention.

| Source | Tool and example JSON | Result and next step |
|---|---|---|
| GEO | `geo_lookup_accession`: `{"accession":"GSE1000"}` | Study metadata with sample/platform references; GSM and GPL accessions can also be looked up. |
| GEO | `geo_get_samples`: `{"accession":"GSE1000","limit":5,"offset":0}` | Sample conditions, organism, processing and platform annotations; follow `data.pagination.nextOffset`. |
| GEO | `geo_list_files`: `{"accession":"GSE1000","limit":25,"offset":0}` | Actual matrix, SOFT and supplementary file listings. |
| GEO | `geo_prepare_dataset_download`: `{"accession":"GSE1000","format":"series-matrix"}` | A single discovered matrix candidate. Supply `file_name` from the listing if there are several files; use `format:"supplementary"` for a supplemental file. |
| ChEMBL | `chembl_search_activities`: `{"target_chembl_id":"CHEMBL203","standard_type":"IC50","standard_units":"nM","standard_relation":"=","standard_value_max":100,"assay_type":"B","target_organism":"Homo sapiens","confidence_score_min":8,"limit":5,"offset":0}` | Measurements with original units/relations, document references and `assay_metadata`. Follow the returned next offset. |
| ClinVar | `clinvar_get_assertions`: `{"accession":"VCV000014206"}` | Versioned record with individual SCV submissions, classifications, review information and conditions. RCV and numeric Variation IDs are supported too. |
| PDB | `pdb_lookup_structure`: `{"pdb_id":"1CRN"}` | Experimental entry metadata, method, resolution and entity identifiers. |
| PDB | `pdb_prepare_structure_download`: `{"pdb_id":"1CRN","format":"cif"}` | Experimental CIF candidate; PDB format is also supported when available from the provider. |
| AlphaFold DB | `alphafold_lookup_prediction`: `{"accession":"P69905"}` | Existing predicted models, version, protein accession and confidence metadata. |
| AlphaFold DB | `alphafold_prepare_prediction_download`: `{"accession":"P69905","format":"cif"}` | Model download candidates; use `pdb`, `plddt` or `pae` for other files. Select `model_id` for a particular fragment. |

ChEMBL also exposes molecule/target searches and SMILES similarity searches, each with `limit` and `offset`. PDB text search accepts `limit` and `offset` and requests experimental results. GEO study search and ClinVar variant search are bounded discovery queries: refine the query to retrieve other matches.

## Data interpretation and limits

- **GEO:** Files are discovered from NCBI's Series archive directories, including platform-specific matrices and supplementary files. Only immediate files in `matrix`, `soft` and `suppl` are enumerated; external study repositories and nested archive contents are not expanded. Sample annotations preserve source fields rather than inventing experimental groups. Metadata is capped at 4 MB; use the family SOFT artifact for larger studies. Sample metadata is fetched only for the selected page, without expression tables, with up to five samples per page. File pages contain at most 25 files. Before analysis, inspect dimensions, sample IDs, missing values, processing and platform annotations. A nonnegative integer check alone cannot establish raw counts: normalized microarray intensities must not be passed to DESeq2 as RNA-seq counts.
- **ChEMBL:** A target or molecule ID is required. A numeric value ceiling also requires measurement type, units and relation. Confidence is checked against fetched assay metadata locally, per provider page. A filtered page can be empty while `hasMore` is true: follow `nextOffset`, which advances over scanned rows. Preserve `standard_relation`, units, assay type, organism, confidence and document references when comparing measurements. Do not interpret a returned page as the full dataset.
- **ClinVar:** VCV/RCV versions are preserved when supplied to assertion retrieval. Individual SCV submissions remain separate, including conflicting classifications, dates, submitters and conditions. The structured `record` and `submission` fields preserve XML attributes and repeated elements. Records above the supported XML size fail explicitly rather than being silently truncated. Returned classifications are submitted evidence requiring interpretation.
- **PDB:** Metadata and files represent experimental structures. Downloaded CIF/PDB files contain chain/entity and ligand details for downstream parsing; inspect experimental method and available resolution before using a structure.
- **AlphaFold DB:** These are existing predictions, explicitly marked `structureType:"predicted"`; this connector does not run AlphaFold or schedule GPU work. Models and available confidence URLs come from the API, preserving versions. Interpret per-residue pLDDT and PAE separately. Missing confidence files produce a warning; unavailable model IDs fail explicitly.

## Downloads and provenance

A `prepare_*` result contains an **ArtifactCandidate**, not file bytes. Use the existing download flow: select the candidate and workspace destination, approve its plan, then wait for the ArtifactJob to complete and verify its checksum. Keep large files outside model context and let analysis tools read the completed workspace artifact. GEO matrices and PDB structures should be parsed before calculating results.

Normalized records retain their stable identifiers, source URL, retrieval time and source version where supplied. Download plans link the candidate, source record and MCP invocation; completed jobs retain the checksum and final path. Preserve those links and identifiers in analysis outputs. Provider release metadata is not invented when unavailable.

Provider errors, absent files and response-size limits are surfaced explicitly. Connection success does not prove that every provider operation or file is currently available. Configure outbound proxies using [Network proxy configuration](configure-network-proxy.md).

## Developer validation

Run provider/parser unit tests with `services/gateway/.venv/bin/python -m pytest services/gateway/tests/test_domain_databases.py`. The hermetic browser journey `test/journey-domain-databases.spec.ts` checks built-in Inspector discovery and invalid-input feedback without contacting providers. Live provider and completed-download checks require `DOMAIN_DATABASES_LIVE=1 node --import tsx test/api/domain-databases-journey.mjs`; these must not be inferred from mocked browser results.

# Built-in Research Capabilities Reference

This page records the scientific connectors, Skills, and Specialists bundled with the current version. These inventories can change with releases; see [Core capabilities](../README.md#core-capabilities) for concepts and intended use.

## Built-in scientific connectors

| Research need | Included sources | Typical use |
| --- | --- | --- |
| Papers and preprints | PubMed, Europe PMC, arXiv, bioRxiv, medRxiv | Discover studies and retain identifiers and source links |
| Protein function and structure | UniProt, PDB | Query annotations, structure entries, and structure files |
| Genes and variants | Ensembl, ClinVar | Query genes, transcripts, variants, and annotations |
| Pathways and experimental data | Reactome, GEO | Find pathway information and public expression studies |
| Compounds and activity | ChEMBL | Query compounds, targets, and activity records |

When configured and available, the LLM Wiki connector can also search and read knowledge pages.

Bundled integration does not guarantee service availability, unrestricted downloads, or full-text access. Actual tools and connection state depend on the current Session.

## Built-in Skills

| Work area | Skill | Purpose |
| --- | --- | --- |
| Research organization and evidence briefs | `science-research-team`, `life-science-evidence-brief` | Organize literature/data research and produce traceable summaries |
| Retrieval, extraction, and writing | `literature-searcher`, `evidence-extractor`, `report-writer` | Move from source discovery to evidence extraction and synthesis |
| Computation and assessment | `code-engineer`, `result-evaluator` | Produce reproducible analyses and assess results |
| Citation and numerical checks | `citation-reviewer`, `computation-reviewer` | Check source support and numerical consistency |
| Material-design exploration | `creative-material-design`, `assessment-screening`, `insight-aggregator` | Propose candidates, assess perspectives, and summarize feedback |
| Autonomous research and artifact improvement | `idea-tree-team`, `evolve-design` | Prepare Idea Tree inputs and design/launch artifact evolution |
| Structures and antibody workflows | `structure-pocket-inspection`, `antibody-design` | Inspect structures and organize antibody-design workflows |
| Reusable methods | `skill-creator` | Draft reviewable Skill packages |

A Skill being installed or available does not mean the model used it in a particular run. Inspect execution records and outputs.

## Built-in Specialists

| Specialist | Suitable work | Main delivery |
| --- | --- | --- |
| `literature-searcher` | Search academic sources, deduplicate, record coverage gaps | Source lists and retrieval notes |
| `evidence-extractor` | Extract findings, methods, statistics, and limits | Structured evidence with source anchors |
| `code-engineer` | Write, execute, and debug Python/R analyses | Scripts, results, and reproduction notes |
| `result-evaluator` | Assess accuracy, completeness, and robustness | Evaluation and revision guidance |
| `report-writer` | Synthesize existing summaries and source relationships | Final report |
| `creative-material-design` | Propose material candidates | Candidate material designs |
| `assessment-screener` | Assess material candidates from specified perspectives | Dimension-level evaluation and verification notes |
| `insight-aggregator` | Compare assessment results | Agreements, disagreements, and improvement insights |

Preset role names do not imply professional qualifications or independent scientific validation.

## Extension paths

- [Connect custom MCP servers](../advanced-setup/configure-custom-mcp.md)
- [Import and manage Skills](../advanced-setup/configure-skills.md)
- [Create and use custom Specialists](../advanced-setup/configure-specialists.md)

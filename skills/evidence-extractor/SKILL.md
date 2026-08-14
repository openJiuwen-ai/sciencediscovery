---
name: evidence-extractor
description: Use this skill when a research workflow needs source-grounded evidence extraction from a `literature_sources.json` package or compatible source list. Produces an integration-ready evidence package with claims, evidence, citations, confidence/strength labels, quality notes, and partial results when some sources cannot be processed. Not for literature search, deduplication, final report writing, cross-source synthesis, or workflow coordination.
---

# Evidence Extractor

## Overview

Evidence Extractor reads provided source metadata and available source content, then extracts structured evidence items aligned to the research objective.

This skill receives a source package or a compatible user-provided list, processes sources one by one, and returns structured evidence that a downstream synthesis step can integrate into a knowledge summary. It does not coordinate additional workers, search for additional literature, or require downstream consumers to reconstruct results from intermediate messages.

Core principle: the extractor reads and mines provided sources. It extracts evidence; it does not discover new sources or synthesize final conclusions.

Output principle: the final response must be self-contained. Always return the Markdown summary plus an embedded JSON evidence package, even when extraction is partial or no evidence can be extracted. File paths may be included as artifacts, but they are never the only handoff.

## Core Capabilities

- Accept a deduplicated source package.
- Validate required source metadata before extraction.
- Extract claims, findings, statistics, methods, mechanisms, and limitations.
- Classify evidence by type: empirical, statistical, theoretical, mechanistic, or opinion.
- Assign confidence and strength ratings with traceable source citations.
- Categorize extracted items by domain theme.
- Identify extraction gaps and source quality limitations.
- Produce a structured evidence package for downstream synthesis/report writing.

## When To Use This Skill

Use this skill when the workflow needs:

- Evidence extraction from a known list of academic sources.
- Structured claims and findings from papers, preprints, reports, or clinical studies.
- Source-grounded evidence items for a later report writer.
- Confidence, strength, and evidence-type labels for each extracted item.
- A quality check before synthesis or final writing.

Do not use this skill when the task is to:

- Search for new papers or reports.
- Deduplicate or rank source lists.
- Produce a literature search methodology.
- Write the final research report.
- Synthesize cross-source conclusions into a narrative deliverable.

## Input Template

Minimum input is `Evidence Extraction Assignment` plus `Source Package`.

```markdown
### Evidence Extraction Assignment
[research objectives and questions that drive extraction]

### Source Package
[path to literature_sources.json, or embedded source list]

### Domain Context
[BIOMEDICINE | CHEMISTRY | MATERIALS | FINANCE | COMPUTER_SCIENCE | GENERAL]

### Extraction Strategy Hint
[optional: full | statistical | mechanistic | theoretical]

### Source Content
[optional full text, abstracts, snippets, uploaded PDFs, or accessible source excerpts]

### Output Directory
[optional directory for evidence JSON artifacts]
```

Expected source package shape:

```json
{
  "sources": [
    {
      "title": "Attention Is All You Need",
      "authors": ["Ashish Vaswani", "Noam Shazeer"],
      "year": 2017,
      "venue": "NeurIPS",
      "doi": "10.5555/3295222.3295349",
      "url": "https://arxiv.org/abs/1706.03762",
      "abstract": "Short abstract text...",
      "source_database": "arxiv"
    }
  ],
  "total_results": 1,
  "dedup_report": {
    "total_before_dedup": 1,
    "duplicates_removed": 0,
    "final_unique": 1
  }
}
```

## Handoff Contract

This skill may run as one of several parallel extraction tasks. Its final task result is the integration boundary for downstream synthesis.

Every final response must include:

- `## Evidence Extraction Results` Markdown summary.
- `### Evidence Package` with an embedded JSON block.
- `### Verdict` with one of `SUFFICIENT`, `PARTIAL`, or `INSUFFICIENT`.
- Source-level quality notes for missing content, malformed metadata, skipped sources, and low-confidence extraction.

Do not rely on intermediate messages, hidden reasoning, or artifact paths as the only output. If an output file is written, also embed the same evidence package JSON in the final response so the parent orchestrator can validate and integrate the task result directly.

For partial runs, return accumulated evidence rather than an empty or failed task result. One malformed or inaccessible source should not fail the whole sub-task.

## Methodology/Workflow

The extractor follows a source-grounded workflow: input validation, source comprehension, systematic extraction, and quality check. It should stay focused on extracting evidence from provided sources. Do not search for new literature, deduplicate source lists, or write final synthesis.

### Phase 1: Input Validation And Extraction Planning

Objective: confirm that the source package and research objective are specific enough for reliable extraction.

#### Step 1.1: Validate Required Inputs

Before extracting, verify:

- Research objective is specific enough to decide what evidence matters.
- Source package is present and contains at least one source.
- Each source has `title`, `authors`, `year`, `venue`, `source_database`, and either `doi` or `url`.
- Domain context is specified or can safely default to `GENERAL`.
- Source content is available as full text, abstract, uploaded document text, or source snippets.

If source content is unavailable and only metadata is present, extract only metadata-level evidence and mark confidence as `LOW`. Do not invent claims that are not present in the provided content.

#### Step 1.2: Normalize Source Package

Accept either a `literature_sources.json` path or an embedded source list. Normalize each source into this working shape:

```json
{
  "title": "...",
  "authors": ["..."],
  "year": 2024,
  "venue": "...",
  "doi": "...",
  "url": "...",
  "abstract": "...",
  "source_database": "arxiv"
}
```

Track missing fields in Quality Notes. Missing DOI is acceptable if URL is present. Missing abstract is acceptable only when other source content is provided.

Treat placeholder metadata as a metadata gap. Examples include `authors: ["Multiple authors"]`, empty author lists, missing venue, missing year, or DOI/URL placeholders. Do not fail the extraction only because of a metadata gap, but record it in Quality Notes.

#### Step 1.3: Choose Extraction Strategy

Choose one strategy based on the assignment and source type:

| Strategy | Use When | Priority |
|---|---|---|
| Full extraction | General research questions or mixed source types | Claims, findings, methods, limitations |
| Statistical extraction | Data-heavy empirical studies | Metrics, counts, rates, p-values, effect sizes |
| Mechanistic extraction | Process, pathway, synthesis, or protocol questions | Mechanisms, procedures, causal explanations |
| Theoretical extraction | Conceptual, modeling, proof, or framework papers | Assumptions, models, propositions, arguments |

If the first strategy yields too few relevant items, try one alternate strategy before marking coverage as weak.

### Phase 2: Source Comprehension

Objective: understand each source well enough to avoid shallow or fabricated extraction.

#### Step 2.1: Identify Source Metadata

For each source, identify:

| Field | Description |
|---|---|
| Title | Full source title |
| Authors | Author list |
| Venue / Type | Journal, conference, report, preprint, or other source type |
| Year | Publication or creation year |
| Domain | Research field or workflow domain |
| Source Type | Academic paper, report, preprint, clinical study, etc. |

#### Step 2.2: Read High-Density Regions

Prioritize high-density evidence regions when full text is available:

1. Abstract and Introduction
2. Methods or Methodology
3. Results or Findings
4. Discussion and Limitations
5. Conclusion

For abstract-only sources, extract only claims explicitly present in the abstract and mark `Source Citation` as `Abstract`. Abstract-only evidence should normally be `LOW` or `MEDIUM` confidence; reserve `HIGH` for cases where full text, tables, figures, or explicit source sections are available. For metadata-only sources, do not extract substantive claims.

#### Step 2.3: Build A Key Claims Inventory

Before final extraction, identify candidate claims in this rough form:

```markdown
Claim: [specific contribution, finding, statistic, method, or limitation]
Evidence: [data, table/figure reference, method description, quote summary, or argument]
Location: [section/page/paragraph/abstract]
Initial strength: [Strong | Moderate | Weak]
Relevance: [why this matters for the assignment]
```

Discard candidates that are not relevant to the extraction objective.

### Phase 3: Systematic Evidence Extraction

Objective: turn relevant candidate claims into structured evidence items.

#### Step 3.1: Extract Evidence Items

Extract source-grounded items that answer the research objective.

Each item must include:

- Claim or finding.
- Evidence backing the claim.
- Source citation or location.
- Evidence type.
- Confidence.
- Domain theme.
- Strength.
- Extraction justification.

#### Step 3.2: Classify Evidence Type

Evidence type definitions:

| Evidence Type | Definition | Examples |
|---|---|---|
| EMPIRICAL | Evidence from experiments, observations, or measurements | experimental results, benchmarks, phenotype data, property measurements |
| STATISTICAL | Quantitative result, metric, statistical analysis, rate, or interval | p-values, confidence intervals, accuracy, risk metrics, yield |
| THEORETICAL | Conceptual framework, proof, model, or reasoning-based claim | formal model, mechanism hypothesis, pricing theory |
| MECHANISTIC | Process explanation, causal pathway, mechanism, or procedure | pathway mechanism, reaction mechanism, algorithmic pipeline |
| OPINION | Expert interpretation, recommendation, or viewpoint without direct empirical backing | author interpretation, policy recommendation, market outlook |

#### Step 3.3: Apply Domain Themes

Use domain-specific themes when possible:

| Domain | Primary Themes | Secondary Themes |
|---|---|---|
| BIOMEDICINE | Pathway/Mechanism, Performance | Methodology, Application |
| CHEMISTRY | Synthesis, Property | Methodology, Application |
| MATERIALS | Structure, Performance | Methodology, Application |
| FINANCE | Risk, Return | Methodology, Application |
| COMPUTER_SCIENCE | Method, Performance | Dataset, Application, Limitation |
| GENERAL | Topic-aligned themes | Context themes |

#### Step 3.4: Calibrate Confidence And Strength

Confidence:

| Confidence | Criteria |
|---|---|
| HIGH | Directly supported by source text, data, figure, table, or explicit statement |
| MEDIUM | Supported but requires some interpretation or context |
| LOW | Weakly supported, abstract-only, ambiguous, or limited source content |

Strength:

| Strength | Criteria |
|---|---|
| Strong | Clear evidence from rigorous data, validated experiments, direct observations, or formal proof |
| Moderate | Some evidence, but with limitations or indirect support |
| Weak | Limited evidence, unsupported interpretation, opinion, or preliminary result |

Do not inflate confidence because a source is famous or highly cited. Confidence describes traceability and clarity in the provided content.

#### Step 3.5: Extraction Density Guideline

For full-text primary sources, aim for several useful items per source, especially from Results, Methods, Discussion, and Limitations. For abstract-only sources, one or two low/medium-confidence items may be enough. Quality is more important than item count.

### Phase 4: Quality Check And Handoff

Objective: verify traceability and prepare the evidence package for downstream synthesis/report writing.

#### Step 4.1: Traceability Check

Before returning evidence, verify:

- Every item is traceable to source content.
- No item is inferred beyond the provided source text.
- Low-confidence items are explicitly marked.
- Evidence type distribution is documented.
- Source access limitations are documented.
- Contradictions across sources are preserved rather than resolved.

If an item fails traceability, remove it and record the removed count in Quality Notes.

Use this check:

```markdown
Fabrication check:
- Does the item cite a specific source?
- Does the item cite a location when available?
- Is the claim actually present in the provided content?
- Is the evidence backing described without inventing missing details?
Verdict: PASS or FAIL
```

#### Step 4.2: Distribution And Gap Check

Summarize:

- Evidence type distribution.
- Confidence distribution.
- Strength distribution.
- Domain theme distribution.
- Sources with no extractable evidence.
- Missing evidence types or weak themes.

Do not force a balanced distribution if the source content is naturally skewed. Document the skew as a limitation.

#### Step 4.3: Contradiction Handling

When sources disagree, extract both claims separately with source-specific citations. Do not resolve contradictions into a single conclusion. Mark the contradiction in Quality Notes so the report writer can handle it later.

#### Step 4.4: Verdict

Return one of:

- `SUFFICIENT`: enough traceable HIGH/MEDIUM-confidence evidence for downstream synthesis.
- `PARTIAL`: evidence exists but source access, coverage, or confidence is limited.
- `INSUFFICIENT`: too little source-grounded evidence, too many untraceable items, or source content is unavailable.

The final output should include an embedded evidence package or an `evidence_items.json` path when artifacts are written.

## Output Template

Return Markdown summary plus JSON-ready evidence structure when useful.

```markdown
## Evidence Extraction Results

### Source Metadata
- Sources processed: [count]
- Domain: [domain]
- Source package: [path or embedded input description]
- Source content availability: [full text / abstracts only / metadata only / mixed]

### Evidence Items Extracted

#### Item 1
- **Source**: [title, year]
- **Claim**: [extracted claim or finding]
- **Evidence**: [data, quote summary, figure/table reference, or argument description]
- **Source Citation**: [section/page/paragraph/abstract if available]
- **Evidence Type**: [EMPIRICAL | STATISTICAL | THEORETICAL | MECHANISTIC | OPINION]
- **Confidence**: [HIGH | MEDIUM | LOW]
- **Domain Theme**: [theme]
- **Strength**: [Strong | Moderate | Weak]
- **Extraction Justification**: [why this item is relevant to the assignment]

#### Item 2
[repeat]

### Extraction Summary
- Total items extracted: [count]
- Sources processed: [count]
- Items per source: [average]
- Evidence type distribution: [counts]
- Domain theme distribution: [counts]
- Confidence distribution: HIGH [count], MEDIUM [count], LOW [count]
- Strength distribution: Strong [count], Moderate [count], Weak [count]

### Quality Notes
- Fabrication check: [PASS | FAIL] -- [brief note]
- Removed untraceable items: [count]
- Low-confidence items: [count + reason]
- Sources with limited content: [count + reason]
- Type distribution gaps: [none or list]

### Coverage Gaps Identified
- Evidence type gaps: [types under-represented]
- Theme gaps: [themes missing or weak]
- Extraction limitations: [paywall, abstract-only, language barrier, missing full text]

### Evidence Package
- Output path: [path to evidence_items.json, if written]
- Downstream consumer: synthesis step

### Verdict
- [SUFFICIENT | PARTIAL | INSUFFICIENT]: [brief reason]
```

## Evidence Package Interface

When writing JSON artifacts, use this shape:

```json
{
  "evidence_items": [
    {
      "source_title": "Attention Is All You Need",
      "source_year": 2017,
      "source_url": "https://arxiv.org/abs/1706.03762",
      "claim": "The Transformer replaces recurrence with self-attention for sequence transduction.",
      "evidence": "The abstract and method description state that the model relies entirely on attention mechanisms.",
      "source_citation": "Abstract / Method section",
      "evidence_type": "THEORETICAL",
      "confidence": "HIGH",
      "domain_theme": "Method",
      "strength": "Strong",
      "extraction_justification": "Directly supports the research objective about transformer architecture."
    }
  ],
  "summary": {
    "total_items": 1,
    "sources_processed": 1,
    "confidence_distribution": {
      "HIGH": 1,
      "MEDIUM": 0,
      "LOW": 0
    }
  },
  "quality_notes": {
    "fabrication_check": "PASS",
    "removed_untraceable_items": 0,
    "limitations": []
  }
}
```

## Notes

- The skill does not search the web or call literature databases.
- The skill may use abstracts when full text is not available, but must mark abstract-only items clearly and avoid overconfident ratings.
- Placeholder metadata such as `Multiple authors` should be recorded as a metadata gap.
- Do not fabricate methods, statistics, or findings from title/metadata alone.
- Do not resolve contradictions into a single conclusion; preserve source-specific claims for downstream synthesis.
- If the input source package was produced by a prior retrieval step, assume source identity was verified there, but still verify every extracted evidence item against available source content.

## Error Handling

| Failure mode | Recovery |
|---|---|
| No research objective | Ask for a clearer extraction target before proceeding. |
| No source package | Ask for `literature_sources.json` or an embedded source list. |
| Metadata only | Extract only metadata-level evidence; mark confidence LOW. |
| Source inaccessible | Skip source or use available abstract/snippet; record limitation. |
| Fabrication check fails | Remove untraceable items and recalculate summary. |
| Too few evidence items | Try a broader extraction strategy; otherwise return PARTIAL or INSUFFICIENT. |
| Contradictory claims | Extract both claims with citations and note the contradiction. |

---
name: report-writer
description: Receives Domain Summaries (Knowledge Summary, Analysis Summary, or both) from the science-research-team orchestrator, performs cross-domain synthesis (identifying SUPPORTS/CONTRADICTS/INFORMS/INDEPENDENT connections), surfaces contradictions verbatim, and produces a formatted output per user requirements (or the default 7-section template if no format specified). NOT for performing research, conducting analysis, evaluating results, or resolving contradictions.
---

# Report Writer Skill

## Overview

This skill synthesizes Domain Summaries into a formatted output. It performs cross-domain synthesis (identifying connections and surfacing contradictions verbatim), then produces the output per the user's specified format — writing files as the user requested. If no format is specified, it defaults to the 7-section template. It synthesizes and formats — it does not add new findings, resolve contradictions, or evaluate results.

Dispatched by the `science-research-team` orchestrator at Step 5 of the workflow, after Knowledge and/or Data domain sub-agents have completed and their outputs have been integrated into Domain Summaries.

## When to Use This Skill

**Use this skill when:**

- The science-research-team orchestrator needs the final synthesis step — report-writer receives integrated Domain Summaries and produces the user-facing output
- Domain sub-agents (literature-searcher, evidence-extractor, code-engineer, result-evaluator) have completed their work and their outputs are ready for synthesis
- The user needs a structured synthesis of knowledge and/or data findings, with cross-domain connections identified and contradictions surfaced

**Do NOT use this skill for:**

- Performing original research or literature search — those belong to knowledge domain sub-agents
- Conducting data analysis or statistical testing — those belong to code-engineer
- Evaluating result validity — that belongs to result-evaluator
- Resolving contradictions between domains — report-writer surfaces them, the user decides

## Input Sources

This skill receives **Domain Summaries** from the `science-research-team` orchestrator via the `task` tool. Input format:

```markdown
### Domain Summaries
[Path to `knowledge_summary.md` if knowledge domain was activated, path to `analysis_summary.md` if data domain was activated.]

### Format Expectation
*(only if the user specified one)* — file name, file format, file location, etc. that the user requested. Omit if not specified.

### Constraints
*(only if the user specified any)* — audience, length, language, etc. that the user requested. Omit if not specified.
```

The orchestrator integrates sub-agent outputs into these summaries before passing them here. The report-writer does NOT receive raw sub-agent outputs — it receives the integrated summaries.

**Knowledge Summary format** (from orchestrator integration):

```markdown
### Knowledge Findings
[Source-supported claims answering the research objective; each tied to one or more sources via provenance.]

### Methods Used
[How evidence was gathered — databases queried, search terms, screening criteria, time window.]

### Evidence Landscape
[Overview of the field's coverage — which sub-topics have strong/weak/conflicting evidence.]

### Identified Gaps
[Where the evidence is thin, missing, or contested relative to the research objective.]
```

**Analysis Summary format** (from orchestrator integration):

```markdown
### Objective
[The specific analysis objective this Summary addresses.]

### Method
[Analytical approach — code logic, libraries + versions, statistical methods used.]

### Results
[Quantitative or qualitative findings with effect sizes, confidence intervals, p-values as appropriate.]

### Caveats & Limitations
[Sample size, missing data, assumption violations, threats to validity.]

### Reproducibility
[How to re-run — code, data path, seed, environment dependencies.]
```

Minimum input: one Domain Summary (Knowledge or Analysis). If neither is provided, cannot synthesize — request re-dispatch.

## Python Package Installation

If you need to install new Python packages, install them through the Tsinghua PyPI mirror for reliability:

```bash
pip install [python package] -i https://pypi.tuna.tsinghua.edu.cn/simple
```

## Workflow

### Step 1: Read and Validate Domain Summaries

1. Read the Domain Summary files at the paths provided in the input
2. Determine which domains are active:

| Scenario | Available inputs | Sections affected |
|---|---|---|
| **Dual-domain** | Knowledge Summary + Analysis Summary | All 7 sections populated; Sections 4–5 contain cross-domain connections and contradictions |
| **Knowledge only** | Knowledge Summary only | Section 2 populated; Section 3 notes `[DATA DOMAIN NOT ACTIVATED]`; Sections 4–5 note `[SINGLE DOMAIN]` |
| **Analysis only** | Analysis Summary only | Section 3 populated; Section 2 notes `[KNOWLEDGE DOMAIN NOT ACTIVATED]`; Sections 4–5 note `[SINGLE DOMAIN]` |

3. Verify summaries contain substantive content (not placeholders, not empty). If a section is empty, note the gap and proceed with available content — never fabricate.

### Step 2: Execute 4-Phase Synthesis Protocol

#### Phase 1 — Domain Classification and Output Format Determination

- Record which domains are present
- Determine output format: user's `Format Expectation` if provided; otherwise DEFAULT (7-section template)
- Record any user `Constraints` (audience, length, language)

#### Phase 2 — Cross-Domain Synthesis

**Extract key findings per domain** — read each Domain Summary's sections:

- Knowledge Summary: Knowledge Findings → Section 2.1; Evidence Landscape → Section 2.2; Identified Gaps → Section 2.3; Methods Used → inform cross-domain connections
- Analysis Summary: Results → Section 3.1; Caveats & Limitations → Section 3.2; Method → inform cross-domain connections; Objective → context for synthesis

Each finding MUST cite its originating sub-agent (literature-searcher, evidence-extractor, code-engineer, result-evaluator) — traceability is mandatory. If source attribution is missing in the summaries, note the gap and flag traceability as partial.

**Identify cross-domain connections** (dual-domain only) using the 4-label taxonomy:

| Label | Definition |
|---|---|
| **SUPPORTS** | Findings reinforce each other — same direction |
| **CONTRADICTS** | Findings disagree — opposite or incompatible conclusions |
| **INFORMS** | One finding provides context/methodology that shapes the other |
| **INDEPENDENT** | No direct relationship — different aspects |

Map each connection to its source domain summary — embedded in Executive Summary and Cross-Domain Insights section.

**Surface contradictions verbatim** — for every CONTRADICTS connection:

```
Claim A: [finding from Knowledge domain] — Source: [sub-agent-id]
Claim B: [finding from Analysis domain] — Source: [sub-agent-id]
Status: UNRESOLVED — Human decides
```

Never resolve, merge, or silently drop conflicting claims. The user is the sole arbiter.

**Single-domain handling**: Sections 4–5 note `[SINGLE DOMAIN]`. Intra-domain contradictions (if any) are surfaced labeled `[INTRA-DOMAIN]`.

#### Phase 3 — Format and Write the Report

**Determine output format**:

| User specification | Action |
|---|---|
| No format specified | Default 7-section template |
| User format specified | Follow user's format while maintaining traceability, contradiction preservation, cross-domain identification, and no invention. Always include Verdict. |

If user's format lacks sections for contradictions or cross-domain insights, append them before the Verdict rather than silently dropping them.

**Write the report body** — populate each section with findings from Phase 2, cite originating sub-agents, insert cross-domain connections and verbatim contradictions.

**Verdict assignment**:

| Verdict | Criteria |
|---|---|
| **COMPLETE** | All sections present, traceability maintained, connections identified (dual-domain), contradictions surfaced, no invention |
| **PARTIAL** | Sections incomplete, traceability gaps, connections missed |
| **FAILED** | Significant sections missing, contradictions resolved, or new claims introduced |

Verdict section is always included regardless of format.

#### Phase 4 — Output Verification

Self-check before delivery:

- **Traceability**: every finding traces to originating sub-agent — no unattributed claims
- **Contradiction preservation**: all contradictions surfaced verbatim — none resolved, merged, or dropped
- **No invention**: no claims beyond input Domain Summaries — Recommendations derive from findings only
- **Format compliance**: follows user format or default template; single-domain annotations present when applicable; Verdict included

### Step 3: Document Results

Produce the final report and save to `/mnt/user-data/outputs/report-<topic-slug>-<YYYYMMDD>.md`. Present file path back to the orchestrator.

## Default Report Template

Used when user does not specify a format:

## 1. Executive Summary
[2-3 sentence overview of the research question, key findings, and overall verdict]

## 2. Knowledge Research Findings
### 2.1 Key Findings
- [finding] — Source: [sub-agent-id] — Confidence: [level]

### 2.2 Evidence Landscape
- [evidence summary with provenance status]

### 2.3 Identified Gaps
- [gaps in literature coverage]

## 3. Data Analysis Findings
### 3.1 Key Results
- [result] — Method: [method] — Evaluation: [PASS/FAIL/CONDITIONAL]

### 3.2 Robustness & Limitations
- [robustness assessment + limitations]

## 4. Cross-Domain Insights
- [connection: knowledge finding ↔ data finding] — Type: [SUPPORTS/CONTRADICTS/INFORMS/INDEPENDENT]
[SINGLE DOMAIN — no cross-domain analysis]

## 5. Contradictions (Unresolved)
- [Claim A] vs [Claim B] — Human decides.
[SINGLE DOMAIN — no inter-domain contradictions]

## 6. Limitations & Gaps
- [combined limitations from both domains]
- [coverage gaps not addressed]

## 7. Recommendations
- [actionable next steps with rationale]

### Verdict
- COMPLETE: all sections present, traceability maintained, cross-domain connections identified, contradictions surfaced, no content invention
- PARTIAL: some sections incomplete or traceability gaps or cross-domain connections missed
- FAILED: significant sections missing or contradictions silently resolved
```

## Domain-Specific Report Patterns

| Domain | Common report shape | Typical connection types |
|---|---|---|
| **Biology** — Mechanism + validation | Knowledge: pathway mechanisms ↔ Analysis: experimental validation | INFORMS, SUPPORTS |
| **Biology** — Biomarker + statistics | Knowledge: candidate biomarkers ↔ Analysis: sensitivity/specificity | SUPPORTS, CONTRADICTS |
| **Chemistry** — Reaction methodology + yield | Knowledge: established procedures ↔ Analysis: yield optimization data | SUPPORTS, INFORMS |
| **Materials** — Structure-property | Knowledge: known correlations ↔ Analysis: measured properties | SUPPORTS, CONTRADICTS |
| **Finance** — Factor analysis | Knowledge: academic factor models ↔ Analysis: backtest results | SUPPORTS, CONTRADICTS |

## Boundary

**Forbidden**:
- Do NOT add new findings, claims, or data — all content originates from Domain Summaries
- Do NOT resolve contradictions between domains — surface them verbatim for the user
- Do NOT evaluate result validity — evaluation belongs to result-evaluator
- Do NOT perform analysis or research — those belong to their respective domain sub-agents
- Do NOT silently drop or merge conflicting claims from different domains

**Mandatory**:
- MUST produce output in user's specified format if provided; otherwise MUST use default 7-section template
- MUST maintain traceability — every finding cites its originating sub-agent
- MUST identify and label cross-domain connections explicitly (SUPPORTS/CONTRADICTS/INFORMS/INDEPENDENT) when both Domain Summaries are present
- MUST surface contradictions verbatim — never resolve, merge, or silently drop conflicting claims
- MUST NOT introduce any claims not present in the Domain Summaries
- MUST note `[SINGLE DOMAIN — no cross-domain analysis]` in Section 4 and `[SINGLE DOMAIN — no inter-domain contradictions]` in Section 5 when only one domain is present
- MUST map each cross-domain insight and each contradiction to the source Domain Summary — embedded in Executive Summary and Cross-Domain Insights

## Error Handling

| Failure mode | Recovery |
|---|---|
| Both Domain Summaries missing | Cannot synthesize — request orchestrator re-dispatch |
| One Domain Summary missing (expected dual-domain) | Proceed as single-domain with `[SINGLE DOMAIN]` annotations |
| Domain Summary section empty | Note gap in relevant section, proceed with available content |
| Domain Summary contains placeholder text | Treat as empty, note gap |
| Format Expectation ambiguous | Default to 7-section template, include note for clarification |
| Intra-domain contradictions found | Surface in Section 5 labeled `[INTRA-DOMAIN]` |
| No findings available for a section | Mark `[NO FINDINGS]`, never invent content |

## Complete Example

Synthesize a dual-domain result: knowledge findings on AI in healthcare + analysis results on clinical data.

1. **Read inputs** — `knowledge_summary.md` and `analysis_summary.md` both present and substantive
2. **Extract findings** — Knowledge Findings: 4 key findings on diagnostic AI accuracy; Results: 3 key results from clinical data regression
3. **Identify connections** — "AI radiology accuracy ~90%" SUPPORTS "model accuracy 0.89"; "AI should control for dataset bias" INFORMS "bias detected in training data"
4. **Surface contradictions** — "AI reduces diagnostic time by 50%" CONTRADICTS "time reduction only 15% in real clinical settings" — UNRESOLVED
5. **Write report** — 7-section template, all findings with source attribution, Verdict COMPLETE

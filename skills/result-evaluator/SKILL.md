---
name: result-evaluator
description: Evaluate analysis results for quality and reliability. Scores Accuracy, Completeness, Robustness, and Relevance (0-10), checks source reliability and methodology, audits statistical rigor, and decides ACCEPT_AND_PROCEED or REVISE_AND_RETRY. NOT for performing analysis or modifying results.
---

# Result Evaluator Skill

## Overview

This skill evaluates analysis results against predefined criteria and decides ACCEPT_AND_PROCEED or REVISE_AND_RETRY. It follows a 4-phase protocol: **criterion alignment → multi-dimensional evaluation with Source Reliability hard gate → statistical methodology audit → overall assessment**. Hallucination detected → immediate REVISE; any checklist dimension FAIL → mandatory REVISE (hard gate, overrides scoring).

## When to Use This Skill

**Always load this skill when:**

- User asks to evaluate, audit, score, or quality-check analysis results that another skill — typically `code-engineer` — has just produced as a Result Package
- User asks for an explicit `ACCEPT_AND_PROCEED` vs `REVISE_AND_RETRY` (or `CONDITIONAL`) decision before the results are used downstream (e.g. fed into a report, shared with stakeholders, or acted on)
- User wants a Source Reliability check on computational or research-style results — to detect hallucinated numbers, fabricated statistics, invented citations, or code–data misalignment
- User asks for a Statistical Methodology Audit covering multiple-testing correction, model-assumption verification, confounder control, sample-size/power, batch effects, outlier/missing-data handling, and reproducibility
- User requests the multi-dimensional quality score (Accuracy / Completeness / Robustness / Relevance / Methodology / Critical Reflection, each 0–10) on a Result Package
- User wants to know whether a result is reproducible from the supplied code and data, or whether the analysis should be re-run before being trusted

## Input Sources

This skill evaluates analysis results with methodology documentation. Accepted input formats:

**From `code-engineer`** (recommended upstream skill):
- **Structured data**: `--output-file` JSON (`[{col: val, ...}]`) or CSV/MD export — provides the numerical/tabular results
- **Methodology documentation**: presented in conversation by the agent — includes libraries, statistical methods, method justification
- **Data traceability**: source file names, sheet/column names, row counts, transformations applied
- **Analysis code**: the complete code used to produce results (for reproducibility audit in Phase 3)

**From other sources**: any structured results with accompanying methodology description. Minimum required: results data + method description + data source identification.

If methodology documentation or data traceability is missing, note the gap in evaluation and flag Source Reliability as PARTIALLY_RELIABLE.

## Python Package Installation

If you need to install new Python packages, install them through the Tsinghua PyPI mirror for reliability:

```bash
pip install [python package] -i https://pypi.tuna.tsinghua.edu.cn/simple
```

## Workflow

### Step 1: Understand Evaluation Input

Identify the evaluation context:

- **Analysis results to evaluate**: Structured output from code execution
- **Methodology documentation**: How the results were produced (libraries, methods, code)
- **Data traceability**: Source data identification (file names, column names, row counts)
- **Evaluation criteria**: What aspects to evaluate and expected quality thresholds. Infer from context if missing (note limitation).
- **Analysis plan context**: Domain, background information

Prerequisites: results must be available and parseable; methodology documentation and data traceability should be provided (evaluation quality degrades without them); criteria must be specified or inferable.

### Step 2: Execute 4-Phase Evaluation Protocol

#### Phase 1 — Criterion Alignment

Map each result to an evaluation criterion. Flag UNMAPPED results and uncovered criteria. Infer criteria from context if missing (document as inferred).

#### Phase 2 — Per-Result Evaluation

**Source Reliability Hard Gate** (check first — hallucination → immediate REVISE_AND_RETRY, skip rest):

For **computational-type results** (from code-engineer and similar tools):

| Check | What to detect |
|-------|---------------|
| Data traceability | Cited data sources exist (file/sheet/column match actual data, row counts consistent) |
| Method consistency | Stated methods match the actual code implementation |
| Fabrication | Invented statistics, untraceable numbers, results that cannot be reproduced from given code and data |
| Code-data alignment | Code actually references the claimed data files/variables, not different ones |

For **research-type results** (literature-based, citing external references):

| Check | What to detect |
|-------|---------------|
| Data traceability | Cited data sources exist (file/sheet/field match actual data) |
| Reference validity | Citations have author+year+DOI/PubMed (not "studies show") |
| Identifier authenticity | Standard entity/gene/protein names (not self-created) |
| Method consistency | Stated methods match implementation |
| Fabrication | Invented statistics, fake references, untraceable results |

Verdict: **RELIABLE** (PASS) / **PARTIALLY_RELIABLE** (FAIL, continue) / **UNRELIABLE** (REVISE, stop).

**Unified Evaluation Matrix** — score each dimension 0-10; each dimension also has a PASS/FAIL threshold (score ≥5 → PASS, score <5 → FAIL):

| Dimension | 9-10 | 7-8 | 4-6 | 0-3 | PASS threshold |
|------------|------|-----|-----|------|----------------|
| Accuracy | Correct, methods match | Minor errors | Significant errors | Fundamental errors | ≥5 |
| Completeness | Complete, no gaps | Minor gaps | Significant gaps | Major omissions | ≥5 |
| Robustness | Sound methods, assumptions verified | 1-2 concerns | 3-4 issues | Invalid methods | ≥5 |
| Relevance | Directly addresses question | Mostly relevant | Partially relevant | Irrelevant | ≥5 |
| Methodology | Justified, rigorous, reproducible | Adequate justification | Weak justification | No justification | ≥5 |
| Critical reflection | Assumptions stated, limitations discussed | Some reflection | Minimal reflection | No reflection | ≥5 |

**Hard Gate Rule**: any dimension FAIL (score <5) → **mandatory REVISE_AND_RETRY**, regardless of the average score. The scoring average determines the **severity grading** of the REVISE decision, not whether to REVISE.

**Composite Quality Rating** (applies only when all dimensions PASS):

| Average | Rating |
|---------|--------|
| ≥8.0 | ROBUST |
| 6.0-7.9 | ACCEPTABLE |
| 5.0-5.9 | NEEDS_IMPROVEMENT |

Modifiers from Phase 3 RISK items: ≥3 RISK items → downgrade 1 level.

**Per-Result Decision** (when all dimensions PASS):

| Average | Decision |
|---------|----------|
| ≥7.0 | ACCEPT_AND_PROCEED |
| 5.0-6.9 | CONDITIONAL — ACCEPT with stated limitations |

When any dimension FAIL: the decision is always REVISE_AND_RETRY. The severity is graded by how many dimensions FAIL and the average score of passing dimensions:

| Failure pattern | Severity |
|-----------------|----------|
| 1 dimension FAIL, avg of others ≥7 | MODERATE — targeted revision on failed dimension |
| 1-2 dimensions FAIL, avg of others 5-6.9 | SIGNIFICANT — broader revision needed |
| ≥3 dimensions FAIL, or all passing dims <5 | CRITICAL — fundamental re-approach required |

#### Phase 3 — Statistical Methodology Quality Audit

| Item | YES | NO → RISK |
|------|-----|-----------|
| Multiple testing / FDR | Method documented (Bonferroni, BH) | False positives likely |
| Model assumption verification | Tested with documented results | Model may be invalid |
| Confounder control | Known confounders included, justified | Spurious associations |
| Sample size / power | Power analysis conducted | Underpowered — false negatives |
| Batch effect / heterogeneity | Correction applied if multi-source | Batch confounded |
| Outlier / missing data | Strategy documented | Biased results |
| Reproducibility | Code provided, executable | Unverifiable results |

Domain priorities: **Biology** → batch, confounders, multiple testing; **Chemistry** → reproducibility, assumptions; **Materials** → sample size, uncertainty; **Finance** → assumptions, confounders, outlier handling.

For each NO: record RISK, assess severity (H/M/L), include in guidance if ≥MEDIUM.

#### Phase 4 — Overall Assessment

1. Check Phase 2 hard gate: any dimension FAIL → REVISE_AND_RETRY (skip to step 4)
2. If all PASS: compute average score → quality rating → apply RISK modifiers
3. Final decision:
   - ROBUST → ACCEPT_AND_PROCEED
   - ACCEPTABLE → CONDITIONAL — ACCEPT with stated limitations
   - NEEDS_IMPROVEMENT → REVISE_AND_RETRY (MODERATE severity)
4. If REVISE: prioritize guidance (FAIL dimensions > HIGH RISK > low passing scores), limit top 3 actionable items

### Step 3: Document Results

Output evaluation results per the Output Schema below.

## Output Schema

Every evaluation must produce the following structure:

```json
{
  "verdict": "ACCEPT_AND_PROCEED | CONDITIONAL | REVISE_AND_RETRY",
  "severity": "MODERATE | SIGNIFICANT | CRITICAL",
  "quality_rating": "ROBUST | ACCEPTABLE | NEEDS_IMPROVEMENT",
  "source_reliability": "RELIABLE | PARTIALLY_RELIABLE | UNRELIABLE",
  "dimension_scores": {
    "accuracy": 0-10,
    "completeness": 0-10,
    "robustness": 0-10,
    "relevance": 0-10,
    "methodology": 0-10,
    "critical_reflection": 0-10
  },
  "dimension_status": {
    "accuracy": "PASS | FAIL",
    "completeness": "PASS | FAIL",
    "robustness": "PASS | FAIL",
    "relevance": "PASS | FAIL",
    "methodology": "PASS | FAIL",
    "critical_reflection": "PASS | FAIL"
  },
  "risk_items": [
    {"item": "description", "severity": "H | M | L"}
  ],
  "revision_guidance": ["top 3 prioritized action items"],
  "limitations": ["accepted weaknesses, if CONDITIONAL"]
}
```

When presenting results to the user, format as a readable summary — not raw JSON. Highlight the verdict, failed dimensions (if any), and revision guidance (if REVISE).

## Domain-Specific Evaluation Criteria

| Domain | Key criteria | Score 9-10 | Score 0-3 |
|--------|-------------|------------|-----------|
| **General** — Data integrity | Missing values, duplicates, schema match | Clean data, transformations documented | Unchecked data quality |
| **General** — Calculation correctness | Formula verification, edge cases | Verified with test cases, edge cases handled | Unverified formulas |
| **General** — Output clarity | Labels, units, formatting | Clear labels, correct units, formatted tables | Ambiguous labels, missing units |
| **Biology** — Design validity | Controls, randomization, blinding | Proper controls + blinding documented | No controls |
| **Biology** — Statistical significance | p-values, correction, effect size | Corrected p-values + effect sizes + CI | Uncorrected only |
| **Biology** — Reproducibility | Protocol + code + data | Full protocol + code + raw data | No protocol, no code |
| **Biology** — Clinical relevance | Translational applicability | Clear relevance with limitations | Overgeneralized |
| **Chemistry** — Reaction reproducibility | Conditions, yields | Full conditions + error margins | Incomplete conditions |
| **Chemistry** — Characterization | Analytical methods coverage | NMR, XRD, MS, elemental all reported | Missing key methods |
| **Chemistry** — Computational validation | Theory-experiment agreement | Agreement within error, sensitivity tested | No comparison |
| **Chemistry** — Safety | Hazards, scalability | Safety documented, scalability assessed | No safety info |
| **Materials** — Measurement rigor | Standards, uncertainty | ASTM/ISO standards, uncertainty reported | Ad-hoc, no uncertainty |
| **Materials** — Sample prep | Reproducible synthesis, batch tracking | Reproducible with batch tracking | Single batch, no docs |
| **Materials** — Structure-property | Causal mechanism | Mechanistic link validated | Correlation without mechanism |
| **Materials** — Engineering applicability | Real-world constraints | Practical limits + failure modes assessed | Ideal conditions only |
| **Finance** — Risk-adjusted returns | Sharpe, drawdown, tail risk | Full risk metrics + tail risk | Raw returns only |
| **Finance** — Assumption validity | Distributional assumptions | Tested + regime detection | Assumed normality |
| **Finance** — Backtesting integrity | Out-of-sample, no leakage | Clean OOS, no data leakage | In-sample only, lookahead |
| **Finance** — Market microstructure | Costs, liquidity, slippage | Costs modeled, liquidity noted | Infinite liquidity assumed |

## Error Handling

| Failure mode | Recovery |
|---|---|
| Results format mismatch | Attempt parse, mark CONDITIONAL, request re-format if REVISE |
| Criteria missing/vague | Infer from context, document as inferred |
| UNRELIABLE rating but ACCEPT | Flag contradiction: "ACCEPTED BUT RATED UNRELIABLE — verify" |
| No results to evaluate | Mark as evaluation failure |
| No code / unverifiable | Flag reproducibility NO with RISK, downgrade 1 level |
| Results irrelevant | Score Relevance ≤2 → FAIL → mandatory REVISE |

## Skill Pairing

This skill works best in combination with `code-engineer` — load both for analysis tasks that require quality assurance. The typical workflow:

1. `code-engineer` performs the analysis and presents a Result Package
2. `result-evaluator` evaluates the Result Package against quality criteria
3. If REVISE_AND_RETRY: feed guidance back to `code-engineer` for re-analysis

## Complete Example

### Input (Result Package from code-engineer)

Analysis task: "Correlate X and Y in `dataset.csv` and test statistical significance."

**Structured data** (`--output-file` JSON):
```json
[
  {"metric": "Pearson_r", "value": 0.8234},
  {"metric": "p_value", "value": 0.0003},
  {"metric": "sample_size", "value": 150}
]
```

**Methodology documentation** (from conversation):
- Libraries: `scipy.stats.pearsonr`, `pandas`
- Method: Pearson correlation with two-tailed test
- Justification: X and Y are continuous variables, Pearson is appropriate for linear association

**Data traceability**:
- Source: `dataset.csv`, columns X (float64, 148 non-null) and Y (float64, 150 non-null), 150 rows total

**Analysis code**:
```python
import pandas as pd
from scipy import stats
data = pd.read_csv('dataset.csv')
corr, p_value = stats.pearsonr(data['X'], data['Y'])
print(f"Pearson correlation: r={corr:.4f}, p={p_value:.6f}")
```

### Evaluation Walkthrough

**Phase 1 — Criterion Alignment**: Criteria inferred from task: statistical significance, method validity, data coverage. All three results map to criteria; no unmapped results or uncovered criteria.

**Phase 2 — Source Reliability Hard Gate** (computational-type):
- Data traceability: PASS — columns X and Y exist in dataset.csv, 150 rows matches code
- Method consistency: PASS — code uses `pearsonr`, which matches stated method
- Fabrication: PASS — r=0.8234 and p=0.0003 are reproducible from given code and data
- Code-data alignment: PASS — code references `data['X']` and `data['Y']` from claimed file
- Verdict: RELIABLE

**Phase 2 — Unified Evaluation Matrix**:

| Dimension | Score | PASS/FAIL |
|------------|-------|-----------|
| Accuracy | 9 — r and p correct per method, sample size accurate | PASS |
| Completeness | 7 — includes r, p, n; missing confidence interval for r | PASS |
| Robustness | 6 — no normality test on X/Y before Pearson, 2 missing values in X not explained | PASS |
| Relevance | 9 — directly answers the correlation+significance question | PASS |
| Methodology | 7 — method justified (Pearson for continuous), but no assumption verification documented | PASS |
| Critical reflection | 5 — assumptions stated (continuous, linear) but limitations (outliers, non-linearity) not discussed | PASS |

All dimensions PASS → proceed to quality rating.
Average: (9+7+6+9+7+5)/6 = 6.5 → ACCEPTABLE

**Phase 3 — Statistical Methodology Audit**:
- Multiple testing: N/A (single test) → skip
- Model assumption verification: NO — normality of X/Y not tested → RISK (MEDIUM)
- Confounder control: NO — no confounders considered → RISK (MEDIUM)
- Sample size/power: YES — n=150, effect size r=0.82 provides adequate power
- Outlier/missing data: NO — 2 missing in X not addressed → RISK (LOW)
- Reproducibility: YES — full code provided

RISK items: 3 (2 MEDIUM + 1 LOW). Modifier: ≥3 RISK → downgrade 1 level. ACCEPTABLE → NEEDS_IMPROVEMENT.

**Phase 4 — Overall Assessment**:
- All dimensions PASS, but 3 RISK items downgrade from ACCEPTABLE to NEEDS_IMPROVEMENT
- Decision: REVISE_AND_RETRY (MODERATE severity — one dimension at 5, RISK items addressable)
- Revision guidance (top 3, prioritized):
  1. Test normality of X and Y before using Pearson (assumption verification)
  2. Address 2 missing values in column X (outlier/missing data strategy)
  3. Consider potential confounders and document them

### Output

```
Verdict: REVISE_AND_RETRY
Severity: MODERATE
Quality Rating: NEEDS_IMPROVEMENT
Source Reliability: RELIABLE

Dimension Scores: Accuracy 9, Completeness 7, Robustness 6,
  Relevance 9, Methodology 7, Critical Reflection 5
All dimensions: PASS

RISK Items:
  - Model assumption verification: MEDIUM (normality not tested)
  - Confounder control: MEDIUM (no confounders considered)
  - Outlier/missing data: LOW (missing values not addressed)

Revision Guidance:
  1. Test normality of X/Y before Pearson; use Spearman if non-normal
  2. Document strategy for 2 missing values in X (drop or impute)
  3. Identify and document potential confounders

Accepted Limitations: (none — REVISE)
```

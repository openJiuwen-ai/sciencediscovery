# Analysis Principles

Core tenets that govern every data-analysis task. Read **before** dispatching the data domain or writing any analysis code.

## Population & Object Validation (do this before any analysis)

Before starting analysis, you MUST first confirm that the analysis data is consistent with the target population required by the question, and check variables that may affect conclusions — such as time points, treatment status, sample source, batch, and pairing relationships.

Do NOT merge all data by default. Decide on filtering, stratification, pairing, or covariate control based on the question's intent.

If a variable may substantively change the conclusion, do NOT merely mention it in the limitations — handle it in the main analysis first. After handling, re-verify sample size, between-group distribution, and pairing integrity.

**Core principle**: ensure the analysis object is correct before choosing the analysis method. Avoid completing a formally correct but problem-mismatched analysis on the wrong data population.

## Analysis Principles (MUST follow)

1. **Filter-first**: Extract EVERY filtering condition from the question. Apply them ALL before analysis. Print before→after counts at each step. Use the EXACT column names specified.

2. **Method-fidelity**: Use the EXACT statistical method, test direction, and thresholds stated in the question. Do NOT substitute alternatives. If unsure, implement what was requested AND add a sensitivity analysis.

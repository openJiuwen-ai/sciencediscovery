---
name: cross-table-analysis
description: Use this skill for analysis spanning multiple structured data files — CSV, JSON, Excel — that must be joined, cross-referenced, or combined to answer the question. Enforces the four-step gate (read documentation, load raw data, compute with code, match output format) so no step is skipped into a wrong answer.
---

# Cross-Table Analysis (multi-file structured data)

You are a structured-data analyst. The four steps below are **gates**: each
must be completed before the next begins. Skipping any of them is how
plausible-looking wrong numbers get produced.

## Step 1: Read the documentation (not skippable)

Before touching any data file:

1. Inventory the material: `list_files` for workspace files, `kb_search` /
   `list_knowledge_bases` for ingested documents.
2. Identify the non-data documents (manual, guide, README, data dictionary)
   and read at least one of them in full — `read_file` for workspace files,
   `kb_expand` for ingested ones.
3. Extract and write down:
   - **Formulas**: the formula itself, each parameter's meaning, and its
     unit (percent? basis points? per mille?).
   - **Field definitions**: business meaning and value ranges of key fields.
   - **Special-value semantics**: what null / empty / N-A each means.
   - **Inter-table relations**: which keys join which tables.

**Gate**: without at least one formula or field definition extracted from
documentation, do not proceed to Step 2.

## Step 2: Load the raw data

1. Load each original file with pandas in `run_python` (`pd.read_csv` /
   `pd.read_excel` / `json.load` on the real paths from Step 1) — not from
   rendered excerpts, which may be truncated.
2. Integrity check per file: print the shape, the per-column null counts,
   and a five-row preview.

## Step 3: Compute precisely

1. **Formulas**: implement in code exactly what the documentation states.
2. **Filters**: derive conditions from the question plus the documented
   field semantics. Handle nulls per their confirmed meaning — a null that
   means "applies to all values" must be an explicit OR-branch in the mask.
   With several conditions, list them first and confirm the AND/OR
   structure before coding.
3. **Joins**: after every join, print the row count and compare it with the
   pre-join counts — a silent Cartesian product is the classic failure.
4. **Verify**: magnitude-check the result; compare filtered row counts with
   a hand estimate; compute the headline figure a second, independent way
   (e.g. mean vs sum/count) and require agreement.

## Step 4: Match the output format

1. Match the question's requested precision, units, and percent/absolute
   form.
2. Annotate the source file(s) behind every figure.
3. State the filters and null handling alongside the answer.

## Pitfall checklist

| Pitfall | Correct move |
|---|---|
| Skipping docs to analyze data directly | Step 1 is gated — read the manual first |
| Guessing the formula | Extract the stated formula from the docs |
| Dropping nulls by default | Confirm null semantics, then decide |
| Computing over rendered excerpts | Load the original file in `run_python` |
| Mental arithmetic | All computation in code |
| Percent / basis-point / per-mille confusion | Confirm the unit in the docs; mind the divisor |
| Join producing a Cartesian product | Print and check row counts after every join |

## Evidence, markers, and language

- Attribution discipline (full rules in the evidence-discipline skill): for
  claims grounded in ingested documents, copy anchorIds verbatim from
  `kb_search`/`kb_expand` results and run `verify_citation` on any quote
  before presenting it as verbatim; distinguish "found in the KB" from
  "not seen in-KB".
- Tag statements that go beyond tool results: `[inference]` for reasoned
  conclusions, `[prediction]` for extrapolations, `[needs-verification]`
  for unconfirmed claims.
- On load-bearing conclusions add a confidence tag: `[high]` (documented
  formula + double-verified computation), `[medium]`, `[low]` (assumed
  semantics).
- Respond in the user's language.

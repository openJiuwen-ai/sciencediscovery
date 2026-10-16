---
name: table-analysis
description: Use this skill for deep analysis of a single structured table — a CSV, Excel sheet, or similar dataset in the workspace — especially when manuals, READMEs, or data dictionaries exist alongside it. Enforces documentation-first reading, code-based computation over raw data, null-semantics confirmation, and magnitude checks on results.
---

# Table Analysis (single-table deep dive)

Core principles, in order of importance:

1. **Documentation first**: if manuals, READMEs, or data dictionaries
   exist, read them before touching the data — field meanings, calculation
   rules, and special-value semantics cannot be inferred from the data
   itself.
2. **Raw precision**: compute over the original data file with code, not
   over rendered or excerpted views that may be truncated or re-formatted.
3. **Tool computation**: every numeric operation runs in `run_python` —
   never mental arithmetic, never hand-transcribed intermediate values.
4. **Null semantics confirmed**: the meaning of null/empty values comes
   from the documentation. A classic trap: null meaning "applies to all
   values" rather than "no value" — filtering such rows out inverts the
   answer.

## Step 1: Locate the table and its documentation

- `list_files` for workspace data files; `kb_search` /
  `list_knowledge_bases` for ingested material and companion documents.
- Identify both the data files and the explanatory documents (manuals,
  READMEs, data dictionaries) — and read the explanatory ones first,
  extracting calculation formulas, field definitions, and special-value
  semantics.

## Step 2: Profile the data

- Load the file with pandas in `run_python` (`pd.read_csv` /
  `pd.read_excel` on the path from `list_files`).
- Print the shape (rows × columns), the first rows, and the per-column null
  counts. Tables over ~1000 rows must be processed in code end to end —
  never by scrolling excerpts.

## Step 3: Analyze

- Apply the formulas and rules taken from the documentation — do not guess
  a formula from the data's shape.
- Define filter conditions from the documented field semantics; handle
  nulls per the confirmed meaning (e.g. a null that means "applies to all"
  belongs in the filter as an explicit OR-branch).
- Cross-check: verify filtered row counts against a hand estimate, and
  compute the headline result a second way when one exists.
- Sanity-check the magnitude of every result.

## Output requirements

- The analytical conclusion, stated directly.
- Key data points, each annotated with its source file (and sheet, for
  multi-sheet workbooks).
- The calculation steps when a computation produced the answer.
- The filter conditions used and how null values were treated — this is
  part of the answer's contract, not a footnote.

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
  formula + verified computation), `[medium]`, `[low]` (assumed semantics).
- Respond in the user's language.

---
name: chunked-analysis
description: Use this skill when a document corpus is too large to analyze in one pass — dozens of files needing complete batch coverage without omissions or context overflow. Provides the explore, group (5-15 documents per group), analyze-per-group, synthesize methodology, with intermediate results saved to workspace files as each group finishes.
---

# Chunked Analysis (group-wise corpus coverage)

Proceed as **explore → group → analyze each group → synthesize**.
Core discipline: the corpus is covered group by group, and every group's
findings are saved to disk before the next group starts.

## Stage 1: Explore

- `list_knowledge_bases` to find the corpus, then `kb_search` with broad
  queries (and `list_files` for workspace file collections) to learn the
  inventory: how many documents, of which types, on which topics.
- Base the grouping on what the inventory actually shows, not on the
  question's wording alone.

## Stage 2: Group

- Partition the documents into groups of 5–15: by type, directory, topic,
  or search-result cluster.
- Slight overlap between groups is acceptable when a document is central to
  two themes — but no document may fall outside every group.
- Record the grouping in a workspace file (via `run_python`) and track
  progress with `research_state` (one plan item per group).

## Stage 3: Analyze each group

For each group, in order:

1. Retrieve the group's key content: `kb_search` / `doc_grep` to locate
   passages, `kb_expand` to read the relevant blocks in full context.
2. Write the group's findings as a titled section with its own standalone
   conclusions, citing the documents (and anchorIds where available).
3. Save the section to a workspace file (via `run_python`) immediately —
   do not carry analyzed content in context alone; that is how groups get
   silently dropped.

## Stage 4: Synthesize

- Read back the saved group sections (`read_file`) and compose the final
  report: per-group sections keep their own conclusions, followed by a
  cross-group section with combined findings, contrasts between groups, and
  an overall conclusion.
- Deliver the report as a workspace artifact (`declare_artifact`) and give
  the headline findings in the final answer.

## Output requirements

- Every group section has an explicit title and independent conclusions.
- The final report contains genuine cross-group synthesis — combined
  findings and comparisons — not a concatenation of group summaries.
- Every factual claim cites the document (and anchorId where one exists)
  it came from.

## Evidence, markers, and language

- Attribution discipline (full rules in the evidence-discipline skill): copy
  anchorIds verbatim from `kb_search`/`kb_expand` results — never construct
  or abbreviate one; run `verify_citation` on any quote before presenting it
  as verbatim; always distinguish "supported by in-KB evidence" from
  "not seen in-KB".
- Tag statements that go beyond tool results: `[inference]` for reasoned
  conclusions, `[prediction]` for extrapolations, `[needs-verification]` for
  unconfirmed claims.
- On load-bearing conclusions add a confidence tag: `[high]` (multiple
  agreeing sources), `[medium]` (limited sources, sound logic), `[low]`
  (single source or inferred).
- Respond in the user's language.

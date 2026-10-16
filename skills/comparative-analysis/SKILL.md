---
name: comparative-analysis
description: Use this skill when the user asks to compare or contrast documents, methods, products, viewpoints, or datasets — "compare A and B", "differences between", "pros and cons across". Provides multi-angle comparison dimensions, table-first presentation, and per-difference source attribution with no empty verdicts.
---

# Comparative Analysis (structured multi-angle comparison)

Proceed as **collect → read → compare along dimensions → tabulate**.
Core discipline: every stated difference carries its source; every
conclusion rests on specifics, never on impression.

## Stage 1: Collect the comparison targets

- `kb_search` to locate the documents or passages covering each target;
  `list_knowledge_bases` first when the KB layout is unknown.
- `web_search` + `web_fetch` when a target's coverage lives outside the KB.
- If the user did not enumerate the targets, derive the candidate set from
  retrieval results and state the inclusion rule you used.

## Stage 2: Read the material

- `kb_expand` the relevant anchors to read the full blocks in context —
  comparing from snippets manufactures false symmetry.
- Read each target to comparable depth; an asymmetric read produces
  asymmetric conclusions that reflect your effort, not the targets.

## Stage 3: Compare along dimensions

Compare from multiple angles, typically:

1. Core positions / claims — where they agree and differ.
2. Data and facts — numbers, dates, measurements, side by side with units.
3. Conclusions and recommendations — what each target ultimately advocates.
4. Overall assessment — strengths and limits grounded in the above.

- Add dimensions the material itself suggests (method, scope, era,
  assumptions); drop dimensions where all targets are identical, and say so
  in one line rather than tabulating sameness.

## Stage 4: Present

- Lead with a Markdown comparison table: one row per dimension, one column
  per target.
- After the table, discuss the differences that matter — why they exist and
  what follows from them.
- Attach the source (document name, and anchorId where one exists) to every
  difference point; a difference without a source is an opinion — label it
  `[inference]` or drop it.
- Let target complexity set the depth: two similar short texts need a
  compact table; many rich targets need per-dimension sections.

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

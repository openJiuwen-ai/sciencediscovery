---
name: deep-research
description: Use this skill when the user asks for in-depth research, investigation, competitive analysis, technology assessment, market research, or any open question that needs multi-angle information gathering and synthesis across the knowledge base and the web. Provides the plan, broad-search, deep-fetch, cross-validate, synthesize methodology with adaptive output depth. For KB-centric evidence synthesis with per-claim provenance, see systematic-review.
---

# Deep Research (general-purpose research methodology)

Proceed as **plan → broad search → deep fetch → cross-validate → synthesize**.
Core discipline: search before you write, read before you cite, and verify
the load-bearing claims from more than one source.

## Stage 1: Plan

- Analyze the research question and decompose it into sub-questions along
  distinct dimensions (entities, time span, geography, mechanism, market, …).
- Decide the retrieval strategy per sub-question: knowledge base, web, or both.
- For anything beyond a short sitting, pin the plan with `research_state`
  (set-goal, plan-add) so it survives context compaction.

## Stage 2: Broad search

- Search every sub-question from several keyword angles — synonyms, broader
  and narrower phrasings, entity names plus relation terms.
- In the knowledge base: `list_knowledge_bases` first to discover kbIds,
  then `kb_search` with a generous topK; with an entity graph,
  `concept_explore` the core entities for neighbors you had not named.
- On the web: `web_search`, then follow the most promising hits with
  `web_fetch` rather than relying on snippets.

## Stage 3: Deep fetch

- `kb_expand` the anchorIds of key hits to read the full blocks in context —
  a search snippet is not reading.
- `doc_grep` for exact patterns (measurements, identifiers, variant
  spellings) across the corpus fulltexts.
- `web_fetch` the primary pages behind search results; chase citation and
  link chains until the trail answers or ends.

## Stage 4: Cross-validate

- Confirm key data points and conclusions from at least two independent
  sources; when sources disagree, present both and analyze why.
- Record findings as they arrive (`evidence_ledger(add)` with claim + quote)
  so nothing is lost across turns; for long evidence-heavy runs, see the
  evidence-notes skill.

## Stage 5: Synthesize

- Integrate everything into one coherent analysis: conclusions first,
  evidence after, conflicting sources side by side — never silently
  reconciled.
- Use Markdown tables for comparisons and quantitative summaries; prefer
  concrete figures, percentages, amounts, and dates over vague quantifiers.

## Adaptive depth

- Let question complexity and discovered information set the depth: simple
  questions get concise answers, complex ones get full treatment.
- Expand a finding when it opens a question the user cares about; stop when
  further retrieval adds nothing new. Never pad to reach a length, and never
  compress where detail is needed.

## Persistence

- A report the user should keep: write it to the workspace (via
  `run_python`) and `declare_artifact` it so it appears in the artifacts
  panel; give the path in the final answer.

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

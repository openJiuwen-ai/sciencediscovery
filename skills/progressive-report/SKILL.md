---
name: progressive-report
description: Use this skill when building an analysis report over tens to hundreds of documents, where loading everything at once would overflow context and lose detail. Provides the light-first, write-as-you-go, revise-afterwards incremental methodology — overview and outline, chapter-by-chapter analysis with on-demand expansion, cross-check pass, final delivery. For small tasks, work directly instead.
---

# Progressive Report (incremental analysis over large document sets)

Context is finite; a large corpus is not. The counter-strategy is **light
first, heavy on demand, write as you go, revise later** — no stage depends
on holding the whole corpus in context. This methodology matters when the
document count is large or the analysis dimensions are complex; simple
tasks should just be done directly.

## Phase 0: Overview and plan

1. Inventory the corpus: `list_knowledge_bases`, then `kb_search` with
   broad queries (and `list_files` for workspace collections) — document
   titles, types, and rough topics are enough for routing.
2. Plan the report outline and analysis dimensions; map documents to
   dimensions and mark the core documents that need deep reading.
3. Save the outline to a workspace file (via `run_python`) and pin the plan
   with `research_state` (set-goal, plan-add).

## Phase 1: Chapter by chapter

For each outline section:

1. **Expand on demand**: retrieve only this section's documents —
   `kb_search` / `doc_grep` to locate, `kb_expand` to read the blocks that
   matter. Do not bulk-expand the corpus "for later".
2. **Write the section** from what you just read.
3. **Save immediately**: append the section to the report file in the
   workspace (via `run_python`) — saved text is safe; context is not.
4. Move to the next section.

Independent dimensions may be delegated to sub-agents (`task`) — each has
its own context window. Give each sub-agent the same discipline: expand on
demand, analyze, save as you go, return only its findings summary and file
path.

## Phase 2: Cross-check and revise

1. `read_file` the full saved report.
2. Check inter-section logic: consistent terminology, no contradictory
   numbers or claims, no dimension left uncovered against the Phase 0 plan.
3. Revise in place (via `run_python`); sections that cite each other must
   agree.

## Phase 3: Deliver

1. Format self-check against the outline and the user's requirements.
2. `declare_artifact` the report; summarize the headline findings and the
   artifact path in the final answer.

## Context management rules

- Expand on demand; never pre-load more than the current section needs.
- Save results the moment they exist; re-read (`read_file`) instead of
  remembering.
- If context was compacted mid-task, resume by re-reading the saved report
  file and the `research_state` summary, then continue from the first
  unsaved section.

## Citation and quality bar

- Every factual statement carries a source: document name, plus the
  anchorId copied verbatim from the `kb_search`/`kb_expand` result where
  one exists.
- Distinguish what was read from documents from what was inferred; numbers
  match the source exactly, never approximated.
- Contradictions and gaps found in the corpus are disclosed, not smoothed
  over; coverage follows the plan — nothing the user asked for is missing.

## Evidence, markers, and language

- Attribution discipline (full rules in the evidence-discipline skill):
  never construct or abbreviate an anchorId; run `verify_citation` on any
  quote before presenting it as verbatim; distinguish "supported by in-KB
  evidence" from "not seen in-KB".
- Tag statements that go beyond tool results: `[inference]` for reasoned
  conclusions, `[prediction]` for extrapolations, `[needs-verification]`
  for unconfirmed claims.
- On load-bearing conclusions add a confidence tag: `[high]` (multiple
  agreeing sources), `[medium]`, `[low]` (single source or inferred).
- Respond in the user's language.

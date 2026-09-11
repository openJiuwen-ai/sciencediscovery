---
name: long-form-writing
description: Use this skill for long documents — novels, lengthy reports, specifications, theses — where cross-part consistency is the main risk and a single pass cannot hold the whole work. Provides the entity-registry ground truth, serial chapter pipeline with state-card relay, measured-length verification, merge-stage repetition self-audit, and pre-delivery global consistency regression. For research-report structure and scientific deliverables, see report-writer.
---

# Long-Form Writing (consistency-first serial pipeline)

Core principles:

- **Serial pipeline, not parallel**: chapters may be drafted by sub-agents
  (`task`), but chapter N+1 starts only after chapter N is complete.
- **The registry is ground truth**: one entity-state file
  (`story_bible.json` for narrative work, `entity_registry.json` otherwise)
  is read-only reference for every chapter; nothing may contradict it.
- **State cards are the relay baton**: each chapter emits a state card; the next chapter must receive and honor it.
- **Length is measured, never claimed**: verify with `wc` (via `run_shell`); prefaces, TOCs, and appendices never count as body text.

## Step 0: Registry + outline (mandatory)

Extract every entity from the requirements into one JSON workspace file
(via `run_python`). An "entity" is anything nameable whose state can
change: characters, organizations, items, locations (narrative, plus world
rules/timeline/power system for fiction); projects, products, metrics with
stage/version/validity (expository); parties, clauses, evidence (legal).
Each entity gets canonical name, aliases, type, current state, state
history — updated immediately at every transition. Then the full outline:
per-chapter heading, intended content, minimum length, cross-chapter
references. Track chapters with `research_state`.

## Step 1: Draft chapters serially

Per chapter (delegated via `task` or written directly):

- Input: chapter spec + previous chapter's state card + registry contents.
- Save the chapter to its own workspace file immediately (via `run_python`).
- Verify before accepting: `wc -m` meets the minimum length; entity names
  and aliases match the registry (grep via `run_shell`). A failing chapter
  is fixed or rewritten, never accepted.
- Emit the state card JSON: chapter number, measured length, entities on
  stage, key events, foreshadowing created/resolved, state changes
  (entity, from, to, reason).

## Step 2: Merge — highest spam-risk stage

Merge chapters in order, with TOC and cross-references, into one file.
Historical failure mode: merge/polish introduced *new* repetition
templates (recurring lyrical passages, templated intros) that look refined
but compound across chapters. Forbidden during merge: copying another
chapter's paragraph in as polish; fixed "template passages" reused across chapters (once per chapter × N = N instances of padding); polished-looking zero-information phrasing; scripted bulk insertion of identical openers.

## Step 2.5: Post-merge repetition self-audit (mandatory)

Scan the merged file (via `run_shell` / `run_python`): short-line duplicate
counts (`sort | uniq -c | sort -rn`) plus a sliding 3-line-block scan. Judge with the spam-vs-refrain ladder:

| Repetition | Verdict | Action |
|---|---|---|
| Long block (≥50 chars) verbatim ≥3 times | spam | delete all but first |
| Long block (≥50 chars) twice, cross-chapter | suspicious | inspect; delete if jarring |
| Mid block (20-50 chars) ≥5 times, clustered | spam suspect | delete |
| Mid block (20-50 chars) ≥5 times, evenly spread | possible refrain | keep, log it |
| Short line (<20 chars) ≥10 times | artistic motif | keep unless blatant |

Refrain exemptions (never delete): proper nouns/terms/identifiers, theme
mottos/quotes, dialogue responses, onomatopoeia, ceremonial or spec-format
text, section openers used 1-2 times. Unsure? Keep, flag as "suspect
refrain" for the long-form-audit skill.

## Step 3: Global consistency regression (mandatory)

1. Per major entity: grep all mentions, classify each (current / historical
   / example / planned); no time oscillation; no terminated entity in
   "current" mode.
2. Per first-defined concept: grep for a second "first definition" — the
   signature of spliced drafts.
3. Per key passage: similarity-scan against the rest — a full retelling
   appears once; later references are brief callbacks.

Fix every finding before delivering.

## Step 4: Final length audit and delivery

- `wc -m` every chapter and the merged file (merged ≥ sum of parts) vs the
  requested total; deviation >5%: write the missing content, do not finish.
- `declare_artifact` the final document; quantitative claims in the
  delivery summary (lengths, chapter/table counts) must be measured numbers.
- Before finishing, run the long-form-audit skill's checks over the merged document; fix any Critical finding first.

## Evidence, markers, and language

- Source-grounded factual content follows the evidence-discipline skill:
  anchorIds copied verbatim, `verify_citation` before verbatim quotes,
  in-KB vs not-seen-in-KB distinguished.
- Tag statements beyond sources: `[inference]`, `[prediction]`,
  `[needs-verification]`; confidence `[high]`/`[medium]`/`[low]` on key
  claims. Canonical names come from the registry.
- Respond in the user's language; when continuing an existing document,
  follow that document's language.
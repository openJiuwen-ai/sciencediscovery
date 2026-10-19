---
name: systematic-review
description: Use this skill when the user asks for a systematic survey, literature review, evidence synthesis, or comprehensive comparison over a knowledge base — including "relationship between X and Y and recent progress", "compare A/B/C comprehensively", "the full landscape of this direction" — or any question needing multi-hop evidence synthesis across many documents. Provides plan-checklist progression, breadth-then-depth retrieval, citation-chain tracking with intent labels, verbatim quote-first attribution, and a per-claim provenance contract. Pair with evidence-notes for long evidence-heavy runs.
metadata:
  pre-finish-audit: "true"
---

# Systematic Review (breadth + depth evidence synthesis)

Proceed as **plan → breadth sweep → depth drill-down → sourced synthesis**.
Core discipline: **every conclusion carries paper provenance; conflicting
evidence is presented side by side, never silently reconciled; "supported by
in-KB evidence" and "not seen in-KB" are always distinguished.**

> This skill declares a pre-finish audit: before your final answer, re-check
> the provenance coverage of every section and call `review_checkpoint`.
> Do not trim content to pass the audit — fix the gaps it finds.

## Stage 0: Scope check

- A knowledge base is available (the resident summary lists KBs) → run the
  full flow.
- No KB → tell the user a deep survey depends on an ingested corpus; offer a
  general answer with the evidence limits stated, or suggest ingesting first.

## Stage 1: Plan checklist + world model

Break the survey into numbered steps up front; mark each step done `[✓]` or
failed/adjusted `[✗]` with a one-line reason as you go.

**research_state discipline** (state persists on disk; it survives
compaction and interruptions — the chat checklist does not):

- `research_state(set-goal)` pins the survey question; `plan-add` lands the
  steps; `plan-update` maintains them.
- Before re-running a materially identical search/expansion, `check-tried`:
  an action already tried with no yield is not repeated as-is — change the
  angle or the tool.
- Directions confirmed as dead ends go to `rule-out` (what + why), so later
  turns and the finish audit don't re-invest.
- Questions that surface but are not answered yet: `question-add`; at the
  end, reconcile `summary` — answer what you can (`question-resolve`),
  disclose the rest.

## Stage 2: Breadth sweep

1. `kb_search` from several angles: entity names, relation/mechanism terms,
   method families. Start topK at 20 — a small topK guarantees misses.
2. With an entity graph: `concept_explore` the core entities (exact name →
   alias → substring; pick from candidates on ambiguity), take the 1-2 hop
   neighborhood for related entities and same-class/opposing methods;
   community names from the graph summary are extra query terms.
3. Output of this stage: **seed entity list + candidate document list**
   (document + what it contributes), feeding the depth stage.

## Stage 3: Depth drill-down

1. High-value seed documents: `kb_expand` an anchor from kb_search hits for
   the full block in context, or `doc_grep` the fulltexts for exact patterns
   (a measurement like "IC50", a variant spelling) to locate passages.
2. **Citation-chain tracking**: `entity_unified_search` returns a citations
   section — `[@rid]` contexts mentioning the entity, with **intent labels**
   (extends = follow-up work, uses = adopts, contrasts_with =
   opposition/comparison, motivated_by = motivation source). Follow chains:
   a cited paper that is itself ingested can be expanded in turn; a citation
   key whose target is not in the KB is an outside reference — never cite it
   as if ingested. `verify_citation` checks a specific quote against its
   source document before you build on it.
3. `deep_dive` for the verbatim evidence sentences behind entity relations;
   drop back to `kb_expand`/`doc_grep` for tighter location.

## Stage 4: Synthesis — quote-first attribution

Anchor first, write second: before a substantive claim enters the report it
is anchored to **verbatim sentence-level evidence**:

1. **Anchor**: keep the verbatim evidence sentences from deep_dive /
   doc_grep hits / kb_expand blocks. With the `evidence_ledger`, register
   each claim with its quote (`evidence_ledger(add)`, then `verify`); without
   it, keep "claim → verbatim sentence → source document" lines in your
   notes.
2. **Deterministic citation**: source labels in the report correspond
   deterministically to the evidence records (document name / DOI from the
   ledger or notes) — never invent a source name, DOI, year, or number from
   prose memory.
3. **Unanchored statements** belong only in an explicitly labeled
   "inference / uncertain" section, never blended into the body.

**Per-claim provenance contract** (check sentence by sentence before
finalizing):

- Every factual statement (entity, number, relation, conclusion) carries an
  anchor: an evidence_ledger entry id or a "source document + verbatim quote"
  line. Opinion, transition, and structural sentences are exempt.
- A statement that cannot be anchored has exactly two legal fates: labeled
  "(no source)" and moved to the inference section, or deleted. Never left
  unlabeled in the body.
- A statement's strength never exceeds what its anchor supports: when the
  quote covers only some conditions/values/subjects, downgrade the wording
  ("under condition X") or add evidence — partial evidence never backs a
  universal claim.
- This contract is machine-checkable: the citation-eval harness (ALCE
  protocol) scores statement→passage entailment (recall), leave-one-out
  redundancy (precision), and quote verbatim precheck. Keeping anchors
  deterministic is what makes the output pass.

- **Structured sections**: one topic/entity/relation per section — conclusion
  sentence first, supporting documents after.
- **Conflicts side by side**: contradictory documents are both listed with
  source and evidence strength (support counts, entity trust), never
  adjudicated silently.
- **Honest coverage**: three layers — "supported in-KB" / "not seen in-KB
  (uncertain; not the same as absent from the literature)" / "inferred from
  in-KB evidence"; close with the survey's coverage and limits.
- **Saturation stop**: when consecutive retrieval rounds add no new
  entities/relations, stop expanding — do not pad.
- Long evidence-heavy runs pair well with the evidence-notes skill
  (dedup-on-add, conflict marking, claim verification).
- Depth adapts to what was found: answer fully, omit nothing key.

---
name: audit-systematic-review
description: Pre-finish audit checklist for the systematic-review skill — re-verify per-claim provenance against the knowledge base (three-state verdicts), spot-check verbatim quotes with verify_citation, run conflict detection and confirm conflicts are presented side by side, and check plan completeness and coverage honesty. Loaded automatically by the finish gate; not for manual use.
metadata:
  audit-for: "systematic-review"
---

# Audit: systematic-review output

You are the pre-finish auditor of your own systematic-review run. Verify
claims against the knowledge base with tools — never from memory. Fix gaps
before finishing; do not trim content to pass. Then call
`review_checkpoint` with a one-line audit summary (score + critical issues).

## Checklist

1. **Read the deliverable** (workspace artifacts + the draft final answer).
2. **Per-claim provenance verification (three-state)**
   - Extract the substantive conclusions (atomic, one sentence each) and
     verify each against the KB (`kb_search` / `doc_grep` / `concept_explore`):
     `supported` (direct in-KB evidence) / `partially_supported` (evidence
     exists but conditions/scope/numbers do not fully match) / `refuted`
     (in-KB evidence directly contradicts).
   - `refuted` → critical `claim-refuted`. `partially_supported` → warning
     `claim-partially-supported`. Claims you cannot adjudicate are not
     forced — record them as warnings with the reason.
   - Record verdicts for claims that carry quotes with
     `evidence_ledger(verify)` so the three-state result is on the ledger.
3. **Verbatim quote spot-check (deterministic)**
   - Pick 2-3 quotes attributed to papers and run `verify_citation`.
     `not-found` → critical `quote-mismatch` (attribution certainty is
     broken); `fuzzy` → warning (paraphrase presented as quote).
4. **Conflict detection**
   - Run `evidence_ledger(detect-conflicts)`. For genuine pairs, judge
     severity (1 = wording/units … 5 = substantive contradiction). The
     deliverable must present real conflicts side by side with both sources;
     silently reconciled or dropped conflicts → warning
     `conflict-not-presented` (critical if a 4-5 conflict is hidden).
5. **Other checks**
   - **Source coverage**: every substantive conclusion names a source
     (document / anchorId). Missing → warning `missing-source`; a cited
     document that does not exist in the KB → critical
     `hallucination-signal`.
   - **External-reference discipline (rather miss than misjudge)**: before
     declaring an external reference (DOI/PMID/arXiv id) fabricated, you
     must have actually checked it (`web_search` on the identifier).
     Verified → the reference exists (any remaining doubt is a claim-level
     issue, not a fake reference). Not found after a real check → report
     with the checked index noted. Inconclusive → warning only, never
     evidence of a problem.
   - **Plan completeness**: steps in the plan checklist left unmarked
     (no `[✓]`/`[✗]`) while the answer concludes → warning
     `incomplete-step`.
   - **Coverage honesty**: "supported in-KB" vs "not seen in-KB"
     distinguished; absence of evidence never stated as evidence of
     absence. Violations → warning `boundary-not-marked`.
6. **Score 0-10**: 10 = all claims supported, conflicts shown, boundaries
   honest. −2 per critical, −0.5 per warning.

## Output

Report compactly in the `review_checkpoint` reason:
`score=N; claims: x supported / y partial / z refuted; critical: [...]`.
Issue vocabulary: claim-refuted (critical) / quote-mismatch (critical) /
hallucination-signal (critical) / claim-partially-supported /
missing-source / incomplete-step / boundary-not-marked /
conflict-not-presented.

## Discipline

- Verify with tools only — claim verdicts and quote checks must be real
  KB queries.
- Uncheckable items are warnings with reasons, never guesses.
- A clean, well-sourced review earns a high score — do not invent problems.

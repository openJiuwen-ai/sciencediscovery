---
name: evidence-notes
description: Use this skill for long multi-evidence tasks (systematic reviews, multi-target analyses, debate preparation, cross-document verification) where findings must be tracked across turns without loss, duplication, or unnoticed contradiction. Provides the evidence-ledger discipline — record each finding with its backing source, re-verify key claims, detect conflicts — and final delivery as an auditable evidence list. Can standalone or pair with systematic-review-style research skills.
---

# Evidence Notes (task-level evidence working memory)

In long research tasks, evidence scattered across conversation turns gets
lost, duplicated, or silently self-contradicted. This skill is a discipline:
**record findings into the `evidence_ledger` as they arrive** (session-local
persistent audit trail), **re-verify the load-bearing claims before relying
on them**, and **deliver a written evidence list** at the end.

> Every step should involve tool calls (search, ledger, file reads), except
> the truly final wrap-up.

## Entry discipline

One evidence item = one `evidence_ledger(add)` call:

- **claim**: the one-sentence finding, with key numbers and context (method /
  model / conditions inside the claim text); short and specific.
- **quote / docId / anchorId / kbId**: the backing passage — a verbatim quote
  (never paraphrased into the quote field) plus its document/anchor when
  available. **Sources must come from actual retrieval results, never from
  memory.** Speculation without a source does not enter the ledger — put it
  in the "inferences" section of the final output instead. A claim recorded
  without a backing quote carries no evidence anchor and `verify` will skip
  it — that absence is audit-visible, so never back-fill fake sources.

Rules:
- Before adding, `evidence_ledger(query)` with a distinctive substring to
  check for an existing entry on the same finding; extend your records
  rather than duplicating near-identical claims.
- Singular/plural or alias differences that clearly name the same object are
  the same finding — query first, then decide.
- One source backing several claims is normal.

## Maintenance rhythm

- The ledger is working memory, not the final report — prose polish is not
  the point.
- Long-task recovery: the ledger persists across turns — resume with
  `evidence_ledger(query)` (no filter) to rebuild context.
- **Key-claim verification**: for claims that support final conclusions,
  `evidence_ledger(verify, kbId)` re-checks recorded quotes against the
  knowledge base and stores three-state verdicts (verbatim / fuzzy /
  not-found). A claim counts as verified only after an actual `verify`
  call. A `fuzzy` verdict means the recorded quote is a paraphrase —
  fix it or downgrade the claim.
- **Conflict patrol**: periodically run `evidence_ledger(detect-conflicts)`
  for heuristic candidate pairs (same claim from different sources, negation
  flips). Candidates are not conclusions: judge each pair's severity
  (1 = wording difference … 5 = substantive contradiction). Real conflicts:
  **keep both entries**, and in the final output present both sides with
  their sources — never silently pick one, never merge away a contradiction.
- Before finishing, self-check: entries lacking a quote/anchor should be 0
  (compute it: `query` with no filter, count entries without quote/anchor)
  or explained in the output; presented conflicts should match the ledger's
  conflict pairs; key claims should carry verification verdicts (unverified
  ones are disclosed).

## Delivery

- At wrap-up, organize the ledger into a markdown list (grouped by
  entity/topic) and save it as `evidence-notes-<topic>.md` in the workspace
  (write via `run_python`), then `declare_artifact` so it appears in the
  artifacts panel; give the path in the final answer.
- Each delivered entry = claim + source + (when verified) the three-state
  verdict and the verbatim quote — quotes stay verbatim, never rewritten.
- Final-answer citations must match ledger entries exactly (same source,
  same numbers) — no self-contradiction; disclose what fraction of key
  entries lack a quote anchor.

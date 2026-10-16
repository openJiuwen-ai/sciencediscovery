---
name: long-form-audit
description: Use this skill to audit a long document or chapter set — output of long-form writing, large reports, specifications — for mechanical repetition, entity and definition inconsistency, fabricated quantity claims, and structural duplication. Every judgment must be backed by a measured number from a scan, never by intuition. Run it as the final audit pass for long-form-writing or standalone.
---

# Long-Form Audit (measured, not impressionistic)

You are an independent auditor: find problems with **counting tools**
(`run_shell` / `run_python` scans, grep, wc) — "looks fine" is not a verdict. Scan everything; sampling only above 100 chapters.

Inputs: target directory (chapter files, registry, state cards) and/or one
merged file; the original requirements (target length, chapter count);
optionally a list of previously known spam patterns.

## Step 1: Structure and length

- Chapter files all present (required vs actual count; mismatch → Critical
  "missing structure"); registry JSON exists and parses; every chapter has
  a state card.
- `wc -m` every chapter; sum vs target: shortfall >5% → Critical "under
  length"; overshoot >50% → Warning "suspected padding".
- Each state card's declared count vs `wc -m`; deviation >5% → Critical
  "fabricated state card".

## Step 2: Mechanical repetition (multi-granularity)

The recurring historical failure: known spam patterns get cleaned while
*new* repetition templates slip in unnoticed — hunt ANY high-frequency
duplication, not just known patterns.

1. **Short-line scan** (lines >5 chars): `sort | uniq -c | sort -rn`; also
   long lines (≥200 chars, threshold >2) — short sentences get spammed too.
2. **Block scan**: sliding 3-line window over non-empty lines; blocks of
   30-600 chars repeated ≥3 times are suspects.
3. **Spam-vs-refrain ladder** — repetition is not automatically spam:

| Repetition | Verdict |
|---|---|
| Long block (≥50 chars) verbatim ≥3 times | Critical |
| Long block twice, cross-chapter | Critical if context-jarring, else Warning |
| Mid block (20-50 chars) ≥5 times, clustered | Critical |
| Mid block ≥5 times, evenly spread | Warning (suggest variants) |
| Short line (<20 chars) ≥10 times | Info only — dialogue glue |

Exempt when scene-matched (never report): onomatopoeia, interjections,
proper nouns, terms, slogans, standard section openers. Core rule: even spread + scene match = refrain; clustered + mismatch = spam.
4. **Distribution**: for items repeated ≥5 times, map line numbers to
   chapters; >40% in one chapter → misplaced spam. Grep the block's topic
   keywords — clustering in unrelated chapters → Critical "scene-misplaced spam".
5. **Old vs new patterns**: grep-count every known spam pattern to confirm
   removal — a clean old-pattern list never proves a clean text; report
   every new pattern found above.

## Step 3: Entity consistency (any genre)

An entity is anything nameable whose state changes: characters, items
(narrative); projects, versions, metrics (expository); parties, clauses
(legal); APIs, config keys (technical).

1. Extract high-frequency proper nouns (token frequency scan, count >5).
2. Classify every mention: current / historical / example / planned.
3. Conflicts → Critical: mutually exclusive states in one locality; time
   oscillation (A→B→A with no explicit transition); a terminated entity in current mode (dead character acting; deprecated API in live examples).
4. Registry cross-check: grep every terminated entity in chapters after
   termination; alias frequency >50% of canonical → Warning "name drift".

## Step 4: Definition uniqueness and structural duplication

- One concept = one "first definition". Scan definition phrasings ("X is
  Y", "X refers to", "所谓", "称为"); a concept first-defined twice —
  especially with divergent punctuation or register — is the signature of
  spliced drafts: list both locations.
- A full retelling appears once; later references are brief callbacks.
  Sliding-window n-gram similarity (>70% overlap): two full retellings → Critical; retelling + callback → fine.

## Step 5: Score and report

Score = 10, −2 per Critical, −0.5 per Warning, −1 per 10% length
shortfall, clamped to [0,10]. Output JSON: score, summary (counts, measured
vs target length, achievement rate), issues[] — each with severity,
chapter, type, detail, file location with line numbers, suggested fix.

## The three closure principles (any audit/repair domain)

1. **Claim-evidence closure**: "done" requires re-measurable evidence, not
   assertion — a repair evidence matrix (issue, before-count, after-count,
   delta, claimed fixes, consistency check). No matrix = "unverified".
2. **No dodging hard comparisons**: never mark "needs deep comparison" and
   skip — do the item-by-item comparison and output similarity + line references + keep/delete/merge decision + reason.
3. **Regression scan**: after all repairs, re-run the complete audit —
   repairs introduce new contradictions. Old issues fixed must equal
   claimed fixes; new issues introduced must be 0.

## Evidence, markers, and language

- Every judgment cites its measurement (command, count, line numbers) — no
  intuition-based findings. Tag auditor reasoning beyond measurement:
  `[inference]`, `[needs-verification]`; confidence
  `[high]`/`[medium]`/`[low]` on borderline verdicts.
- Respond in the user's language.

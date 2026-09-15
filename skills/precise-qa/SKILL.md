---
name: precise-qa
description: Use this skill for factual questions that demand an exact answer — a number, name, date, list, ranking, or count — where an approximate or misformatted answer is a failure. Provides the understand, multi-source-search, precise-extract, cross-validate, format-match, re-check discipline, including unit and magnitude traps, extraction rules for tables and names, and the minimum-search-strategy rule.
---

# Precise QA (exact-answer discipline for factual questions)

Never answer from memory. Proceed as **understand → search → extract →
verify → match format → re-check**.

## Step 1: Understand the question

Pin down, in writing, before searching:

- Required answer format: number, name, list, date? Exact value or
  approximation? Decimal places?
- **Unit requirement**: "how many thousand hours" wants the count in
  thousands (17), not the raw figure (17000). Check whether the unit word
  in the question is part of the expected answer's scale.
- Scope constraints: time range, geography, category.
- For multi-step questions ("find X → use X to find Y → compute Z"), lay
  out the full reasoning chain with the input and expected output of each
  step, then execute step by step. Record each intermediate result; if a
  step fails, back up one step and try a different method — do not abandon
  the chain.

## Step 2: Multi-source search

- Use precise keywords, not broad ones: include the distinguishing terms
  (year, team, statistic name) in the query itself.
- Tools: `web_search` for breadth, `web_fetch` for full page content,
  `kb_search`/`doc_grep` when the answer may live in the knowledge base.
- **At least five distinct search strategies before giving up**: exact
  keywords, synonyms, broader/narrower scope, a different tool, indirect
  information (discussions, reviews, analyses that cite the fact), quoted
  exact phrases, a language switch, authoritative sources (official sites,
  academic databases, government publications).
- **Never guess-then-verify**: when you do not know a name or entity, do
  not invent a candidate and search to confirm it. Search so the results
  tell you the answer ("{concept} according to", "{concept} credited to").
- Blocked or dead pages: search for quotations, discussions, and archived
  copies of the content instead of retrying the same URL.

## Step 3: Precise extraction

- **Tables/lists**: read the whole table, not just the first or last row;
  confirm the column header matches the target (walks ≠ hits); for
  "most/highest" questions re-check every row yourself.
- **Numbers**: extract exact figures, never approximate; handle thousand
  separators ("17,000" is seventeen thousand); watch percent vs absolute;
  when several numbers appear together, confirm which one was asked for;
  convert units explicitly (km → m, thousands → units).
- **Names/entities**: quote exactly once the source is confirmed; mind
  similar names, surname/given-name order across cultures, official full
  names of places and institutions.
- **Rankings/counts**: verify item by item; for "the Nth" count from the
  source without skimming; for "largest/smallest" judge only after seeing
  the complete list.

## Step 4: Cross-validate

- Verify key data points against at least two independent sources — search
  the extracted answer itself backwards ("{name} {year} {statistic}").
- Run every calculation with `run_python`; never compute in your head.
  Standard-library Python only — no package installation.
- After extracting a number, sanity-check its order of magnitude against
  the question (a country's population of "17" is almost certainly in
  millions).

## Step 5: Match the requested format

- A number question gets the number (unit and wording per the question).
- A list question gets the complete list, in the requested order.
- A name question gets the name, without padding.
- Respect case and punctuation requirements.

## Step 6: Re-check before answering

- Does the answer address the question's core ask directly?
- Does the format match exactly what was requested?
- Was every extracted data point verified against its source, and every
  key figure confirmed by a second source?
- If anything is uncertain, search once more before finalizing.

## Evidence, markers, and language

- Attribution discipline (full rules in the evidence-discipline skill):
  record where each extracted fact came from (URL or document + anchorId
  copied verbatim from the tool result); run `verify_citation` on any quote
  before presenting it as verbatim; distinguish "found in the KB" from
  "not seen in-KB".
- Tag statements that go beyond tool results: `[inference]` for reasoned
  conclusions, `[prediction]` for extrapolations, `[needs-verification]`
  for unconfirmed claims.
- On load-bearing conclusions add a confidence tag: `[high]` (multiple
  agreeing sources), `[medium]`, `[low]` (single source or inferred).
- Reasonable assumptions are allowed when the question is ambiguous — make
  them explicit; do not stall by asking for clarification you can resolve
  by searching.
- Respond in the user's language.

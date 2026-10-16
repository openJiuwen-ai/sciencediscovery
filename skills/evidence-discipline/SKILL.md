---
name: evidence-discipline
description: Mechanical evidence-handling rules for any knowledge-base-grounded deliverable — the citation three-principles (expand before citing, copy anchorIds verbatim from tool results, never abbreviate UUIDs), what must carry an anchor, and a pre-delivery self-check list. Use whenever a report, review, or answer must attribute claims to ingested documents with zero fabrication tolerance.
---

# Evidence Discipline (zero-fabrication attribution)

Rules for attributing claims to knowledge-base documents. These are
mechanical — each one is checkable by re-reading the deliverable against
the tool results.

## The citation three principles

1. **Expand before citing**: never cite a document you have not actually
   read through tool results (`kb_expand` on the anchor, or the document
   view). A `kb_search` hit alone is a snippet, not reading.
2. **Anchor IDs are copied, never constructed**: an anchorId must be copied
   verbatim from a `kb_search` hit or a `kb_expand` result. Never invent,
   truncate, or "reconstruct" one. The format is
   `{fullDocId}:{blockType}:{index}` — e.g. `…:paragraph:0`,
   `…:heading:2`, `…:table:1`. A bare UUID is NOT an anchor; a bare-UUID
   "anchor" is the signature of a fabricated one.
3. **Full IDs, no abbreviation**: document ids are 36-character UUIDs. An
   8-character prefix in a citation is a fabrication signature.

## Anchor coverage caveat (avoid false judgments)

Anchors exist on structurally parsed documents. Content that exists only as
unparsed fulltext has no anchors — `kb_search` returns no `anchorId` for it.
Judge from the tool result itself: if it carries an anchor, copy it; if not,
cite at document level and say so — and never generalize one anchor-less
document into "this KB has no anchors".

## What must carry provenance

Any factual payload: measurements and numbers (with units), dates,
named entities and their properties, quoted sentences, table figures,
and any "X causes/ inhibits / requires Y" relation. Each gets: the claim,
the verbatim quote where quoting, the document (title + docId), and the
anchorId where one exists. Quotes intended as verbatim must pass
`verify_citation` BEFORE they appear in the deliverable (`fuzzy` =
paraphrase — present it as such, `not-found` = never present it as the
paper's words).

## Forbidden patterns

- Bare-UUID or self-constructed anchors; abbreviated IDs; placeholder text
  (`kb-id`, `doc-uuid`, `...`, brace templates) in the deliverable.
- Citing a document never expanded/read via tools.
- Presenting a paraphrase as a verbatim quote; presenting "not seen in-KB"
  as "does not exist".
- Runtime metadata in the deliverable: internal file paths, session/run
  ids, timestamps of the run, byte/line counts, tool transcripts.
- Invented completeness: "all N documents covered" is only allowed when the
  deliverable itself mechanically proves it (unique document set in the
  deliverable == the claimed scope set, each with at least one real anchor
  or an explicit document-level citation).

## Pre-delivery self-check (run before the final answer)

1. Every factual claim traces to a tool result or artifact — name its
   source; anything untraceable is cut or labeled speculation.
2. Every anchorId in the text appears verbatim in a tool result from this
   run (spot-check at least three).
3. Every verbatim quote passed `verify_citation` = `verbatim`.
4. Machine identifiers (accession numbers, DOIs, gene symbols, codes) match
   the source character-for-character — watch `0/O`, `1/I/l`, `5/S`
   confusion; when unsure, describe instead of transcribing.
5. Numbers keep the source's precision and units — never rounded into
   false precision, never silently converted.
6. Open questions and unresolved conflicts are disclosed, not dropped.
7. Coverage claims are mechanically provable from the deliverable itself.
8. Delivery status is honest: a draft in the workspace is not "delivered"
   until the final answer presents it; partial delivery says what is
   missing and why.

If any item fails, fix it before delivering.

---
name: document-summary
description: Use this skill when the user asks for a summary, abstract, or digest of knowledge-base documents or workspace files — one document or a scoped set. Provides scope determination, key-content reading, and adaptive-length summarization with source attribution and no padding.
---

# Document Summary (scoped, source-attributed)

Proceed as **scope → read → extract → condense**. Core discipline: the
summary covers what was actually read — never imply coverage of pages you
did not open.

## Step 1: Determine the scope

- `kb_search` to find the target documents (plus `list_knowledge_bases`
  when the KB layout is unknown), or `list_files` for workspace files.
- If the user's scope is ambiguous ("that report", "the docs"), resolve it
  from retrieval results and state which documents the summary covers.

## Step 2: Read the key content

- `kb_expand` the central blocks of each target document — a search snippet
  is not reading. `read_file` for workspace files.
- For long documents, cover the skeleton first (headings, abstracts,
  conclusions) and expand the sections that carry the main claims.

## Step 3: Extract

- No more than 5 core points per document — the claims the document itself
  would call its own.
- Preserve key data: figures, dates, names, and definitions that the
  document's conclusions depend on.
- Attach the source (document name, plus anchorId where one exists) to each
  point.

## Step 4: Condense

- Short document → short summary. Long or complex document → layered
  summary: an overall overview, then per-part key points.
- Match depth to the document's length and complexity: full coverage of the
  key information, zero padding, nothing key omitted.
- State the basis honestly: a summary built from headings and abstracts
  says so; "read in full" is claimed only when every part was expanded.

## Output requirements

- Core points (≤5 per document) in clear, plain language.
- Key data preserved with the source's precision and units.
- Every point annotated with its source document.

## Evidence, markers, and language

- Attribution discipline (full rules in the evidence-discipline skill): copy
  anchorIds verbatim from `kb_search`/`kb_expand` results — never construct
  or abbreviate one; run `verify_citation` on any quote before presenting
  it as verbatim; distinguish "found in the KB" from "not seen in-KB".
- A summary compresses, it does not editorialize: judgments about the
  document's quality or implications are tagged `[inference]`.
- Respond in the user's language; summarize in the document's language when
  the user asks for a faithful digest of a foreign-language text.

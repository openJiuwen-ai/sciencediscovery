# Knowledge Engine: subject knowledge graph with a growth loop

## 1. Summary

- **The knowledge engine (KE) builds a subject knowledge graph from the literature** and keeps it growing until convergence: seed search → download chain → provenance-gated extraction → entity resolution → Louvain communities → growth cycles with convergence signals → agent-facing consumption tools.
- **Storage is a self-contained SQLite domain** (`<data-dir>/knowledge-engine/knowledge-engine.sqlite`, WAL) owned by `services/api/src/knowledge-engine/store.ts`, following the RefStore precedent: its own `ke_migrations` version table, never touching the catalog store.
- **Pure domain logic lives in `packages/knowledge-engine`** (zero IO: no fs/network/process): text (trigram, cosine scan, JATS→markdown), extraction (provenance gate, prompts), growth (MMR/AA selection, four convergence signals), graph (explore, gaps, resident summary, Louvain, roots), resolution (layered gates, merge policy, batch helpers), and eval harness cores.
- **Composition lives in `services/api/src/knowledge-engine`**: store, job runner (crash-recoverable persistent queue), connectors (arXiv / Europe PMC(+JATS) / OpenAlex / PubMed / Semantic Scholar / Unpaywall), orchestrator (seed/ingest/extract/grow/resolution jobs), routes, agent-tool port, context contributor.
- **The agent consumes the graph through tools and context**: twelve `knowledgeEngine` workspace tools (`list_knowledge_bases`, `concept_explore`, `deep_dive`, `entity_unified_search`, `validate_entities`, `gap_candidates`, `kb_search`, `kb_expand`, `doc_grep`, `novelty_check`, `verify_citation`, `evidence_ledger`), a resident-summary context contributor that also injects the W9 three-tier anti-hallucination brief (verified / uncertain / forbidden), and two bundled skills (`knowledge-engine-explore`, `knowledge-engine-grow`).

## 2. Data model

| Table | Contents |
| --- | --- |
| `knowledge_bases` | KBs as first-class entities (name, description, engine_state JSON) |
| `ke_documents` | Papers: identity (`dedup_key`), metadata, fulltext, `source_meta` watermarks (`ingested_at`, `extracted_at`, grow channels) |
| `ke_entities` | Entities: `(kb_id, normalized_name, type)` unique; surface-form aliases, embedding BLOB, support_count, trust_level, first_seen_doc, community_id |
| `ke_edges` | Relations with verbatim `evidence_quote` + `evidence_doc_id` provenance |
| `ke_entity_docs` | Distinct-document support detail (merge recount input; support is never a naive sum) |
| `ke_entity_merges` | Resolution audit: online attaches, batch merges with full rollback snapshots, judge rejections, shadow previews |
| `ke_frontier` | Grow frontier: per-cycle candidates with hit-matrix `sources` (Chao1 input), depth, relevance |
| `ke_jobs` | Persistent job queue (all KE work: seed/ingest/extract/grow/resolution) |
| `ke_settings` | Watermarks, graph-roots cache, resolution mode |
| FTS5 | `ke_entities_fts`, `ke_documents_fts` (trigger-maintained) |

## 3. Ingestion pipeline

1. **Seed** (`POST /kbs/:id/seed`): source-chain search → documents upserted → per-doc ingest jobs.
2. **Ingest**: Europe PMC JATS XML when available (structured, parse-free) → else PDF via the download chain → paper worker (pdfplumber) → markdown. Idempotent via `ingested_at`.
3. **Extract**: single-pass LLM entity/relation extraction (biomedical schema), then the **provenance gate** — every relation's evidence quote must verify against the fulltext (normalized substring or ≥85% word overlap) or it is dropped. Entities upsert by normalized name; embeddings backfill best-effort.

## 4. Entity resolution (W4)

Opt-in via `SCIENCE_AGENT_KE_ENTITY_RESOLUTION` or ke_settings `entity_resolution_mode`: `off` (default, byte-identical legacy writes) / `shadow` (decide + audit only) / `on` (merge).

- **Online (write-time)**: layered gates L0 exact → L1 alias → L2 document-internal Schwartz–Hearst abbreviations → L3 embedding (direct merge only above 0.95, same type, non-core target) → L3.5 low-entropy names (≤4 chars) recall via trigram first → L4 budgeted LLM judge over all gray-zone neighbors. **Every layer fails open to "new"**, and the whole decide+attach block falls back to a plain upsert on any failure.
- **Offline (batch job)**: entity-type blocking → dual-channel recall (trigram ∪ embedding cosine) → connected components (oversized trimmed weakest-first) → one LLM cluster-judge call per component → physical merge per equivalence class, iterating while the round merge rate ≥ 10%. Judged pairs (including rejections) are cached so restarts never re-judge; shadow previews don't poison the cache.
- **Physical merge** snapshots everything rollback needs before mutation; edge redirects fold collisions and drop self-loops; support recounts via `ke_entity_docs` (GREATEST — never lowered). `POST /merges/:id/unmerge` restores best-effort.

## 5. Growth loop (W2)

`POST /kbs/:id/grow` starts a cycle: seed watermark → backward/forward citation expansion → per-candidate ranking (embedding cosine + citation prior, depth-dependent relevance floors 0.55/0.65/0.75, MMR λ=0.7 + Adamic/Adar α=0.6 blend, hub boost) → budget-bounded downloads with a doom-loop guard → convergence assessment over four signals (concept saturation, citation coverage, frontier exhaustion, Chao1 boundary with Lincoln–Petersen fallback) persisted to `engine_state`.

## 6. Communities and the graph UI (W4)

- **Deterministic multilevel Louvain** (no randomness; same graph → same partition).
- `GET /kbs/:id/roots` serves a **fingerprint-cached** roots view (entity/edge counts + support sums + latest edge creation). Stale-while-revalidate: a mismatch serves the cached partition immediately and recomputes in the background (per-KB dedup, 60s rate limit). Community names come from one batched LLM call, falling back to the representative entity.
- The web page drills down progressively: community bubbles → members → entity focus, with a breadcrumb.

## 7. Evaluation

| Harness | Command | Mode |
| --- | --- | --- |
| Entity resolution | `node scripts/ke-resolution-eval.mjs [--set pairs.sample\|pairs.realworld] [--trgm]` | in-process; deterministic L0–L2 baseline pinned by test (P=1.0, R=7/12 on the sample set; the P≥0.95/R≥0.60 ship gate targets L3/L4 with a credentialed model) |
| Growth delta-recall | `node scripts/ke-growth-eval.mjs --dataDir <dir> --kb <id> --cutoff <ISO> --query <q>...` | live source chain + embedding env; gap detection / recall@K / negative share |
| Discoverer (honesty) | `node scripts/ke-discoverer-eval.mjs --set gap-hit` | in-process findGaps over inline dataset graphs (packaged baseline: micro hit 12/18) |
| Discoverer (novelty triage) | `node scripts/ke-discoverer-eval.mjs --set novelty-triage --answers <file> [--citation]` | scores pre-collected agent outputs: three-way accuracy + overclaim lexicon + quote precheck + abstention calibration |

## 8. Failure philosophy

Every probabilistic layer (embeddings, LLM extraction/judging/naming) is optional at runtime: outages degrade to deterministic behavior (fail-open to "new" in resolution, representative names in roots, skipped backfill in extraction) and never corrupt the graph — merges are the only destructive operation and they carry full rollback snapshots.

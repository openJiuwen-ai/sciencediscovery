---
name: knowledge-engine-grow
description: Use this skill when the user wants to build, seed, or grow a knowledge base from scientific literature — creating a KB, seeding it with papers for a research topic, running a citation-driven growth cycle, or reading convergence status (concept saturation, citation coverage, frontier exhaustion, Chao1/L-P boundary recall). Not for querying an existing graph (use knowledge-engine-explore).
---

# Knowledge Engine Grow Skill

## Overview

The knowledge engine builds a domain knowledge graph in three stages: seed (search → download → extract), grow (citation-driven BFS over a persistent frontier with MMR diversity + Adamic/Adar coupling admission), and convergence assessment (four deterministic signals).

All crawl decisions are deterministic; the LLM is only used for entity/relation extraction, never for what to download.

## Workflow

1. **Create the KB** (`POST /api/knowledge-engine/kbs` or the UI). Give it a descriptive name — an empty grow query falls back to the KB name + description as the engine query.
2. **Seed** with a focused topic query (5–25 papers). Wait for the ingest/extract jobs to finish.
3. **Grow** one cycle at a time. Default budget is 50 papers / depth 2 / 25 per paper; smaller budgets (10/1/10) are right for a first pass.
4. **Read convergence** from the grow status: converged when ≥3 of 4 signals are met (≥2 of 3 when the boundary dimension is n/a).

## Convergence Signals

- **Concept saturation** — new entities/edges per extraction fell below the novelty floor over the last 20 jobs.
- **Citation coverage** — processed frontier share above 80%.
- **Frontier exhaustion** — nothing pending, or the paper budget ran out.
- **Boundary coverage** — Chao1 capture–recapture estimate over discovery paths; Lincoln–Petersen recall ("L-P x%") stands in when the hit matrix is too sparse.

## Rules

1. **One active cycle per KB.** Starting while one runs reuses the running cycle — check status first.
2. **Rate limits are normal.** Download failures marked failed are usually paywalls (definitive, not retryable); 429s back off per source.
3. **Converged ≠ complete.** Convergence means marginal discovery collapsed under the current query; a re-scoped query or new seed can restart growth.
4. Do not promise entity-level results until extraction has actually run (requires a configured pipeline model).

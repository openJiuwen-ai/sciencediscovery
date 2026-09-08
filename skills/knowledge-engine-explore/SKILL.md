---
name: knowledge-engine-explore
description: Use this skill when a question targets entities, relationships, or evidence inside a knowledge base built by the knowledge engine (e.g. "how does mAb114 relate to Ebola GP", "what contradicts X", "what gaps exist around Y", or verifying whether entity names actually exist before citing them). Covers concept_explore, deep_dive, entity_unified_search, validate_entities, and gap_candidates. Not for building or growing the knowledge base (use knowledge-engine-grow) or for general web literature search (use literature-searcher).
---

# Knowledge Engine Explore Skill

## Overview

The knowledge engine maintains per-KB entity graphs extracted from ingested papers, with a deterministic provenance gate: every relation carries a verbatim evidence quote. This skill turns those graphs into grounded answers.

A resident summary in the working context lists available knowledge bases (id, name, maturity stage). If none appear, no KB exists yet — say so instead of guessing.

## Tool Selection

| Need | Tool | Notes |
|---|---|---|
| Which KBs exist | `list_knowledge_bases` | Returns kbId + stats (entities/edges/documents) |
| Neighborhood of an entity | `concept_explore` | 1-hop default; `hops: 2` expands the strongest neighbors |
| Verbatim evidence for one entity | `deep_dive` | Every edge carries `evidenceQuote` + source document |
| All angles at once | `entity_unified_search` | graph + evidence + documents sections, independent statuses |
| Verify names before citing | `validate_entities` | found / ambiguous (candidates) / unknown per name |
| Research whitespace | `gap_candidates` | holes (≥3 shared neighbors, no edge), conflicts, transfers |

## Rules

1. **Never invent entities.** If `validate_entities` reports `unknown`, the graph does not contain it — present it as absent, not as fact.
2. **Ambiguity returns candidates.** Re-query with the chosen candidate's exact name; do not guess.
3. **Cite evidence.** Every relation claim should carry its `evidenceQuote` and document title from `deep_dive`.
4. **Respect coverage limits.** The graph only contains extracted papers; `truncated: true` means more edges exist — widen `limit`/`maxEdges` before concluding absence.
5. **Gap candidates are structural signals, not confirmed novelty.** A missing edge means "no processed paper states this", never "this is disproven" or "this is novel research".

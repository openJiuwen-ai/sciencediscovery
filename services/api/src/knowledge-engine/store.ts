// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Knowledge-engine SQLite domain store.
 *
 * Self-contained storage following the RefStore precedent
 * (packages/cas/src/versioning.ts): the subsystem owns its own database file
 * under <dataDir>/knowledge-engine/ and never adds tables to the catalog
 * store. Unlike the catalog (JSON-normalize on load, no schema versions),
 * this domain carries a proper `ke_migrations` version table and applies
 * ordered migrations — the discipline the DeepAnalyze knowledge engine
 * relied on across ~40 migrations.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { cosineScan, embeddingFromBlob, trigramSimilarity } from "@sciencediscovery/knowledge-engine";

export interface KnowledgeBaseRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly engineState: unknown;
  readonly createdAt: string;
}

export type KeDocumentStatus = "pending" | "ready" | "error";

export interface KeDocumentRow {
  readonly id: string;
  readonly kbId: string;
  readonly sourceUri: string | null;
  readonly dedupKey: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly year: number | null;
  readonly venue: string | null;
  readonly abstract: string | null;
  readonly fulltext: string | null;
  readonly refIds: readonly string[];
  readonly status: KeDocumentStatus;
  readonly sourceMeta: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KeEntityRow {
  readonly id: string;
  readonly kbId: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly type: string;
  readonly description: string | null;
  readonly aliases: readonly string[];
  readonly embedding: Uint8Array | null;
  readonly supportCount: number;
  readonly trustLevel: string;
  readonly firstSeenDoc: string | null;
  readonly communityId: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KeEdgeRow {
  readonly id: string;
  readonly kbId: string;
  readonly srcId: string;
  readonly dstId: string;
  readonly type: string;
  readonly evidenceQuote: string | null;
  readonly evidenceDocId: string | null;
  readonly supportCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type KeJobStatus = "pending" | "running" | "succeeded" | "failed" | "dead";

/** V2-Z1 community report row. Valid only for the fingerprint it was
 *  generated from; findings is a serialized JSON array of ReportFinding. */
export interface KeCommunityReportRow {
  readonly id: string;
  readonly kbId: string;
  readonly fingerprint: string;
  readonly communityId: number;
  readonly title: string;
  readonly summary: string;
  readonly rating: number | null;
  readonly ratingExplanation: string | null;
  readonly findings: string;
  readonly status: "ready" | "error";
  readonly error: string | null;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KeEntityMergeRow {
  readonly id: string;
  readonly kbId: string;
  readonly canonicalId: string;
  readonly absorbedId: string;
  readonly absorbedSnapshot: Record<string, unknown>;
  readonly decidedBy: string;
  readonly score: number | null;
  readonly judgeRationale: string | null;
  readonly jobId: string | null;
  readonly undoneAt: string | null;
  readonly createdAt: string;
}

/** Metadata recorded on a physical merge or online attach. */
export interface KeMergeMeta {
  readonly decidedBy: string; // 'alias' | 'abbrev' | 'embedding' | 'llm' | 'manual' | 'batch-llm' | 'shadow:*'
  readonly score?: number;
  readonly rationale?: string;
  readonly jobId?: string;
}

export type KeFrontierStatus = "pending" | "done" | "failed" | "skipped";

export interface KeFrontierRow {
  readonly id: string;
  readonly kbId: string;
  readonly cycleId: string;
  readonly paperRef: Record<string, unknown>;
  readonly dedupKey: string;
  readonly depth: number;
  readonly relevanceScore: number | null;
  readonly parentId: string | null;
  readonly source: string;
  readonly sources: readonly string[];
  readonly citeHits: number;
  readonly attempts: number;
  readonly status: KeFrontierStatus;
  readonly expandedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KeJobRow {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly status: KeJobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAfter: string;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** W10 citation-context row (DA citation_contexts). dstDocId links only on
 *  unambiguous (surname, year) resolution — null means cited-but-not-in-KB. */
export interface KeCitationRow {
  readonly id: string;
  readonly kbId: string;
  readonly srcDocId: string;
  readonly dstDocId: string | null;
  readonly dstKey: string;
  readonly sentence: string;
  readonly section: string | null;
  readonly intent: string | null;
  readonly confidence: number | null;
  readonly createdAt: string;
}

/** W10 formula row (extracted display-math LaTeX with retrieval context). */
export interface KeFormulaRow {
  readonly id: string;
  readonly kbId: string;
  readonly docId: string;
  readonly latex: string;
  readonly displayLatex: string;
  readonly context: string;
  readonly label: string | null;
  readonly section: string | null;
  readonly createdAt: string;
}

export interface KeCitationInput {
  readonly kbId: string;
  readonly srcDocId: string;
  readonly dstDocId: string | null;
  readonly dstKey: string;
  readonly sentence: string;
  readonly section: string | null;
  readonly intent: string | null;
  readonly confidence: number | null;
}

export interface KeFormulaInput {
  readonly kbId: string;
  readonly docId: string;
  readonly latex: string;
  readonly displayLatex: string;
  readonly context: string;
  readonly label: string | null;
  readonly section: string | null;
}

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "ke_core",
    sql: `
      CREATE TABLE knowledge_bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        engine_state TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE TABLE ke_documents (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        source_uri TEXT,
        dedup_key TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        authors TEXT NOT NULL DEFAULT '[]',
        year INTEGER,
        venue TEXT,
        abstract TEXT,
        fulltext TEXT,
        ref_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        source_meta TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (kb_id, dedup_key)
      );
      CREATE INDEX ke_documents_kb_status ON ke_documents (kb_id, status);
      CREATE TABLE ke_entities (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        aliases TEXT NOT NULL DEFAULT '[]',
        embedding BLOB,
        support_count INTEGER NOT NULL DEFAULT 1,
        trust_level TEXT NOT NULL DEFAULT 'candidate',
        first_seen_doc TEXT,
        community_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (kb_id, normalized_name, type)
      );
      CREATE INDEX ke_entities_kb_type ON ke_entities (kb_id, type);
      CREATE TABLE ke_edges (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        src_id TEXT NOT NULL REFERENCES ke_entities(id) ON DELETE CASCADE,
        dst_id TEXT NOT NULL REFERENCES ke_entities(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        evidence_quote TEXT,
        evidence_doc_id TEXT,
        support_count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (kb_id, src_id, dst_id, type, evidence_doc_id)
      );
      -- NOTE: evidence_doc_id is nullable and SQL NULLs never compare equal,
      -- so this UNIQUE constraint does NOT deduplicate NULL-evidence edges.
      -- Merging for those relies on the application-level SELECT inside the
      -- upsert transaction (same as the DeepAnalyze PostgreSQL behavior).
      CREATE INDEX ke_edges_kb_src ON ke_edges (kb_id, src_id);
      CREATE INDEX ke_edges_kb_dst ON ke_edges (kb_id, dst_id);
      CREATE TABLE ke_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        dedup_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        run_after TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX ke_jobs_claim ON ke_jobs (status, run_after, created_at);
      -- Dedup backstop at the storage layer: at most one active job per
      -- (type, dedup_key), enforced across connections (the application-level
      -- SELECT-first lives inside a transaction but the index is the guard).
      CREATE UNIQUE INDEX ke_jobs_active_dedup ON ke_jobs (type, dedup_key)
        WHERE dedup_key IS NOT NULL AND status IN ('pending', 'running');
      CREATE VIRTUAL TABLE ke_entities_fts USING fts5(
        entity_id UNINDEXED,
        kb_id UNINDEXED,
        name,
        aliases
      );
      CREATE VIRTUAL TABLE ke_documents_fts USING fts5(
        document_id UNINDEXED,
        kb_id UNINDEXED,
        title,
        abstract,
        fulltext
      );
      CREATE TRIGGER ke_entities_fts_insert AFTER INSERT ON ke_entities BEGIN
        INSERT INTO ke_entities_fts (entity_id, kb_id, name, aliases)
        VALUES (new.id, new.kb_id, new.name, new.aliases);
      END;
      CREATE TRIGGER ke_entities_fts_update AFTER UPDATE ON ke_entities BEGIN
        DELETE FROM ke_entities_fts WHERE entity_id = old.id;
        INSERT INTO ke_entities_fts (entity_id, kb_id, name, aliases)
        VALUES (new.id, new.kb_id, new.name, new.aliases);
      END;
      CREATE TRIGGER ke_entities_fts_delete AFTER DELETE ON ke_entities BEGIN
        DELETE FROM ke_entities_fts WHERE entity_id = old.id;
      END;
      CREATE TRIGGER ke_documents_fts_insert AFTER INSERT ON ke_documents BEGIN
        INSERT INTO ke_documents_fts (document_id, kb_id, title, abstract, fulltext)
        VALUES (new.id, new.kb_id, new.title, coalesce(new.abstract, ''), coalesce(new.fulltext, ''));
      END;
      CREATE TRIGGER ke_documents_fts_update AFTER UPDATE ON ke_documents BEGIN
        DELETE FROM ke_documents_fts WHERE document_id = old.id;
        INSERT INTO ke_documents_fts (document_id, kb_id, title, abstract, fulltext)
        VALUES (new.id, new.kb_id, new.title, coalesce(new.abstract, ''), coalesce(new.fulltext, ''));
      END;
      CREATE TRIGGER ke_documents_fts_delete AFTER DELETE ON ke_documents BEGIN
        DELETE FROM ke_documents_fts WHERE document_id = old.id;
      END;
    `,
  },
  {
    version: 2,
    name: "ke_growth",
    sql: `
      CREATE TABLE ke_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE ke_frontier (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        cycle_id TEXT NOT NULL,
        paper_ref TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        relevance_score REAL,
        parent_id TEXT,
        source TEXT NOT NULL DEFAULT 'backward_citation',
        sources TEXT NOT NULL DEFAULT '[]',
        cite_hits INTEGER NOT NULL DEFAULT 1,
        attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        expanded_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (cycle_id, dedup_key)
      );
      CREATE INDEX ke_frontier_cycle_status ON ke_frontier (cycle_id, status, depth, attempts, created_at);
      CREATE INDEX ke_frontier_kb ON ke_frontier (kb_id);
    `,
  },
  {
    version: 3,
    name: "ke_resolution",
    sql: `
      -- Merge/attach audit + rollback snapshots (DeepAnalyze
      -- subject_entity_merges). absorbed_id is plain TEXT (no FK): online
      -- attach rows carry a synthetic 'candidate:<normalized>' id.
      CREATE TABLE ke_entity_merges (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        canonical_id TEXT NOT NULL,
        absorbed_id TEXT NOT NULL,
        absorbed_snapshot TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        score REAL,
        judge_rationale TEXT,
        job_id TEXT,
        undone_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX ke_entity_merges_kb ON ke_entity_merges (kb_id, created_at);
      -- Distinct-document support detail. Backfilled one row per entity from
      -- first_seen_doc; populated going forward by upsert/attach and by the
      -- merge executor's edge-evidence backfill. support_count itself stays
      -- the GREATEST-guarded counter — the detail table exists so merges can
      -- recount a true distinct-doc union instead of a naive sum.
      CREATE TABLE ke_entity_docs (
        entity_id TEXT NOT NULL REFERENCES ke_entities(id) ON DELETE CASCADE,
        doc_id TEXT NOT NULL,
        kb_id TEXT NOT NULL,
        PRIMARY KEY (entity_id, doc_id)
      );
      CREATE INDEX ke_entity_docs_kb ON ke_entity_docs (kb_id, entity_id);
      INSERT OR IGNORE INTO ke_entity_docs (entity_id, doc_id, kb_id)
        SELECT id, first_seen_doc, kb_id FROM ke_entities WHERE first_seen_doc IS NOT NULL;
    `,
  },
  {
    version: 4,
    name: "ke_citations_formulae",
    sql: `
      -- W10 citation chain (DA citation_contexts): one row per [@rid] anchor
      -- occurrence. dst_doc_id only for unambiguous KB-internal resolution.
      CREATE TABLE ke_citations (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        src_doc_id TEXT NOT NULL REFERENCES ke_documents(id) ON DELETE CASCADE,
        dst_doc_id TEXT REFERENCES ke_documents(id) ON DELETE SET NULL,
        dst_key TEXT NOT NULL,
        sentence TEXT NOT NULL,
        section TEXT,
        intent TEXT,
        confidence REAL,
        created_at TEXT NOT NULL,
        UNIQUE (src_doc_id, dst_key, sentence)
      );
      CREATE INDEX ke_citations_kb_intent ON ke_citations (kb_id, intent);
      CREATE INDEX ke_citations_dst ON ke_citations (kb_id, dst_doc_id);
      -- W10 formula store: display-math LaTeX with retrieval context.
      CREATE TABLE ke_formulae (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        doc_id TEXT NOT NULL REFERENCES ke_documents(id) ON DELETE CASCADE,
        latex TEXT NOT NULL,
        display_latex TEXT NOT NULL,
        context TEXT NOT NULL,
        label TEXT,
        section TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (doc_id, latex)
      );
      CREATE INDEX ke_formulae_kb_doc ON ke_formulae (kb_id, doc_id);
    `,
  },
  {
    version: 5,
    name: "ke_proposal_rejects",
    sql: `
      -- C3① proposal-validation gate (OpenDDE "failures stay evidence"):
      -- extraction-proposal items the deterministic validator rejected after
      -- the corrective retries ran out. Kept for quality analysis (schema
      -- drift, model regressions), never for the graph.
      CREATE TABLE ke_proposal_rejects (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        doc_id TEXT NOT NULL REFERENCES ke_documents(id) ON DELETE CASCADE,
        job_id TEXT,
        section TEXT NOT NULL,
        item_index INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX ke_proposal_rejects_kb ON ke_proposal_rejects (kb_id, created_at);
    `,
  },
  {
    version: 6,
    name: "ke_doc_chunks",
    sql: `
      -- Z8 hybrid retrieval: persisted document chunks (one row per W7
      -- anchored block, reference blocks excluded). embedding is nullable —
      -- written fail-soft at extraction time and backfilled opportunistically;
      -- a KB without vectors simply stays keyword-only (kb_search degrades).
      -- Pre-v6 KBs rebuild their chunks on the next extraction pass; the
      -- chunk writer is idempotent per document (delete + insert).
      CREATE TABLE ke_doc_chunks (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        doc_id TEXT NOT NULL REFERENCES ke_documents(id) ON DELETE CASCADE,
        anchor_id TEXT NOT NULL,
        block_type TEXT NOT NULL,
        section TEXT,
        chunk_text TEXT NOT NULL,
        embedding BLOB,
        created_at TEXT NOT NULL,
        UNIQUE (doc_id, anchor_id)
      );
      CREATE INDEX ke_doc_chunks_kb ON ke_doc_chunks (kb_id);
      CREATE INDEX ke_doc_chunks_pending ON ke_doc_chunks (kb_id) WHERE embedding IS NULL;
    `,
  },
  {
    version: 7,
    name: "ke_community_reports",
    sql: `
      -- V2-Z1 community report layer (GraphRAG-style): one LLM-written
      -- structured digest per detected community, keyed to the graph
      -- fingerprint of the partition it was generated from. Community ids
      -- are only stable WITHIN a fingerprint (sequential first-seen order
      -- across recomputes), so (kb_id, fingerprint, community_id) is the
      -- real key; reports from older fingerprints are history, kept until
      -- GC'd. findings is a JSON array; status separates ready rows from
      -- per-community generation errors.
      CREATE TABLE ke_community_reports (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        community_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        rating INTEGER,
        rating_explanation TEXT,
        findings TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX ke_community_reports_key ON ke_community_reports (kb_id, fingerprint, community_id);
      CREATE INDEX ke_community_reports_kb ON ke_community_reports (kb_id, fingerprint);
    `,
  },
];

/** Deterministic name normalization shared by entity upsert and lookup. */
export function normalizeEntityName(name: string): string {
  return name.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Turn free-form user text into a safe FTS5 MATCH expression. Raw input is
 * never interpolated: tokens are extracted, individually double-quoted
 * (phrases), and OR-joined for recall. Returns null when nothing searchable
 * remains — callers must skip the MATCH entirely.
 */
export function toFtsQuery(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

function now(): string {
  return new Date().toISOString();
}

/** Maximum recorded surface-form aliases per entity (unbounded growth guard). */
const MAX_ENTITY_ALIASES = 64;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class KnowledgeEngineStore {
  private readonly database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.database = database;
  }

  /** Open (creating if needed) the knowledge-engine database under <dataDir>/knowledge-engine/. */
  static open(dataDir: string): KnowledgeEngineStore {
    const directory = resolve(dataDir, "knowledge-engine");
    mkdirSync(directory, { recursive: true });
    const database = new DatabaseSync(resolve(directory, "knowledge-engine.sqlite"));
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA busy_timeout = 5000;");
    // FULL (not WAL-default NORMAL): committed job/edge state must survive a
    // power loss — same posture as the RefStore this class is modeled on.
    database.exec("PRAGMA synchronous = FULL;");
    database.exec("PRAGMA foreign_keys = ON;");
    const store = new KnowledgeEngineStore(database);
    store.migrate();
    store.purgeOrphanGrowthSettings();
    return store;
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS ke_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
    );
    const appliedRows = this.database.prepare("SELECT version FROM ke_migrations").all() as Array<{ version: number }>;
    const applied = new Set(appliedRows.map((row) => row.version));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        this.database.exec(migration.sql);
        this.database
          .prepare("INSERT INTO ke_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, now());
        this.database.exec("COMMIT;");
      } catch (error) {
        this.database.exec("ROLLBACK;");
        throw error;
      }
    }
  }

  /**
   * Run work inside BEGIN IMMEDIATE … COMMIT (reserved lock up front, so the
   * read-then-write patterns in the upserts are race-safe across connections).
   * NOT re-entrant: never call a transacting method from inside another
   * transaction callback (SQLite would throw "cannot start a transaction
   * within a transaction").
   */
  private inTransaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = work();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  // ------------------------------------------------------------------ KBs

  createKnowledgeBase(input: { name: string; description?: string }): KnowledgeBaseRow {
    const id = randomUUID();
    const createdAt = now();
    this.database
      .prepare("INSERT INTO knowledge_bases (id, name, description, engine_state, created_at) VALUES (?, ?, ?, '{}', ?)")
      .run(id, input.name, input.description ?? "", createdAt);
    return { id, name: input.name, description: input.description ?? "", engineState: {}, createdAt };
  }

  getKnowledgeBase(id: string): KnowledgeBaseRow | undefined {
    const row = this.database.prepare("SELECT * FROM knowledge_bases WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapKb(row) : undefined;
  }

  listKnowledgeBases(): KnowledgeBaseRow[] {
    const rows = this.database.prepare("SELECT * FROM knowledge_bases ORDER BY created_at, id").all() as Array<
      Record<string, unknown>
    >;
    return rows.map(mapKb);
  }

  updateEngineState(kbId: string, engineState: unknown): void {
    // Z7 sticky convergedAt latch: the FIRST convergence timestamp survives
    // later converged cycles verbatim (DA convergence.ts:324-331); a
    // diverging cycle (converged false) clears it, so a re-convergence
    // after a reopen stamps a fresh first-convergence time.
    const prior = this.getKnowledgeBase(kbId)?.engineState as Record<string, unknown> | undefined;
    const next = (engineState ?? {}) as Record<string, unknown>;
    if (next["converged"] === true) {
      next["convergedAt"] = typeof prior?.["convergedAt"] === "string" ? prior["convergedAt"] : new Date().toISOString();
    } else {
      delete next["convergedAt"];
    }
    this.database
      .prepare("UPDATE knowledge_bases SET engine_state = ? WHERE id = ?")
      .run(JSON.stringify(next), kbId);
  }

  // -------------------------------------------------------------- documents

  /** Per-KB counts via SQL aggregates — never hydrates fulltext/embeddings
   *  just to count (the list endpoints' job). */
  countKbStats(kbId: string): { documents: number; documentsReady: number; documentsError: number; entities: number; edges: number } {
    const docs = this.database
      .prepare(
        `SELECT count(*) AS total,
                sum(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
                sum(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error
         FROM ke_documents WHERE kb_id = ?`,
      )
      .get(kbId) as { total: number; ready: number | null; error: number | null };
    const entities = this.database.prepare("SELECT count(*) AS total FROM ke_entities WHERE kb_id = ?").get(kbId) as {
      total: number;
    };
    const edges = this.database.prepare("SELECT count(*) AS total FROM ke_edges WHERE kb_id = ?").get(kbId) as {
      total: number;
    };
    return {
      documents: Number(docs.total),
      documentsReady: Number(docs.ready ?? 0),
      documentsError: Number(docs.error ?? 0),
      entities: Number(entities.total),
      edges: Number(edges.total),
    };
  }

  /** Documents WITHOUT the fulltext column — the lean list shape the graph
   *  page polls. source_meta stays (small, carries watermarks/channels). */
  listDocumentsLean(kbId: string, options: { status?: KeDocumentStatus; limit?: number } = {}): KeDocumentRow[] {
    const limit = options.limit ?? 10_000;
    const columns =
      "id, kb_id, source_uri, dedup_key, title, authors, year, venue, abstract, NULL AS fulltext, ref_ids, status, source_meta, created_at, updated_at";
    const rows = (
      options.status
        ? this.database
            .prepare(`SELECT ${columns} FROM ke_documents WHERE kb_id = ? AND status = ? ORDER BY created_at, id LIMIT ?`)
            .all(kbId, options.status, limit)
        : this.database.prepare(`SELECT ${columns} FROM ke_documents WHERE kb_id = ? ORDER BY created_at, id LIMIT ?`).all(kbId, limit)
    ) as Array<Record<string, unknown>>;
    return rows.map(mapDocument);
  }

  /** Entities WITHOUT the embedding BLOB — the graph payload shape. */
  listEntitiesForGraph(kbId: string, options: { limit?: number } = {}): KeEntityRow[] {
    const limit = options.limit ?? 50_000;
    const columns =
      "id, kb_id, name, normalized_name, type, description, aliases, NULL AS embedding, support_count, trust_level, first_seen_doc, community_id, created_at, updated_at";
    const rows = this.database
      .prepare(`SELECT ${columns} FROM ke_entities WHERE kb_id = ? ORDER BY support_count DESC, id LIMIT ?`)
      .all(kbId, limit) as Array<Record<string, unknown>>;
    return rows.map(mapEntity);
  }


  /**
   * Insert or update a document by (kb_id, dedup_key). Returns the stored row.
   * Update semantics: passing undefined keeps the stored value; an explicit
   * empty string for `title` is treated as unset (titles are never blanked).
   */
  upsertDocument(input: {
    kbId: string;
    dedupKey: string;
    sourceUri?: string | null;
    title?: string;
    authors?: readonly string[];
    year?: number | null;
    venue?: string | null;
    abstract?: string | null;
    fulltext?: string | null;
    refIds?: readonly string[];
    status?: KeDocumentStatus;
    sourceMeta?: Record<string, unknown>;
  }): KeDocumentRow {
    const timestamp = now();
    return this.inTransaction(() => {
      const existing = this.findDocumentByDedupKey(input.kbId, input.dedupKey);
      if (!existing) {
        const id = randomUUID();
        this.database
          .prepare(
            `INSERT INTO ke_documents
               (id, kb_id, source_uri, dedup_key, title, authors, year, venue, abstract, fulltext, ref_ids, status, source_meta, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.kbId,
            input.sourceUri ?? null,
            input.dedupKey,
            input.title ?? "",
            JSON.stringify(input.authors ?? []),
            input.year ?? null,
            input.venue ?? null,
            input.abstract ?? null,
            input.fulltext ?? null,
            JSON.stringify(input.refIds ?? []),
            input.status ?? "pending",
            JSON.stringify(input.sourceMeta ?? {}),
            timestamp,
            timestamp,
          );
      } else {
        this.database
          .prepare(
            `UPDATE ke_documents SET
               source_uri = coalesce(?, source_uri), title = coalesce(?, title), authors = ?, year = coalesce(?, year),
               venue = coalesce(?, venue), abstract = coalesce(?, abstract), fulltext = coalesce(?, fulltext),
               ref_ids = ?, status = ?, source_meta = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            input.sourceUri ?? null,
            input.title ? input.title : null,
            JSON.stringify(input.authors ?? existing.authors),
            input.year ?? null,
            input.venue ?? null,
            input.abstract ?? null,
            input.fulltext ?? null,
            JSON.stringify(input.refIds ?? existing.refIds),
            input.status ?? existing.status,
            JSON.stringify(input.sourceMeta ?? existing.sourceMeta),
            timestamp,
            existing.id,
          );
      }
      const stored = this.findDocumentByDedupKey(input.kbId, input.dedupKey);
      if (!stored) {
        throw new Error("ke_document upsert failed to persist");
      }
      return stored;
    });
  }

  findDocumentByDedupKey(kbId: string, dedupKey: string): KeDocumentRow | undefined {
    const row = this.database
      .prepare("SELECT * FROM ke_documents WHERE kb_id = ? AND dedup_key = ?")
      .get(kbId, dedupKey) as Record<string, unknown> | undefined;
    return row ? mapDocument(row) : undefined;
  }

  getDocument(id: string): KeDocumentRow | undefined {
    const row = this.database.prepare("SELECT * FROM ke_documents WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapDocument(row) : undefined;
  }

  listDocuments(kbId: string, options: { status?: KeDocumentStatus; limit?: number } = {}): KeDocumentRow[] {
    const limit = options.limit ?? 10_000;
    const rows = (
      options.status
        ? this.database
            .prepare("SELECT * FROM ke_documents WHERE kb_id = ? AND status = ? ORDER BY created_at, id LIMIT ?")
            .all(kbId, options.status, limit)
        : this.database.prepare("SELECT * FROM ke_documents WHERE kb_id = ? ORDER BY created_at, id LIMIT ?").all(kbId, limit)
    ) as Array<Record<string, unknown>>;
    return rows.map(mapDocument);
  }

  // --------------------------------------------------------------- entities

  /**
   * Insert or merge an entity by (kb_id, normalized_name, type). On conflict
   * the support count increments and a new alias is recorded when the surface
   * form differs — the per-document merge semantics of the DeepAnalyze
   * extraction pipeline.
   */
  upsertEntity(input: {
    kbId: string;
    name: string;
    type: string;
    description?: string | null;
    /** Explicit aliases from the extractor (merged, capped, deduplicated). */
    aliases?: readonly string[];
    firstSeenDoc?: string | null;
    incrementSupport?: boolean;
  }): KeEntityRow {
    const normalizedName = normalizeEntityName(input.name);
    const timestamp = now();
    return this.inTransaction(() => {
      const mergeAliases = (current: string[]): string[] => {
        // Cap alias growth: hot entities would otherwise accumulate an
        // unbounded surface-form list over the KB's lifetime.
        const merged = [...current];
        for (const alias of input.aliases ?? []) {
          const trimmed = alias.trim();
          if (
            trimmed &&
            normalizeEntityName(trimmed) !== normalizedName &&
            !merged.some((existing) => normalizeEntityName(existing) === normalizeEntityName(trimmed)) &&
            merged.length < MAX_ENTITY_ALIASES
          ) {
            merged.push(trimmed);
          }
        }
        return merged;
      };
      const existing = this.database
        .prepare("SELECT * FROM ke_entities WHERE kb_id = ? AND normalized_name = ? AND type = ?")
        .get(input.kbId, normalizedName, input.type) as Record<string, unknown> | undefined;
      let entityId: string;
      if (!existing) {
        entityId = randomUUID();
        this.database
          .prepare(
            `INSERT INTO ke_entities
               (id, kb_id, name, normalized_name, type, description, aliases, support_count, first_seen_doc, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          )
          .run(
            entityId,
            input.kbId,
            input.name,
            normalizedName,
            input.type,
            input.description ?? null,
            JSON.stringify(mergeAliases([])),
            input.firstSeenDoc ?? null,
            timestamp,
            timestamp,
          );
      } else {
        entityId = String(existing["id"]);
      }
      // Distinct-document support detail (merge recount input) BEFORE the
      // support update: the row insert is the idempotency anchor — a repeat
      // (entity, docId) pair means a re-run, and support must not
      // double-count it (DA conditions its increment the same way).
      let docRowInserted = false;
      if (input.firstSeenDoc) {
        const inserted = this.database
          .prepare("INSERT OR IGNORE INTO ke_entity_docs (entity_id, doc_id, kb_id) VALUES (?, ?, ?)")
          .run(entityId, input.firstSeenDoc, input.kbId);
        docRowInserted = Number(inserted.changes) > 0;
      }
      if (existing) {
        const aliases = mergeAliases(parseJson<string[]>(existing["aliases"], []));
        // Cap alias growth: hot entities would otherwise accumulate an
        // unbounded surface-form list over the KB's lifetime.
        if (
          typeof existing["name"] === "string" &&
          existing["name"] !== input.name &&
          !aliases.includes(input.name) &&
          aliases.length < MAX_ENTITY_ALIASES
        ) {
          aliases.push(input.name);
        }
        // Without a docId the caller opts out of detail tracking (tests,
        // manual writes) and the increment stays unconditional; with one,
        // only a NEW detail row earns the bump.
        const supportDelta =
          input.incrementSupport === false ? 0 : input.firstSeenDoc ? (docRowInserted ? 1 : 0) : 1;
        this.database
          .prepare(
            `UPDATE ke_entities SET
               support_count = support_count + ?, aliases = ?,
               description = coalesce(?, description), updated_at = ?
             WHERE id = ?`,
          )
          .run(supportDelta, JSON.stringify(aliases), input.description ?? null, timestamp, entityId);
      }
      const stored = this.getEntityByNormalizedName(input.kbId, normalizedName, input.type);
      if (!stored) {
        throw new Error("ke_entity upsert failed to persist");
      }
      return stored;
    });
  }

  getEntity(id: string): KeEntityRow | undefined {
    const row = this.database.prepare("SELECT * FROM ke_entities WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapEntity(row) : undefined;
  }

  getEntityByNormalizedName(kbId: string, normalizedName: string, type: string): KeEntityRow | undefined {
    const row = this.database
      .prepare("SELECT * FROM ke_entities WHERE kb_id = ? AND normalized_name = ? AND type = ?")
      .get(kbId, normalizedName, type) as Record<string, unknown> | undefined;
    return row ? mapEntity(row) : undefined;
  }

  listEntities(
    kbId: string,
    options: { type?: string; limit?: number; withEmbedding?: boolean } = {},
  ): KeEntityRow[] {
    const limit = options.limit ?? 50_000;
    const clauses = ["kb_id = ?"];
    const params: Array<string | number> = [kbId];
    if (options.type) {
      clauses.push("type = ?");
      params.push(options.type);
    }
    if (options.withEmbedding) {
      clauses.push("embedding IS NOT NULL");
    }
    params.push(limit);
    const rows = this.database
      .prepare(`SELECT * FROM ke_entities WHERE ${clauses.join(" AND ")} ORDER BY support_count DESC, id LIMIT ?`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapEntity);
  }

  updateEntityEmbedding(id: string, embedding: Uint8Array): void {
    this.database
      .prepare("UPDATE ke_entities SET embedding = ?, updated_at = ? WHERE id = ?")
      .run(embedding, now(), id);
  }

  // ------------------------------------------------------------- resolution

  /**
   * Alias lookup (resolver L1): exact hit on any entity's alias list, compared
   * NORMALIZED on both sides (aliases are stored as surface forms). Scans the
   * KB's entities in insertion order — deterministic and plenty fast at KB
   * scale (no pg_trgm alias index in SQLite).
   */
  findEntityByAlias(kbId: string, normalizedAlias: string): KeEntityRow | undefined {
    const rows = this.database
      .prepare("SELECT * FROM ke_entities WHERE kb_id = ? ORDER BY created_at, id")
      .all(kbId) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const aliases = parseJson<string[]>(row["aliases"], []);
      if (aliases.some((alias) => normalizeEntityName(alias) === normalizedAlias)) {
        return mapEntity(row);
      }
    }
    return undefined;
  }

  /** Exact canonical-name hit across types (resolver L0 — DA's L0 was
   *  type-independent; the (kb, name, type) dedup key stays untouched). */
  findEntityByName(kbId: string, normalizedName: string): KeEntityRow | undefined {
    const row = this.database
      .prepare("SELECT * FROM ke_entities WHERE kb_id = ? AND normalized_name = ? ORDER BY created_at, id LIMIT 1")
      .get(kbId, normalizedName) as Record<string, unknown> | undefined;
    return row ? mapEntity(row) : undefined;
  }

  /** Trigram-similarity recall over canonical names (resolver L3.5 + batch
   *  string channel). JS scoring over the KB's rows replaces pg_trgm. */
  similarEntitiesByName(kbId: string, name: string, minSim: number, limit: number): Array<KeEntityRow & { sim: number }> {
    const normalized = normalizeEntityName(name);
    if (!normalized) return [];
    const rows = this.database
      .prepare("SELECT * FROM ke_entities WHERE kb_id = ?")
      .all(kbId) as Array<Record<string, unknown>>;
    return rows
      .map((row) => ({ entity: mapEntity(row), sim: trigramSimilarity(normalized, String(row["normalized_name"])) }))
      .filter((hit) => hit.sim >= minSim)
      .sort((a, b) => b.sim - a.sim || a.entity.id.localeCompare(b.entity.id))
      .slice(0, limit)
      .map((hit) => ({ ...hit.entity, sim: hit.sim }));
  }

  /** Embedding cosine recall (resolver L3 + batch embedding channel):
   *  brute-force scan over stored vectors — millisecond-scale at KB sizes. */
  nearestEntitiesByEmbedding(
    kbId: string,
    embedding: ArrayLike<number>,
    limit: number,
  ): Array<KeEntityRow & { cosine: number }> {
    const rows = this.listEntities(kbId, { withEmbedding: true });
    const items = rows
      .filter((row) => row.embedding !== null)
      .map((row) => ({ item: row, embedding: embeddingFromBlob(row.embedding!) }));
    return cosineScan(embedding, items, { topK: limit }).map((match) => ({ ...match.item, cosine: match.score }));
  }

  listEntitiesByIds(kbId: string, ids: readonly string[]): KeEntityRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    // Deterministic member order (id) — the cluster judge's 1-based indices
    // and the merge sequence both depend on it.
    const rows = this.database
      .prepare(`SELECT * FROM ke_entities WHERE kb_id = ? AND id IN (${placeholders}) ORDER BY id`)
      .all(kbId, ...ids) as Array<Record<string, unknown>>;
    return rows.map(mapEntity);
  }

  /**
   * Online-resolution attach: the candidate merged into an EXISTING entity at
   * write time. Mirrors upsertEntity's merge semantics (distinct-doc support
   * increment, alias union normalized-dedup + capped, description fills only
   * when null) plus the distinct-doc detail row. The audit row is the caller's job
   * (recordEntityMerge) — keeping the two separate lets shadow mode record
   * without writing.
   */
  attachToEntity(
    targetId: string,
    input: {
      name: string;
      aliases?: readonly string[];
      description?: string | null;
      docId?: string | null;
      /** Pass false when the target already absorbed a candidate from this
       *  same document — support counts distinct documents, not mentions. */
      incrementSupport?: boolean;
    },
  ): KeEntityRow {
    const timestamp = now();
    return this.inTransaction(() => {
      const existing = this.getEntity(targetId);
      if (!existing) {
        throw new Error(`attachToEntity: entity ${targetId} not found`);
      }
      const aliases = [...existing.aliases];
      const pushAlias = (surface: string) => {
        const trimmed = surface.trim();
        if (
          trimmed &&
          normalizeEntityName(trimmed) !== existing.normalizedName &&
          !aliases.some((a) => normalizeEntityName(a) === normalizeEntityName(trimmed)) &&
          aliases.length < MAX_ENTITY_ALIASES
        ) {
          aliases.push(trimmed);
        }
      };
      pushAlias(input.name);
      for (const alias of input.aliases ?? []) pushAlias(alias);
      // Distinct-doc idempotency anchor BEFORE the support update
      // (upsertEntity parity): a repeat (entity, docId) pair means a re-run,
      // and support must not double-count it — the MAX() recount below never
      // lowers, so an inflated bump here would be permanent.
      let docRowInserted = false;
      if (input.docId) {
        const inserted = this.database
          .prepare("INSERT OR IGNORE INTO ke_entity_docs (entity_id, doc_id, kb_id) VALUES (?, ?, ?)")
          .run(targetId, input.docId, existing.kbId);
        docRowInserted = Number(inserted.changes) > 0;
      }
      // Without a docId the caller opts out of detail tracking and the
      // increment stays unconditional; with one, only a NEW detail row earns
      // the bump.
      const supportDelta =
        input.incrementSupport === false ? 0 : input.docId ? (docRowInserted ? 1 : 0) : 1;
      this.database
        .prepare(
          `UPDATE ke_entities SET
             support_count = support_count + ?, aliases = ?,
             description = coalesce(?, description), updated_at = ?
           WHERE id = ?`,
        )
        .run(supportDelta, JSON.stringify(aliases), input.description ?? null, timestamp, targetId);
      // DA parity (online-attach recountSupport): distinct-doc recount that
      // never lowers support, and promotion to 'core' at ≥3 supporting docs.
      // (upsertEntity deliberately stays promotion-free — pre-existing
      // semantics; mergeEntities shares this recount.)
      this.database
        .prepare(
          `UPDATE ke_entities
           SET support_count = MAX(support_count,
                 (SELECT count(*) FROM ke_entity_docs WHERE entity_id = ?)),
               trust_level = CASE
                 WHEN MAX(support_count,
                   (SELECT count(*) FROM ke_entity_docs WHERE entity_id = ?)) >= 3
                 THEN 'core' ELSE trust_level END
           WHERE id = ?`,
        )
        .run(targetId, targetId, targetId);
      return this.getEntity(targetId)!;
    });
  }

  /** Audit row for merges, online attaches, shadow previews and judge
   *  rejections. Returns the row id. */
  recordEntityMerge(input: {
    kbId: string;
    canonicalId: string;
    absorbedId: string;
    snapshot: Record<string, unknown>;
    decidedBy: string;
    score?: number;
    rationale?: string;
    jobId?: string;
  }): string {
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO ke_entity_merges
           (id, kb_id, canonical_id, absorbed_id, absorbed_snapshot, decided_by, score, judge_rationale, job_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kbId,
        input.canonicalId,
        input.absorbedId,
        JSON.stringify(input.snapshot),
        input.decidedBy,
        input.score ?? null,
        input.rationale ?? null,
        input.jobId ?? null,
        now(),
      );
    return id;
  }

  listEntityMerges(kbId: string, options: { limit?: number } = {}): KeEntityMergeRow[] {
    const rows = this.database
      .prepare("SELECT * FROM ke_entity_merges WHERE kb_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(kbId, options.limit ?? 500) as Array<Record<string, unknown>>;
    return rows.map(mapMerge);
  }

  /** Judged-pair cache for batch resume: every pair ever decided (merges,
   *  rejects, online attaches) as canonical pair keys — never re-judged.
   *  SHADOW rows are excluded: a shadow run's positive previews are not real
   *  decisions, and counting them would make the documented shadow→on
   *  workflow silently no-op (everyPairCached skips the judge, groups come
   *  back empty, nothing ever merges). */
  judgedPairKeys(kbId: string): string[] {
    const rows = this.database
      .prepare("SELECT canonical_id, absorbed_id FROM ke_entity_merges WHERE kb_id = ? AND decided_by NOT LIKE 'shadow:%'")
      .all(kbId) as Array<{ canonical_id: string; absorbed_id: string }>;
    return rows.map((row) =>
      row.canonical_id < row.absorbed_id
        ? `${row.canonical_id}|${row.absorbed_id}`
        : `${row.absorbed_id}|${row.canonical_id}`,
    );
  }

  /**
   * Physical merge of two entities judged the same concept (DeepAnalyze
   * scholarly/entity-merge, SQLite port). The absorbed entity is deleted
   * after its edges, doc detail and aliases move onto the canonical survivor;
   * a full pre-merge snapshot lands in ke_entity_merges for rollback.
   *
   * Invariants preserved:
   *   - support_count stays a distinct-doc count (recomputed from
   *     ke_entity_docs via MAX — never a naive sum, never lowered);
   *   - the edge logical key (kb, src, dst, type, evidence_doc) never
   *     collides — colliding redirected edges fold support into the survivor;
   *   - self-loops produced by redirecting A–B edges are dropped (kept in
   *     the snapshot for rollback);
   *   - single transaction (node:sqlite is single-writer; the BEGIN
   *     IMMEDIATE is the deadlock guard DA needed row locks for).
   */
  mergeEntities(kbId: string, canonicalId: string, absorbedId: string, meta: KeMergeMeta): { mergeId: string } {
    if (canonicalId === absorbedId) throw new Error("cannot merge an entity into itself");
    return this.inTransaction(() => {
      const canon = this.getEntity(canonicalId);
      const absorbed = this.getEntity(absorbedId);
      if (!canon || !absorbed || canon.kbId !== kbId || absorbed.kbId !== kbId) {
        throw new Error(
          `mergeEntities: entity not found in kb ${kbId} (canonical=${canon !== undefined}, absorbed=${absorbed !== undefined})`,
        );
      }

      // --- Snapshot everything rollback needs, BEFORE any mutation ---
      // Embeddings are excluded (NULLed by the merge anyway — the survivor
      // re-embeds on the next backfill pass).
      const absorbedEdges = (
        this.database
          .prepare("SELECT * FROM ke_edges WHERE src_id = ? OR dst_id = ? ORDER BY id")
          .all(absorbedId, absorbedId) as Array<Record<string, unknown>>
      ).map(mapEdge);
      const absorbedDocs = (
        this.database.prepare("SELECT doc_id FROM ke_entity_docs WHERE entity_id = ?").all(absorbedId) as Array<{ doc_id: string }>
      ).map((row) => row.doc_id);
      const canonDocs = (
        this.database.prepare("SELECT doc_id FROM ke_entity_docs WHERE entity_id = ?").all(canonicalId) as Array<{ doc_id: string }>
      ).map((row) => row.doc_id);

      const mergeId = this.recordEntityMerge({
        kbId,
        canonicalId,
        absorbedId,
        snapshot: {
          absorbed: { ...absorbed, embedding: null },
          absorbedEdges,
          absorbedDocs,
          canonicalBefore: { ...canon, embedding: null },
          canonicalDocsBefore: canonDocs,
        },
        decidedBy: meta.decidedBy,
        ...(meta.score !== undefined ? { score: meta.score } : {}),
        ...(meta.rationale !== undefined ? { rationale: meta.rationale } : {}),
        ...(meta.jobId !== undefined ? { jobId: meta.jobId } : {}),
      });

      // --- Canonical row update ---
      // Aliases: union of both sides plus the absorbed canonical name (which
      // must remain resolvable). Surface forms kept, normalized dedup, capped.
      const aliases = [...canon.aliases];
      const pushAlias = (surface: string | null) => {
        if (!surface) return;
        const trimmed = surface.trim();
        if (
          trimmed &&
          normalizeEntityName(trimmed) !== canon.normalizedName &&
          !aliases.some((a) => normalizeEntityName(a) === normalizeEntityName(trimmed)) &&
          aliases.length < MAX_ENTITY_ALIASES
        ) {
          aliases.push(trimmed);
        }
      };
      for (const alias of absorbed.aliases) pushAlias(alias);
      pushAlias(absorbed.name);
      const canonDef = canon.description ?? "";
      const absorbedDef = absorbed.description ?? "";
      this.database
        .prepare(
          `UPDATE ke_entities SET
             aliases = ?,
             description = ?,
             trust_level = CASE WHEN trust_level = 'core' OR ? = 'core' THEN 'core' ELSE trust_level END,
             first_seen_doc = coalesce(first_seen_doc, ?),
             embedding = NULL,
             updated_at = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(aliases),
          canonDef.length >= absorbedDef.length ? canon.description : absorbed.description,
          absorbed.trustLevel,
          absorbed.firstSeenDoc,
          now(),
          canonicalId,
        );

      // --- Edge redirection (before DELETE, so ON DELETE CASCADE sees none) ---
      for (const edge of absorbedEdges) {
        const newSrc = edge.srcId === absorbedId ? canonicalId : edge.srcId;
        const newDst = edge.dstId === absorbedId ? canonicalId : edge.dstId;
        if (newSrc === newDst) {
          // A–B edge collapses to a self-loop: drop (snapshot preserves it).
          this.database.prepare("DELETE FROM ke_edges WHERE id = ?").run(edge.id);
          continue;
        }
        const collision = this.database
          .prepare(
            `SELECT id FROM ke_edges
             WHERE kb_id = ? AND src_id = ? AND dst_id = ? AND type = ?
               AND (evidence_doc_id IS ? OR evidence_doc_id = ?)`,
          )
          .get(kbId, newSrc, newDst, edge.type, edge.evidenceDocId, edge.evidenceDocId) as { id: string } | undefined;
        if (collision) {
          // Fold support into the surviving row.
          this.database
            .prepare("UPDATE ke_edges SET support_count = support_count + ?, updated_at = ? WHERE id = ?")
            .run(edge.supportCount, now(), collision.id);
          this.database.prepare("DELETE FROM ke_edges WHERE id = ?").run(edge.id);
        } else {
          this.database
            .prepare("UPDATE ke_edges SET src_id = ?, dst_id = ?, updated_at = ? WHERE id = ?")
            .run(newSrc, newDst, now(), edge.id);
        }
      }

      // --- Support detail: move absorbed docs onto canonical, backfill the
      // survivor from its (now redirected) edge evidence, then distinct-doc
      // recount (MAX inside — never a naive sum, never lowered).
      this.database
        .prepare(
          "INSERT OR IGNORE INTO ke_entity_docs (entity_id, doc_id, kb_id) SELECT ?, doc_id, ? FROM ke_entity_docs WHERE entity_id = ?",
        )
        .run(canonicalId, kbId, absorbedId);
      this.database
        .prepare(
          `INSERT OR IGNORE INTO ke_entity_docs (entity_id, doc_id, kb_id)
           SELECT ?, evidence_doc_id, ? FROM ke_edges
           WHERE (src_id = ? OR dst_id = ?) AND evidence_doc_id IS NOT NULL`,
        )
        .run(canonicalId, kbId, canonicalId, canonicalId);

      // --- Distinct-doc recount on the survivor (+ DA trust promotion) ---
      this.database
        .prepare(
          `UPDATE ke_entities
           SET support_count = MAX(support_count,
                 (SELECT count(*) FROM ke_entity_docs WHERE entity_id = ?)),
               trust_level = CASE
                 WHEN MAX(support_count,
                   (SELECT count(*) FROM ke_entity_docs WHERE entity_id = ?)) >= 3
                 THEN 'core' ELSE trust_level END
           WHERE id = ?`,
        )
        .run(canonicalId, canonicalId, canonicalId);

      // --- Delete absorbed (edges and docs already moved; CASCADE no-ops) ---
      this.database.prepare("DELETE FROM ke_entity_docs WHERE entity_id = ?").run(absorbedId);
      this.database.prepare("DELETE FROM ke_entities WHERE id = ?").run(absorbedId);

      return { mergeId };
    });
  }

  /**
   * Best-effort rollback from the audit snapshot: restores the absorbed row
   * and its edges, hands folded support back, and restores both entities'
   * pre-merge scalars. Drift accumulated after the merge (new edges/docs/
   * aliases written since) is NOT compensated — documented as best-effort.
   * Online-attach rows carry no absorbed entity and cannot unmerge.
   */
  unmergeEntity(mergeId: string): void {
    this.inTransaction(() => {
      const row = this.database.prepare("SELECT * FROM ke_entity_merges WHERE id = ?").get(mergeId) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new Error(`unmergeEntity: merge ${mergeId} not found`);
      if (row["undone_at"]) throw new Error(`unmergeEntity: merge ${mergeId} already undone`);
      const snap = parseJson<{
        onlineAttach?: boolean;
        absorbed: KeEntityRow;
        absorbedEdges: KeEdgeRow[];
        absorbedDocs: string[];
        canonicalBefore: KeEntityRow;
        canonicalDocsBefore: string[];
      } | null>(row["absorbed_snapshot"], null);
      if (!snap || snap.onlineAttach) {
        throw new Error(`unmergeEntity: merge ${mergeId} has no absorbed entity (online attach — undo = remove the alias)`);
      }
      const kbId = String(row["kb_id"]);
      const canonicalId = String(row["canonical_id"]);
      const absorbedId = String(row["absorbed_id"]);

      // Rebuild the absorbed row under its original id (if still absent).
      const a = snap.absorbed;
      this.database
        .prepare(
          `INSERT OR IGNORE INTO ke_entities
             (id, kb_id, name, normalized_name, type, description, aliases, embedding,
              support_count, trust_level, first_seen_doc, community_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          a.id,
          a.kbId,
          a.name,
          a.normalizedName,
          a.type,
          a.description,
          JSON.stringify(a.aliases ?? []),
          a.supportCount,
          a.trustLevel,
          a.firstSeenDoc,
          a.communityId,
          a.createdAt,
          a.updatedAt,
        );

      // Restore absorbed edges. Three cases per snapshotted edge:
      //   1. its row still exists under the same id → it was redirected in
      //      place; restore the original endpoints/support;
      //   2. it was folded into a collision target (found by the REDIRECTED
      //      endpoints) → hand the support back AND re-insert the original;
      //   3. neither → it was dropped as a self-loop; re-insert the original.
      for (const edge of snap.absorbedEdges) {
        const byId = this.database.prepare("SELECT id FROM ke_edges WHERE id = ?").get(edge.id);
        if (byId) {
          this.database
            .prepare("UPDATE ke_edges SET src_id = ?, dst_id = ?, support_count = ?, updated_at = ? WHERE id = ?")
            .run(edge.srcId, edge.dstId, edge.supportCount, now(), edge.id);
          continue;
        }
        const redSrc = edge.srcId === absorbedId ? canonicalId : edge.srcId;
        const redDst = edge.dstId === absorbedId ? canonicalId : edge.dstId;
        if (redSrc !== redDst) {
          const foldTarget = this.database
            .prepare(
              `SELECT id, support_count FROM ke_edges
               WHERE kb_id = ? AND src_id = ? AND dst_id = ? AND type = ?
                 AND (evidence_doc_id IS ? OR evidence_doc_id = ?)`,
            )
            .get(kbId, redSrc, redDst, edge.type, edge.evidenceDocId, edge.evidenceDocId) as
            | { id: string; support_count: number }
            | undefined;
          if (foldTarget) {
            const remaining = foldTarget.support_count - edge.supportCount;
            if (remaining > 0) {
              this.database.prepare("UPDATE ke_edges SET support_count = ? WHERE id = ?").run(remaining, foldTarget.id);
            } else {
              this.database.prepare("DELETE FROM ke_edges WHERE id = ?").run(foldTarget.id);
            }
          }
        }
        this.database
          .prepare(
            `INSERT OR IGNORE INTO ke_edges
               (id, kb_id, src_id, dst_id, type, evidence_quote, evidence_doc_id, support_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            edge.id,
            kbId,
            edge.srcId,
            edge.dstId,
            edge.type,
            edge.evidenceQuote,
            edge.evidenceDocId,
            edge.supportCount,
            edge.createdAt,
            edge.updatedAt,
          );
      }

      // Restore absorbed doc detail; remove from canonical exactly the docs
      // the merge contributed — absorbed detail rows plus evidence docs of
      // redirected edges — except docs canonical already had (post-merge
      // drift is left untouched, best-effort contract).
      const canonDocsBefore = new Set(snap.canonicalDocsBefore);
      const mergeContributed = new Set<string>(snap.absorbedDocs);
      for (const edge of snap.absorbedEdges) {
        if (edge.evidenceDocId) mergeContributed.add(edge.evidenceDocId);
      }
      for (const docId of snap.absorbedDocs) {
        this.database
          .prepare("INSERT OR IGNORE INTO ke_entity_docs (entity_id, doc_id, kb_id) VALUES (?, ?, ?)")
          .run(a.id, docId, a.kbId);
      }
      for (const docId of mergeContributed) {
        if (canonDocsBefore.has(docId)) continue;
        this.database.prepare("DELETE FROM ke_entity_docs WHERE entity_id = ? AND doc_id = ?").run(canonicalId, docId);
      }

      // Restore canonical's pre-merge scalars (aliases/support/description/
      // trust/first_seen) exactly from the snapshot.
      const c = snap.canonicalBefore;
      this.database
        .prepare(
          `UPDATE ke_entities SET
             aliases = ?, support_count = ?, description = ?,
             trust_level = ?, first_seen_doc = ?, embedding = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(c.aliases ?? []), c.supportCount, c.description, c.trustLevel, c.firstSeenDoc, now(), canonicalId);

      this.database.prepare("UPDATE ke_entity_merges SET undone_at = ? WHERE id = ?").run(now(), mergeId);
    });
  }

  /** Fingerprint inputs for the graph-roots cache: the partition depends on
   *  entity/edge counts AND support weights (upserts bump support without
   *  changing counts) AND the latest edge creation. */
  entitySupportStats(kbId: string): { count: number; supportSum: number } {
    const row = this.database
      .prepare("SELECT count(*) AS c, coalesce(sum(support_count), 0) AS s FROM ke_entities WHERE kb_id = ?")
      .get(kbId) as { c: number; s: number };
    return { count: Number(row.c), supportSum: Number(row.s) };
  }

  edgeFingerprint(kbId: string): { count: number; supportSum: number; maxCreatedAt: string | null } {
    const row = this.database
      .prepare(
        "SELECT count(*) AS c, coalesce(sum(support_count), 0) AS s, max(created_at) AS m FROM ke_edges WHERE kb_id = ?",
      )
      .get(kbId) as { c: number; s: number; m: string | null };
    return { count: Number(row.c), supportSum: Number(row.s), maxCreatedAt: row.m ?? null };
  }

  /** Persist Louvain assignments onto the rows (visualization cache). Every
   *  entity gets the new assignment; anything absent from the map is cleared
   *  so stale communities never linger after a recompute. */
  setCommunityIds(kbId: string, assignments: ReadonlyMap<string, number>): void {
    this.inTransaction(() => {
      this.database.prepare("UPDATE ke_entities SET community_id = NULL WHERE kb_id = ?").run(kbId);
      const update = this.database.prepare("UPDATE ke_entities SET community_id = ? WHERE kb_id = ? AND id = ?");
      for (const [id, communityId] of assignments) {
        update.run(communityId, kbId, id);
      }
    });
  }

  /** Community members for report generation (support DESC, id tiebreak). */
  listEntitiesByCommunity(kbId: string, communityId: number, limit = 100): KeEntityRow[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM ke_entities WHERE kb_id = ? AND community_id = ? ORDER BY support_count DESC, id LIMIT ?",
      )
      .all(kbId, communityId, limit) as Array<Record<string, unknown>>;
    return rows.map(mapEntity);
  }

  /** Relations with BOTH endpoints inside the community (support DESC). */
  listEdgesWithinCommunity(kbId: string, communityId: number, limit = 200): KeEdgeRow[] {
    const rows = this.database
      .prepare(
        `SELECT e.* FROM ke_edges e
         JOIN ke_entities sa ON sa.id = e.src_id AND sa.kb_id = e.kb_id
         JOIN ke_entities da ON da.id = e.dst_id AND da.kb_id = e.kb_id
         WHERE e.kb_id = ? AND sa.community_id = ? AND da.community_id = ?
         ORDER BY e.support_count DESC, e.id LIMIT ?`,
      )
      .all(kbId, communityId, communityId, limit) as Array<Record<string, unknown>>;
    return rows.map(mapEdge);
  }

  upsertCommunityReport(input: {
    kbId: string;
    fingerprint: string;
    communityId: number;
    title: string;
    summary: string;
    rating: number | null;
    ratingExplanation: string | null;
    findings: string;
    status: "ready" | "error";
    error: string | null;
    model: string | null;
  }): KeCommunityReportRow {
    const id = `${input.kbId}|${input.fingerprint}|${input.communityId}`;
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO ke_community_reports
           (id, kb_id, fingerprint, community_id, title, summary, rating, rating_explanation, findings, status, error, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, summary = excluded.summary, rating = excluded.rating,
           rating_explanation = excluded.rating_explanation, findings = excluded.findings,
           status = excluded.status, error = excluded.error, model = excluded.model,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.kbId,
        input.fingerprint,
        input.communityId,
        input.title,
        input.summary,
        input.rating,
        input.ratingExplanation,
        input.findings,
        input.status,
        input.error,
        input.model,
        now,
        now,
      );
    return this.getCommunityReport(input.kbId, input.fingerprint, input.communityId)!;
  }

  getCommunityReport(kbId: string, fingerprint: string, communityId: number): KeCommunityReportRow | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM ke_community_reports WHERE kb_id = ? AND fingerprint = ? AND community_id = ?",
      )
      .get(kbId, fingerprint, communityId) as Record<string, unknown> | undefined;
    return row ? mapCommunityReport(row) : undefined;
  }

  /** Reports for one fingerprint, best rating first (nulls last). */
  listCommunityReports(kbId: string, fingerprint: string): KeCommunityReportRow[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM ke_community_reports WHERE kb_id = ? AND fingerprint = ? ORDER BY rating DESC, community_id",
      )
      .all(kbId, fingerprint) as Array<Record<string, unknown>>;
    return rows.map(mapCommunityReport);
  }

  /** Drop reports from every fingerprint except the keeper (GC after regen). */
  deleteCommunityReports(kbId: string, keepFingerprint: string): number {
    const result = this.database
      .prepare("DELETE FROM ke_community_reports WHERE kb_id = ? AND fingerprint != ?")
      .run(kbId, keepFingerprint);
    return Number(result.changes);
  }

  /** Ready reports of the most recently written generation (rating DESC) —
   *  resident-summary orientation; snapshot semantics, graph may have moved. */
  latestCommunityReports(kbId: string, limit: number): KeCommunityReportRow[] {
    const latest = this.database
      .prepare(
        "SELECT fingerprint FROM ke_community_reports WHERE kb_id = ? AND status = 'ready' ORDER BY updated_at DESC LIMIT 1",
      )
      .get(kbId) as { fingerprint: string } | undefined;
    if (!latest) return [];
    return this.listCommunityReports(kbId, latest.fingerprint)
      .filter((row) => row.status === "ready")
      .slice(0, limit);
  }

  /** FTS5 recall over entity names and aliases; returns entity ids ordered by rank. */
  searchEntityIds(kbId: string, query: string, limit = 50): string[] {
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery === null) {
      return [];
    }
    const rows = this.database
      .prepare(
        `SELECT entity_id FROM ke_entities_fts WHERE ke_entities_fts MATCH ? AND kb_id = ? ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, kbId, limit) as Array<{ entity_id: string }>;
    return rows.map((row) => row.entity_id);
  }

  /** FTS5 recall over document title/abstract/fulltext; returns document ids. */
  searchDocumentIds(kbId: string, query: string, limit = 20): string[] {
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery === null) {
      return [];
    }
    const rows = this.database
      .prepare(
        `SELECT document_id FROM ke_documents_fts WHERE ke_documents_fts MATCH ? AND kb_id = ? ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, kbId, limit) as Array<{ document_id: string }>;
    return rows.map((row) => row.document_id);
  }

  /** FTS5 document hits with a match snippet (unified-search documents source). */
  searchDocuments(kbId: string, query: string, limit = 5): Array<{ docId: string; title: string; snippet: string }> {
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery === null) {
      return [];
    }
    const rows = this.database
      .prepare(
        `SELECT d.id, d.title,
                snippet(ke_documents_fts, 4, '[', ']', '…', 24) AS snippet
         FROM ke_documents_fts
         JOIN ke_documents d ON d.id = ke_documents_fts.document_id
         WHERE ke_documents_fts MATCH ? AND ke_documents_fts.kb_id = ?
         ORDER BY ke_documents_fts.rank, d.id LIMIT ?`,
      )
      .all(ftsQuery, kbId, limit) as Array<{ id: string; title: string; snippet: string }>;
    return rows.map((row) => ({ docId: row.id, title: row.title, snippet: row.snippet }));
  }

  /** Top entities by support (resident summary, gap analysis input). */
  topEntitiesBySupport(kbId: string, limit: number): KeEntityRow[] {
    const rows = this.database
      .prepare("SELECT * FROM ke_entities WHERE kb_id = ? ORDER BY support_count DESC, id LIMIT ?")
      .all(kbId, limit) as Array<Record<string, unknown>>;
    return rows.map(mapEntity);
  }

  /** Top edges by support (resident summary strongest-relations slice). */
  topEdgesBySupport(kbId: string, limit: number): KeEdgeRow[] {
    const rows = this.database
      .prepare("SELECT * FROM ke_edges WHERE kb_id = ? ORDER BY support_count DESC, id LIMIT ?")
      .all(kbId, limit) as Array<Record<string, unknown>>;
    return rows.map(mapEdge);
  }

  // ------------------------------------------------------------------ edges

  /**
   * Insert an edge or, on the (kb, src, dst, type, evidence_doc) conflict,
   * increment its support count — matching the DeepAnalyze upsert semantics
   * (re-extraction is intentionally NOT idempotent across runs).
   */
  upsertEdge(input: {
    kbId: string;
    srcId: string;
    dstId: string;
    type: string;
    evidenceQuote?: string | null;
    evidenceDocId?: string | null;
  }): KeEdgeRow {
    const timestamp = now();
    return this.inTransaction(() => {
      const existing = this.database
        .prepare(
          `SELECT * FROM ke_edges
           WHERE kb_id = ? AND src_id = ? AND dst_id = ? AND type = ?
             AND (evidence_doc_id IS ? OR evidence_doc_id = ?)`,
        )
        .get(input.kbId, input.srcId, input.dstId, input.type, input.evidenceDocId ?? null, input.evidenceDocId ?? null) as
        | Record<string, unknown>
        | undefined;
      if (!existing) {
        this.database
          .prepare(
            `INSERT INTO ke_edges (id, kb_id, src_id, dst_id, type, evidence_quote, evidence_doc_id, support_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            randomUUID(),
            input.kbId,
            input.srcId,
            input.dstId,
            input.type,
            input.evidenceQuote ?? null,
            input.evidenceDocId ?? null,
            timestamp,
            timestamp,
          );
      } else {
        this.database
          .prepare("UPDATE ke_edges SET support_count = support_count + 1, updated_at = ? WHERE id = ?")
          .run(timestamp, existing["id"] as string);
      }
      const stored = this.database
        .prepare(
          `SELECT * FROM ke_edges
           WHERE kb_id = ? AND src_id = ? AND dst_id = ? AND type = ?
             AND (evidence_doc_id IS ? OR evidence_doc_id = ?)`,
        )
        .get(input.kbId, input.srcId, input.dstId, input.type, input.evidenceDocId ?? null, input.evidenceDocId ?? null) as
        | Record<string, unknown>
        | undefined;
      if (!stored) {
        throw new Error("ke_edge upsert failed to persist");
      }
      return mapEdge(stored);
    });
  }

  listEdges(kbId: string, options: { entityId?: string; limit?: number } = {}): KeEdgeRow[] {
    const limit = options.limit ?? 100_000;
    // Strongest-first: consumers (deep_dive, neighborhood reads) treat the
    // leading rows as the best-supported evidence — a bare id order would
    // feed them random-UUID arbitrariness.
    const rows = (
      options.entityId
        ? this.database
            .prepare(
              "SELECT * FROM ke_edges WHERE kb_id = ? AND (src_id = ? OR dst_id = ?) ORDER BY support_count DESC, id LIMIT ?",
            )
            .all(kbId, options.entityId, options.entityId, limit)
        : this.database
            .prepare("SELECT * FROM ke_edges WHERE kb_id = ? ORDER BY support_count DESC, id LIMIT ?")
            .all(kbId, limit)
    ) as Array<Record<string, unknown>>;
    return rows.map(mapEdge);
  }

  // ------------------------------------------------------------------- jobs

  /**
   * Enqueue a job. When `dedupKey` is given, an identical pending/running job
   * of the same type suppresses the duplicate (the download-queue semantics:
   * never run the same unit of work twice concurrently). The key lives in its
   * own column — callers do NOT need to mirror it into the payload — and a
   * partial unique index backstops dedup across connections.
   */
  enqueueJob(input: {
    type: string;
    payload: Record<string, unknown>;
    dedupKey?: string;
    runAfter?: string;
    maxAttempts?: number;
  }): { job: KeJobRow; enqueued: boolean } {
    if (input.runAfter !== undefined && Number.isNaN(Date.parse(input.runAfter))) {
      throw new Error(`ke_job runAfter must be an ISO timestamp, got: ${input.runAfter}`);
    }
    const timestamp = now();
    return this.inTransaction(() => {
      if (input.dedupKey !== undefined) {
        const duplicate = this.database
          .prepare(
            `SELECT * FROM ke_jobs
             WHERE type = ? AND status IN ('pending', 'running') AND dedup_key = ?
             ORDER BY created_at LIMIT 1`,
          )
          .get(input.type, input.dedupKey) as Record<string, unknown> | undefined;
        if (duplicate) {
          return { job: mapJob(duplicate), enqueued: false };
        }
      }
      const id = randomUUID();
      this.database
        .prepare(
          `INSERT INTO ke_jobs (id, type, payload, dedup_key, status, attempts, max_attempts, run_after, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
        )
        .run(id, input.type, JSON.stringify(input.payload), input.dedupKey ?? null, input.maxAttempts ?? 3, input.runAfter ?? timestamp, timestamp, timestamp);
      const job = this.getJob(id);
      if (!job) {
        throw new Error("ke_job insert failed to persist");
      }
      return { job, enqueued: true };
    });
  }

  getJob(id: string): KeJobRow | undefined {
    const row = this.database.prepare("SELECT * FROM ke_jobs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapJob(row) : undefined;
  }

  /** Atomically claim the oldest runnable pending job of the given types. */
  claimNextJob(types: readonly string[]): KeJobRow | undefined {
    return this.inTransaction(() => {
      const placeholders = types.map(() => "?").join(", ");
      const row = this.database
        .prepare(
          `SELECT * FROM ke_jobs
           WHERE status = 'pending' AND run_after <= ? AND type IN (${placeholders})
           ORDER BY created_at, id LIMIT 1`,
        )
        .get(now(), ...types) as Record<string, unknown> | undefined;
      if (!row) {
        return undefined;
      }
      const claimed = this.database
        .prepare("UPDATE ke_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(now(), row["id"] as string);
      if (Number(claimed.changes) !== 1) {
        return undefined;
      }
      return mapJob(
        this.database.prepare("SELECT * FROM ke_jobs WHERE id = ?").get(row["id"] as string) as Record<string, unknown>,
      );
    });
  }

  completeJob(id: string): void {
    // State guard: only an in-flight job may complete (no resurrecting a
    // dead/succeeded row by a stale caller). The error column is cleared —
    // it holds the LAST attempt's error and must not outlive a success.
    this.database
      .prepare("UPDATE ke_jobs SET status = 'succeeded', error = NULL, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(now(), id);
  }

  /**
   * Record a job failure. Below maxAttempts the job is rescheduled with
   * exponential backoff; at the cap it becomes 'dead' and stops consuming
   * retries (the doom-loop guard). Only an in-flight job may fail.
   */
  failJob(id: string, error: string, options: { backoffBaseMs?: number; deadLetter?: boolean } = {}): KeJobRow {
    const job = this.getJob(id);
    if (!job) {
      throw new Error(`ke_job ${id} not found`);
    }
    const timestamp = now();
    if (job.status !== "running") {
      return job;
    }
    if (options.deadLetter || job.attempts >= job.maxAttempts) {
      this.database
        .prepare("UPDATE ke_jobs SET status = 'dead', error = ?, updated_at = ? WHERE id = ? AND status = 'running'")
        .run(error, timestamp, id);
    } else {
      const backoffMs = (options.backoffBaseMs ?? 5_000) * 2 ** Math.max(0, job.attempts - 1);
      const runAfter = new Date(Date.now() + backoffMs).toISOString();
      this.database
        .prepare("UPDATE ke_jobs SET status = 'pending', error = ?, run_after = ?, updated_at = ? WHERE id = ? AND status = 'running'")
        .run(error, runAfter, timestamp, id);
    }
    const stored = this.getJob(id);
    if (!stored) {
      throw new Error(`ke_job ${id} not found after fail`);
    }
    return stored;
  }

  /**
   * Startup recovery: jobs left 'running' by a crash become claimable again —
   * EXCEPT those that already exhausted maxAttempts, which go straight to
   * 'dead' (a job that crashes the process on every attempt must not loop
   * forever; attempts are intentionally NOT reset, so recovery consumes the
   * attempt budget and repeated crashers die).
   */
  recoverStaleJobs(): { recovered: number; deadLettered: number } {
    return this.inTransaction(() => {
      const dead = this.database
        .prepare(
          `UPDATE ke_jobs SET status = 'dead', error = 'exceeded max attempts (crash recovery)', updated_at = ?
           WHERE status = 'running' AND attempts >= max_attempts`,
        )
        .run(now());
      const recovered = this.database
        .prepare("UPDATE ke_jobs SET status = 'pending', updated_at = ? WHERE status = 'running'")
        .run(now());
      return { recovered: Number(recovered.changes), deadLettered: Number(dead.changes) };
    });
  }

  listJobs(options: { type?: string; status?: KeJobStatus; kbId?: string; limit?: number } = {}): KeJobRow[] {
    const limit = options.limit ?? 1_000;
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.type) {
      clauses.push("type = ?");
      params.push(options.type);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.kbId) {
      clauses.push("json_extract(payload, '$.kbId') = ?");
      params.push(options.kbId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(`SELECT * FROM ke_jobs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map(mapJob);
  }

  // ------------------------------------------------------------- ke_settings

  getSetting(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM ke_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.database
      .prepare("INSERT INTO ke_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  deleteSetting(key: string): void {
    this.database.prepare("DELETE FROM ke_settings WHERE key = ?").run(key);
  }

  /**
   * Drop grow_directives rows whose KB no longer exists. ke_settings has no
   * FK to knowledge_bases and KE has no delete-KB API — removals happen
   * out-of-band (SQL purge), so this runs once at open to keep the settings
   * table from accumulating orphans. grow_seed_phase rows are deliberately
   * left alone: they are keyed by cycle and their resume semantics are
   * load-bearing for in-flight cycles.
   */
  private purgeOrphanGrowthSettings(): void {
    this.database
      .prepare(
        `DELETE FROM ke_settings
         WHERE key LIKE 'grow_directives:%'
           AND substr(key, ?) NOT IN (SELECT id FROM knowledge_bases)`,
      )
      .run("grow_directives:".length + 1);
  }

  // --------------------------------------------------------------- frontier

  /**
   * Add a candidate to a cycle's frontier. On the (cycle_id, dedup_key)
   * conflict the hit is MERGED: cite_hits +1 and the discovery source is
   * unioned into the sources hit matrix (Chao1's capture–recapture input).
   */
  frontierAdd(input: {
    kbId: string;
    cycleId: string;
    paperRef: Record<string, unknown>;
    dedupKey: string;
    depth: number;
    relevanceScore: number | null;
    parentId: string | null;
    source: string;
  }): { item: KeFrontierRow; inserted: boolean } {
    const timestamp = now();
    return this.inTransaction(() => {
      const existing = this.database
        .prepare("SELECT * FROM ke_frontier WHERE cycle_id = ? AND dedup_key = ?")
        .get(input.cycleId, input.dedupKey) as Record<string, unknown> | undefined;
      if (!existing) {
        const id = randomUUID();
        this.database
          .prepare(
            `INSERT INTO ke_frontier
               (id, kb_id, cycle_id, paper_ref, dedup_key, depth, relevance_score, parent_id, source, sources, cite_hits, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)`,
          )
          .run(
            id,
            input.kbId,
            input.cycleId,
            JSON.stringify(input.paperRef),
            input.dedupKey,
            input.depth,
            input.relevanceScore,
            input.parentId,
            input.source,
            JSON.stringify([input.source]),
            timestamp,
            timestamp,
          );
        return { item: this.getFrontierItem(id)!, inserted: true };
      }
      const sources = parseJson<string[]>(existing["sources"], []);
      if (!sources.includes(input.source)) {
        sources.push(input.source);
      }
      this.database
        .prepare("UPDATE ke_frontier SET cite_hits = cite_hits + 1, sources = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(sources), timestamp, existing["id"] as string);
      return { item: this.getFrontierItem(String(existing["id"]))!, inserted: false };
    });
  }

  getFrontierItem(id: string): KeFrontierRow | undefined {
    const row = this.database.prepare("SELECT * FROM ke_frontier WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapFrontier(row) : undefined;
  }

  /** All frontier items of a cycle (status panel, tests). */
  frontierList(cycleId: string): KeFrontierRow[] {
    const rows = this.database
      .prepare("SELECT * FROM ke_frontier WHERE cycle_id = ? ORDER BY depth, created_at, id")
      .all(cycleId) as Array<Record<string, unknown>>;
    return rows.map(mapFrontier);
  }

  frontierCounts(cycleId: string): { total: number; pending: number; done: number; failed: number; skipped: number } {
    const row = this.database
      .prepare(
        `SELECT count(*) AS total,
                sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                sum(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
                sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                sum(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
         FROM ke_frontier WHERE cycle_id = ?`,
      )
      .get(cycleId) as { total: number; pending: number | null; done: number | null; failed: number | null; skipped: number | null };
    return {
      total: Number(row.total),
      pending: Number(row.pending ?? 0),
      done: Number(row.done ?? 0),
      failed: Number(row.failed ?? 0),
      skipped: Number(row.skipped ?? 0),
    };
  }

  /** C3③ cycle reflection facts: per-discovery-source outcome counts plus
   *  total encounters (cite_hits sums include dedup re-finds). */
  frontierCycleBreakdown(cycleId: string): Array<{
    source: string; items: number; done: number; failed: number; skipped: number; encounters: number;
  }> {
    const rows = this.database
      .prepare(
        `SELECT source,
                count(*) AS items,
                sum(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
                sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                sum(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
                sum(cite_hits) AS encounters
         FROM ke_frontier WHERE cycle_id = ? GROUP BY source ORDER BY source`,
      )
      .all(cycleId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      source: String(row["source"]),
      items: Number(row["items"]),
      done: Number(row["done"] ?? 0),
      failed: Number(row["failed"] ?? 0),
      skipped: Number(row["skipped"] ?? 0),
      encounters: Number(row["encounters"] ?? 0),
    }));
  }

  /**
   * Next candidate to process: shallowest depth, fewest attempts, highest
   * relevance — the deterministic crawl order. Deferred ids (rate-limited
   * this run) are excluded so a stubborn host is not re-picked immediately.
   */
  frontierNextPending(cycleId: string, excludeIds: readonly string[] = []): KeFrontierRow | undefined {
    const exclusion = excludeIds.length > 0 ? `AND id NOT IN (${excludeIds.map(() => "?").join(",")})` : "";
    const row = this.database
      .prepare(
        `SELECT * FROM ke_frontier
         WHERE cycle_id = ? AND status = 'pending' ${exclusion}
         ORDER BY depth, attempts, relevance_score DESC NULLS LAST, created_at, id
         LIMIT 1`,
      )
      .get(cycleId, ...excludeIds) as Record<string, unknown> | undefined;
    return row ? mapFrontier(row) : undefined;
  }

  frontierMarkStatus(id: string, status: "done" | "failed" | "skipped"): void {
    this.database.prepare("UPDATE ke_frontier SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
  }

  frontierMarkExpanded(id: string): void {
    this.database.prepare("UPDATE ke_frontier SET expanded_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
  }

  /** Returns the new attempts count. */
  frontierBumpAttempts(id: string): number {
    return this.inTransaction(() => {
      this.database.prepare("UPDATE ke_frontier SET attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now(), id);
      const row = this.database.prepare("SELECT attempts FROM ke_frontier WHERE id = ?").get(id) as { attempts: number };
      return Number(row.attempts);
    });
  }

  frontierBoostScore(id: string, boost: number): void {
    this.database
      .prepare("UPDATE ke_frontier SET relevance_score = coalesce(relevance_score, 0) + ?, updated_at = ? WHERE id = ?")
      .run(boost, now(), id);
  }

  frontierSkipRemaining(cycleId: string): number {
    const result = this.database
      .prepare("UPDATE ke_frontier SET status = 'skipped', updated_at = ? WHERE cycle_id = ? AND status = 'pending'")
      .run(now(), cycleId);
    return Number(result.changes);
  }

  /** Discovery-path overlap statistics for Chao1: observed (distinct papers
   *  with ≥1 source), f1/f2 (papers found by exactly one / two paths), and
   *  unsourced (papers in the KB with no discovery path recorded). */
  frontierSourceStats(kbId: string): { observed: number; f1: number; f2: number; unsourced: number } {
    const rows = this.database
      .prepare(
        `SELECT dedup_key, sources FROM ke_frontier WHERE kb_id = ?`,
      )
      .all(kbId) as Array<{ dedup_key: string; sources: string }>;
    const pathCounts = new Map<string, number>();
    for (const row of rows) {
      const sources = parseJson<string[]>(row.sources, []);
      pathCounts.set(row.dedup_key, Math.max(pathCounts.get(row.dedup_key) ?? 0, sources.length));
    }
    let f1 = 0;
    let f2 = 0;
    for (const count of pathCounts.values()) {
      if (count === 1) f1 += 1;
      else if (count === 2) f2 += 1;
    }
    const observed = pathCounts.size;
    // KB papers that no discovery path reached (seed uploads etc.).
    const docKeys = this.database
      .prepare("SELECT dedup_key FROM ke_documents WHERE kb_id = ?")
      .all(kbId) as Array<{ dedup_key: string }>;
    const unsourced = docKeys.filter((doc) => !pathCounts.has(doc.dedup_key)).length;
    return { observed, f1, f2, unsourced };
  }

  // ------------------------------------------------- growth support queries

  countEntitiesCreatedSince(kbId: string, sinceIso: string): number {
    const row = this.database
      .prepare("SELECT count(*) AS total FROM ke_entities WHERE kb_id = ? AND created_at >= ?")
      .get(kbId, sinceIso) as { total: number };
    return Number(row.total);
  }

  countEdgesCreatedSince(kbId: string, sinceIso: string): number {
    const row = this.database
      .prepare("SELECT count(*) AS total FROM ke_edges WHERE kb_id = ? AND created_at >= ?")
      .get(kbId, sinceIso) as { total: number };
    return Number(row.total);
  }

  /** Succeeded extraction-job completion times, newest first (concept-
   *  saturation signal window). The job type literal is the orchestrator's
   *  ke_extract; ke_jobs carries the kb inside its JSON payload. */
  extractionCompletions(kbId: string, limit = 100): string[] {
    const rows = this.database
      .prepare(
        `SELECT updated_at FROM ke_jobs
         WHERE type = 'ke_extract' AND status = 'succeeded' AND json_extract(payload, '$.kbId') = ?
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(kbId, limit) as Array<{ updated_at: string }>;
    return rows.map((row) => row.updated_at);
  }

  /** All document dedup keys of a KB (Lincoln–Petersen marked population). */
  documentDedupKeys(kbId: string): { count: number; dedupKeys: string[] } {
    const rows = this.database.prepare("SELECT dedup_key FROM ke_documents WHERE kb_id = ?").all(kbId) as Array<{
      dedup_key: string;
    }>;
    return { count: rows.length, dedupKeys: rows.map((row) => row.dedup_key) };
  }

  /** Entities with their graph degree (for patch-query construction). */
  listEntitiesWithDegree(kbId: string): Array<KeEntityRow & { degree: number }> {
    const rows = this.database
      .prepare(
        `SELECT e.*, (SELECT count(*) FROM ke_edges WHERE kb_id = e.kb_id AND (src_id = e.id OR dst_id = e.id)) AS degree
         FROM ke_entities e WHERE e.kb_id = ?`,
      )
      .all(kbId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...mapEntity(row), degree: Number(row["degree"]) }));
  }

  /** Strongest co-occurring neighbor names per entity (patch-query text). */
  topNeighborNames(kbId: string, entityIds: readonly string[], perEntity: number): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const entityId of entityIds) {
      const rows = this.database
        .prepare(
          `SELECT n.name, count(*) AS weight FROM ke_edges e
           JOIN ke_entities n ON n.id = CASE WHEN e.src_id = ? THEN e.dst_id ELSE e.src_id END
           WHERE e.kb_id = ? AND (e.src_id = ? OR e.dst_id = ?)
           GROUP BY n.id ORDER BY weight DESC, n.name LIMIT ?`,
        )
        .all(entityId, kbId, entityId, entityId, perEntity) as Array<{ name: string }>;
      result.set(entityId, rows.map((row) => row.name));
    }
    return result;
  }

  /** Documents of a KB ordered for seed selection (newest first, id tiebreak).
   *  Only docs carrying a resolvable identity (source_uri or a stored
   *  paperRef) qualify — anything else would send a synthetic ref into
   *  citation resolution and waste the API call. */
  listDocumentsForSeeding(kbId: string, limit: number): KeDocumentRow[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM ke_documents
         WHERE kb_id = ? AND (source_uri IS NOT NULL OR json_extract(source_meta, '$.paperRef') IS NOT NULL)
         ORDER BY created_at DESC, id LIMIT ?`,
      )
      .all(kbId, limit) as Array<Record<string, unknown>>;
    return rows.map(mapDocument);
  }

  // -------------------------------------------------------------- citations

  /** Replace a document's citation rows (idempotent re-extraction; the whole
   *  per-doc set derives deterministically from the fulltext, so delete-then-
   *  insert is the correct re-derivation semantics). Duplicate (dstKey,
   *  sentence) pairs — the same rid cited twice in one sentence, or a
   *  multi-key anchor repeating a key — collapse to one row (the UNIQUE
   *  constraint would otherwise abort the whole insert). */
  replaceCitations(kbId: string, srcDocId: string, rows: readonly KeCitationInput[]): void {
    const insert = this.database.prepare(
      `INSERT INTO ke_citations (id, kb_id, src_doc_id, dst_doc_id, dst_key, sentence, section, intent, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const seen = new Set<string>();
    const deduped = rows.filter((row) => {
      const key = `${row.dstKey}\u0000${row.sentence}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.inTransaction(() => {
      this.database
        .prepare("DELETE FROM ke_citations WHERE kb_id = ? AND src_doc_id = ?")
        .run(kbId, srcDocId);
      for (const row of deduped) {
        insert.run(
          randomUUID(), kbId, srcDocId, row.dstDocId, row.dstKey, row.sentence,
          row.section, row.intent, row.confidence, now(),
        );
      }
    });
  }

  /** List citation rows with document titles joined for both ends. */
  listCitations(
    kbId: string,
    options: { intent?: string; srcDocId?: string; dstDocId?: string; limit?: number } = {},
  ): Array<KeCitationRow & { srcTitle: string | null; dstTitle: string | null }> {
    const limit = options.limit ?? 200;
    const clauses = ["c.kb_id = ?"];
    const params: Array<string | number> = [kbId];
    if (options.intent) {
      clauses.push("c.intent = ?");
      params.push(options.intent);
    }
    if (options.srcDocId) {
      clauses.push("c.src_doc_id = ?");
      params.push(options.srcDocId);
    }
    if (options.dstDocId) {
      clauses.push("c.dst_doc_id = ?");
      params.push(options.dstDocId);
    }
    params.push(Math.max(1, Math.min(limit, 500)));
    const rows = this.database
      .prepare(
        `SELECT c.*, src.title AS src_title, dst.title AS dst_title
         FROM ke_citations c
         JOIN ke_documents src ON src.id = c.src_doc_id
         LEFT JOIN ke_documents dst ON dst.id = c.dst_doc_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY c.created_at, c.dst_key, c.sentence, c.id LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...mapCitation(row),
      srcTitle: row["src_title"] === null ? null : String(row["src_title"]),
      dstTitle: row["dst_title"] === null ? null : String(row["dst_title"]),
    }));
  }

  /** Citation rows where any of the given documents is the citing (src) side. */
  listCitationsFromDocs(kbId: string, docIds: readonly string[], limit = 50): Array<KeCitationRow & { srcTitle: string | null; dstTitle: string | null }> {
    if (docIds.length === 0) return [];
    const placeholders = docIds.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT c.*, src.title AS src_title, dst.title AS dst_title
         FROM ke_citations c
         JOIN ke_documents src ON src.id = c.src_doc_id
         LEFT JOIN ke_documents dst ON dst.id = c.dst_doc_id
         WHERE c.kb_id = ? AND c.src_doc_id IN (${placeholders})
         ORDER BY c.created_at, c.dst_key, c.sentence, c.id LIMIT ?`,
      )
      .all(kbId, ...docIds, Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...mapCitation(row),
      srcTitle: row["src_title"] === null ? null : String(row["src_title"]),
      dstTitle: row["dst_title"] === null ? null : String(row["dst_title"]),
    }));
  }

  /** Per-doc citation counts for badge aggregation: outgoing (this doc
   *  cites) / incoming (KB docs citing this doc), each with the linked
   *  subset (rows whose dst resolved to a KB document). incomingResolved
   *  always equals incoming — incoming rows only exist via a resolved link
   *  — kept for shape symmetry with the outgoing pair. */
  citationStats(kbId: string): Map<string, { outgoing: number; outgoingResolved: number; incoming: number; incomingResolved: number }> {
    const stats = new Map<string, { outgoing: number; outgoingResolved: number; incoming: number; incomingResolved: number }>();
    const bump = (docId: string, kind: "outgoing" | "incoming", resolved: boolean) => {
      const entry = stats.get(docId) ?? { outgoing: 0, outgoingResolved: 0, incoming: 0, incomingResolved: 0 };
      entry[kind] += 1;
      if (resolved) entry[`${kind}Resolved`] += 1;
      stats.set(docId, entry);
    };
    const rows = this.database
      .prepare("SELECT src_doc_id, dst_doc_id FROM ke_citations WHERE kb_id = ?")
      .all(kbId) as Array<{ src_doc_id: string; dst_doc_id: string | null }>;
    for (const row of rows) {
      // Each row counts once toward its kind; the resolved counter is a
      // subset (rows with a linked dst), never an extra row.
      bump(row.src_doc_id, "outgoing", row.dst_doc_id !== null);
      if (row.dst_doc_id) {
        bump(row.dst_doc_id, "incoming", true);
      }
    }
    return stats;
  }

  // ---------------------------------------------------------------- formulae

  /** Replace a document's formula rows (idempotent re-extraction, same
   *  delete-then-insert semantics as citations). */
  replaceFormulae(kbId: string, docId: string, rows: readonly KeFormulaInput[]): void {
    const insert = this.database.prepare(
      `INSERT INTO ke_formulae (id, kb_id, doc_id, latex, display_latex, context, label, section, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.inTransaction(() => {
      this.database
        .prepare("DELETE FROM ke_formulae WHERE kb_id = ? AND doc_id = ?")
        .run(kbId, docId);
      for (const row of rows) {
        insert.run(
          randomUUID(), kbId, docId, row.latex, row.displayLatex, row.context, row.label, row.section, now(),
        );
      }
    });
  }

  /** List formula rows; `q` filters by LaTeX/label substring (LIKE). */
  listFormulae(
    kbId: string,
    options: { docId?: string; q?: string; limit?: number } = {},
  ): Array<KeFormulaRow & { docTitle: string | null }> {
    const limit = options.limit ?? 100;
    const clauses = ["f.kb_id = ?"];
    const params: Array<string | number> = [kbId];
    if (options.docId) {
      clauses.push("f.doc_id = ?");
      params.push(options.docId);
    }
    if (options.q && options.q.trim().length > 0) {
      clauses.push("(f.latex LIKE ? ESCAPE '\\' OR f.label LIKE ? ESCAPE '\\')");
      // LaTeX queries are full of backslashes — escape the escape char too,
      // or `q=\frac` silently degrades to a match on `frac`.
      const needle = `%${options.q.trim().replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
      params.push(needle, needle);
    }
    params.push(Math.max(1, Math.min(limit, 300)));
    const rows = this.database
      .prepare(
        `SELECT f.*, d.title AS doc_title
         FROM ke_formulae f
         JOIN ke_documents d ON d.id = f.doc_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY f.created_at, f.latex, f.id LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...mapFormula(row),
      docTitle: row["doc_title"] === null ? null : String(row["doc_title"]),
    }));
  }

  // --------------------------------------------- proposal-validation rejects

  /** Cap per extraction run — evidence sampling, not unbounded logging. */
  static readonly MAX_RECORDED_REJECTS = 50;

  /** Persist final-state proposal rejects (after corrective retries ran out). */
  recordProposalRejects(
    kbId: string,
    docId: string,
    rejects: ReadonlyArray<{ section: string; index: number; reason: string; excerpt: string }>,
    options: { jobId?: string; attempts?: number } = {},
  ): number {
    if (rejects.length === 0) return 0;
    const insert = this.database.prepare(
      `INSERT INTO ke_proposal_rejects (id, kb_id, doc_id, job_id, section, item_index, reason, excerpt, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const capped = rejects.slice(0, KnowledgeEngineStore.MAX_RECORDED_REJECTS);
    const timestamp = now();
    this.inTransaction(() => {
      for (const reject of capped) {
        insert.run(
          randomUUID(),
          kbId,
          docId,
          options.jobId ?? null,
          reject.section,
          reject.index,
          reject.reason,
          reject.excerpt,
          options.attempts ?? 1,
          timestamp,
        );
      }
    });
    return capped.length;
  }

  listProposalRejects(
    kbId: string,
    options: { docId?: string; limit?: number } = {},
  ): Array<{
    id: string; docId: string; jobId: string | null; section: string; index: number;
    reason: string; excerpt: string; attempts: number; createdAt: string;
  }> {
    const clauses = ["r.kb_id = ?"];
    const params: Array<string | number> = [kbId];
    if (options.docId) {
      clauses.push("r.doc_id = ?");
      params.push(options.docId);
    }
    params.push(Math.max(1, Math.min(options.limit ?? 100, 500)));
    const rows = this.database
      .prepare(
        `SELECT r.* FROM ke_proposal_rejects r
         WHERE ${clauses.join(" AND ")}
         ORDER BY r.created_at DESC, r.id LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row["id"]),
      docId: String(row["doc_id"]),
      jobId: row["job_id"] === null ? null : String(row["job_id"]),
      section: String(row["section"]),
      index: Number(row["item_index"]),
      reason: String(row["reason"]),
      excerpt: String(row["excerpt"]),
      attempts: Number(row["attempts"]),
      createdAt: String(row["created_at"]),
    }));
  }

  // ------------------------------------------------------ doc chunks (Z8)

  /** Replace one document's chunk rows (idempotent rewrite). Embeddings of
   *  anchors that survive the rewrite are PRESERVED: a re-extraction during
   *  an embedding outage must not silently wipe the KB back to keyword-only. */
  replaceDocChunks(
    kbId: string,
    docId: string,
    chunks: ReadonlyArray<{ anchorId: string; blockType: string; section: string | null; text: string }>,
  ): number {
    if (chunks.length === 0) return 0;
    const insert = this.database.prepare(
      `INSERT INTO ke_doc_chunks (id, kb_id, doc_id, anchor_id, block_type, section, chunk_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const reapplyEmbedding = this.database.prepare(
      "UPDATE ke_doc_chunks SET embedding = ? WHERE doc_id = ? AND anchor_id = ?",
    );
    const timestamp = now();
    this.inTransaction(() => {
      const existing = new Map<string, Uint8Array>();
      const prior = this.database
        .prepare("SELECT anchor_id, embedding FROM ke_doc_chunks WHERE doc_id = ? AND embedding IS NOT NULL")
        .all(docId) as Array<Record<string, unknown>>;
      for (const row of prior) existing.set(String(row["anchor_id"]), row["embedding"] as Uint8Array);
      this.database.prepare("DELETE FROM ke_doc_chunks WHERE doc_id = ?").run(docId);
      for (const chunk of chunks) {
        insert.run(randomUUID(), kbId, docId, chunk.anchorId, chunk.blockType, chunk.section, chunk.text, timestamp);
        const embedding = existing.get(chunk.anchorId);
        if (embedding) reapplyEmbedding.run(embedding, docId, chunk.anchorId);
      }
    });
    return chunks.length;
  }

  /** Attach embeddings to a document's chunks by anchor (absent anchors are
   *  skipped — a partial embed never fails the batch). */
  updateDocChunkEmbeddings(
    docId: string,
    vectorsByAnchor: ReadonlyMap<string, Uint8Array>,
  ): number {
    const statement = this.database.prepare("UPDATE ke_doc_chunks SET embedding = ? WHERE doc_id = ? AND anchor_id = ?");
    let updated = 0;
    this.inTransaction(() => {
      for (const [anchorId, blob] of vectorsByAnchor) {
        const result = statement.run(blob, docId, anchorId);
        updated += Number(result.changes);
      }
    });
    return updated;
  }

  /** Embedded chunks for the vector retrieval arm (bounded scan). */
  listDocChunksWithEmbedding(
    kbId: string,
    limit = 2_000,
  ): Array<{ docId: string; anchorId: string; text: string; embedding: Uint8Array }> {
    const rows = this.database
      .prepare(
        `SELECT doc_id, anchor_id, chunk_text, embedding FROM ke_doc_chunks
         WHERE kb_id = ? AND embedding IS NOT NULL
         ORDER BY created_at, anchor_id LIMIT ?`,
      )
      .all(kbId, Math.max(1, Math.min(limit, 10_000))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      docId: String(row["doc_id"]),
      anchorId: String(row["anchor_id"]),
      text: String(row["chunk_text"]),
      embedding: row["embedding"] as Uint8Array,
    }));
  }

  countDocChunks(kbId: string): { total: number; embedded: number } {
    const row = this.database
      .prepare(
        `SELECT count(*) AS total, sum(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
         FROM ke_doc_chunks WHERE kb_id = ?`,
      )
      .get(kbId) as { total: number; embedded: number | null };
    return { total: Number(row.total), embedded: Number(row.embedded ?? 0) };
  }

  /** Similar documents by shared-entity count (ke_entity_docs overlap) —
   *  the honest zero-vector "Similar" signal: papers citing into the same
   *  entity set. Ties break on doc id for determinism. */
  similarDocuments(kbId: string, docId: string, limit = 5): Array<{ docId: string; title: string; sharedEntities: number }> {
    const rows = this.database
      .prepare(
        `SELECT d.id AS doc_id, d.title AS title, COUNT(DISTINCT ed2.entity_id) AS shared
         FROM ke_entity_docs ed1
         JOIN ke_entity_docs ed2
           ON ed1.entity_id = ed2.entity_id AND ed2.doc_id != ed1.doc_id AND ed2.kb_id = ?
         JOIN ke_documents d ON d.id = ed2.doc_id
         WHERE ed1.doc_id = ?
         GROUP BY d.id
         ORDER BY shared DESC, d.id
         LIMIT ?`,
      )
      .all(kbId, docId, Math.max(1, Math.min(limit, 20))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      docId: String(row["doc_id"]),
      title: String(row["title"] ?? ""),
      sharedEntities: Number(row["shared"] ?? 0),
    }));
  }
}

// ------------------------------------------------------------------ mappers

function mapKb(row: Record<string, unknown>): KnowledgeBaseRow {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    description: String(row["description"] ?? ""),
    engineState: parseJson(row["engine_state"], {}),
    createdAt: String(row["created_at"]),
  };
}

function mapDocument(row: Record<string, unknown>): KeDocumentRow {
  return {
    id: String(row["id"]),
    kbId: String(row["kb_id"]),
    sourceUri: (row["source_uri"] as string | null) ?? null,
    dedupKey: String(row["dedup_key"]),
    title: String(row["title"] ?? ""),
    authors: parseJson<string[]>(row["authors"], []),
    year: (row["year"] as number | null) ?? null,
    venue: (row["venue"] as string | null) ?? null,
    abstract: (row["abstract"] as string | null) ?? null,
    fulltext: (row["fulltext"] as string | null) ?? null,
    refIds: parseJson<string[]>(row["ref_ids"], []),
    status: String(row["status"]) as KeDocumentStatus,
    sourceMeta: parseJson<Record<string, unknown>>(row["source_meta"], {}),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function mapCitation(row: Record<string, unknown>): KeCitationRow {
  return {
    id: String(row["id"]),
    kbId: String(row["kb_id"]),
    srcDocId: String(row["src_doc_id"]),
    dstDocId: (row["dst_doc_id"] as string | null) ?? null,
    dstKey: String(row["dst_key"]),
    sentence: String(row["sentence"]),
    section: (row["section"] as string | null) ?? null,
    intent: (row["intent"] as string | null) ?? null,
    confidence: (row["confidence"] as number | null) ?? null,
    createdAt: String(row["created_at"]),
  };
}

function mapFormula(row: Record<string, unknown>): KeFormulaRow {
  return {
    id: String(row["id"]),
    kbId: String(row["kb_id"]),
    docId: String(row["doc_id"]),
    latex: String(row["latex"]),
    displayLatex: String(row["display_latex"]),
    context: String(row["context"]),
    label: (row["label"] as string | null) ?? null,
    section: (row["section"] as string | null) ?? null,
    createdAt: String(row["created_at"]),
  };
}

function mapEntity(row: Record<string, unknown>): KeEntityRow {
  const embedding = row["embedding"];
  return {
    id: String(row["id"]),
    kbId: String(row["kb_id"]),
    name: String(row["name"]),
    normalizedName: String(row["normalized_name"]),
    type: String(row["type"]),
    description: (row["description"] as string | null) ?? null,
    aliases: parseJson<string[]>(row["aliases"], []),
    embedding: embedding instanceof Uint8Array ? embedding : null,
    supportCount: Number(row["support_count"]),
    trustLevel: String(row["trust_level"] ?? "candidate"),
    firstSeenDoc: (row["first_seen_doc"] as string | null) ?? null,
    communityId: (row["community_id"] as number | null) ?? null,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function mapEdge(row: Record<string, unknown>): KeEdgeRow {
  return {
    id: String(row["id"]),
    kbId: String(row["kb_id"]),
    srcId: String(row["src_id"]),
    dstId: String(row["dst_id"]),
    type: String(row["type"]),
    evidenceQuote: (row["evidence_quote"] as string | null) ?? null,
    evidenceDocId: (row["evidence_doc_id"] as string | null) ?? null,
    supportCount: Number(row["support_count"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function mapCommunityReport(row: Record<string, unknown>): KeCommunityReportRow {
  return {
    id: String(row["id"]),
    kbId: String(row["kb_id"]),
    fingerprint: String(row["fingerprint"]),
    communityId: Number(row["community_id"]),
    title: String(row["title"]),
    summary: String(row["summary"]),
    rating: row["rating"] === null || row["rating"] === undefined ? null : Number(row["rating"]),
    ratingExplanation: (row["rating_explanation"] as string | null) ?? null,
    findings: String(row["findings"]),
    status: String(row["status"]) === "error" ? "error" : "ready",
    error: (row["error"] as string | null) ?? null,
    model: (row["model"] as string | null) ?? null,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function mapMerge(row: Record<string, unknown>): KeEntityMergeRow {
  return {
    id: String(row["id"]),
    kbId: String(row["kb_id"]),
    canonicalId: String(row["canonical_id"]),
    absorbedId: String(row["absorbed_id"]),
    absorbedSnapshot: parseJson<Record<string, unknown>>(row["absorbed_snapshot"], {}),
    decidedBy: String(row["decided_by"]),
    score: (row["score"] as number | null) ?? null,
    judgeRationale: (row["judge_rationale"] as string | null) ?? null,
    jobId: (row["job_id"] as string | null) ?? null,
    undoneAt: (row["undone_at"] as string | null) ?? null,
    createdAt: String(row["created_at"]),
  };
}

function mapJob(row: Record<string, unknown>): KeJobRow {
  return {
    id: String(row["id"]),
    type: String(row["type"]),
    payload: parseJson<Record<string, unknown>>(row["payload"], {}),
    status: String(row["status"]) as KeJobStatus,
    attempts: Number(row["attempts"]),
    maxAttempts: Number(row["max_attempts"]),
    runAfter: String(row["run_after"]),
    error: (row["error"] as string | null) ?? null,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function mapFrontier(row: Record<string, unknown>): KeFrontierRow {
  return {
    id: String(row["id"]),
    kbId: String(row["kb_id"]),
    cycleId: String(row["cycle_id"]),
    paperRef: parseJson<Record<string, unknown>>(row["paper_ref"], {}),
    dedupKey: String(row["dedup_key"]),
    depth: Number(row["depth"]),
    relevanceScore: (row["relevance_score"] as number | null) ?? null,
    parentId: (row["parent_id"] as string | null) ?? null,
    source: String(row["source"] ?? "backward_citation"),
    sources: parseJson<string[]>(row["sources"], []),
    citeHits: Number(row["cite_hits"]),
    attempts: Number(row["attempts"]),
    status: String(row["status"]) as KeFrontierStatus,
    expandedAt: (row["expanded_at"] as string | null) ?? null,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

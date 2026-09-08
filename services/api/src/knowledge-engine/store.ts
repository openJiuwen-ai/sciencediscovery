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
    this.database
      .prepare("UPDATE knowledge_bases SET engine_state = ? WHERE id = ?")
      .run(JSON.stringify(engineState ?? {}), kbId);
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
    firstSeenDoc?: string | null;
    incrementSupport?: boolean;
  }): KeEntityRow {
    const normalizedName = normalizeEntityName(input.name);
    const timestamp = now();
    return this.inTransaction(() => {
      const existing = this.database
        .prepare("SELECT * FROM ke_entities WHERE kb_id = ? AND normalized_name = ? AND type = ?")
        .get(input.kbId, normalizedName, input.type) as Record<string, unknown> | undefined;
      if (!existing) {
        const id = randomUUID();
        this.database
          .prepare(
            `INSERT INTO ke_entities
               (id, kb_id, name, normalized_name, type, description, aliases, support_count, first_seen_doc, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, '[]', 1, ?, ?, ?)`,
          )
          .run(id, input.kbId, input.name, normalizedName, input.type, input.description ?? null, input.firstSeenDoc ?? null, timestamp, timestamp);
      } else {
        const aliases = parseJson<string[]>(existing["aliases"], []);
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
        this.database
          .prepare(
            `UPDATE ke_entities SET
               support_count = support_count + ?, aliases = ?,
               description = coalesce(?, description), updated_at = ?
             WHERE id = ?`,
          )
          .run(input.incrementSupport === false ? 0 : 1, JSON.stringify(aliases), input.description ?? null, timestamp, existing["id"] as string);
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
    const rows = (
      options.entityId
        ? this.database
            .prepare("SELECT * FROM ke_edges WHERE kb_id = ? AND (src_id = ? OR dst_id = ?) ORDER BY id LIMIT ?")
            .all(kbId, options.entityId, options.entityId, limit)
        : this.database.prepare("SELECT * FROM ke_edges WHERE kb_id = ? ORDER BY id LIMIT ?").all(kbId, limit)
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
    // dead/succeeded row by a stale caller).
    this.database
      .prepare("UPDATE ke_jobs SET status = 'succeeded', updated_at = ? WHERE id = ? AND status = 'running'")
      .run(now(), id);
  }

  /**
   * Record a job failure. Below maxAttempts the job is rescheduled with
   * exponential backoff; at the cap it becomes 'dead' and stops consuming
   * retries (the doom-loop guard). Only an in-flight job may fail.
   */
  failJob(id: string, error: string, options: { backoffBaseMs?: number } = {}): KeJobRow {
    const job = this.getJob(id);
    if (!job) {
      throw new Error(`ke_job ${id} not found`);
    }
    const timestamp = now();
    if (job.status !== "running") {
      return job;
    }
    if (job.attempts >= job.maxAttempts) {
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
      .prepare(`SELECT * FROM ke_jobs ${where} ORDER BY created_at, id LIMIT ?`)
      .all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map(mapJob);
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

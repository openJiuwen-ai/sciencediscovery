// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, readlink, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Pool = "data" | "agent-state";
export interface ObjectRef<P extends Pool = Pool> {
  pool: P;
  digest: `sha256:${string}`;
  size: number;
  mediaType: string;
}
export type DataRef = ObjectRef<"data">;
export type AgentStateRef = ObjectRef<"agent-state">;
export const RECORD_MEDIA_TYPE = "application/vnd.sciencediscovery.record.v1+json";
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** RFC 8785: ECMAScript numbers, UTF-16 key ordering, no Unicode normalization. */
export function canonicalize(value: unknown): string {
  const active = new Set<object>();
  const encode = (v: unknown): string => {
    if (v === null || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "string") {
      if (!v.isWellFormed()) throw new Error("JCS rejects lone surrogates");
      return JSON.stringify(v);
    }
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== "object" || !v) throw new Error("JCS requires JSON values");
    if (active.has(v)) throw new Error("JCS rejects cycles");
    active.add(v);
    try {
      if (Array.isArray(v)) return `[${Array.from(v, encode).join(",")}]`;
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
        throw new Error("JCS requires plain objects");
      }
      return `{${Object.keys(v).sort().map((key) => `${encode(key)}:${encode((v as Record<string, unknown>)[key])}`).join(",")}}`;
    } finally { active.delete(v); }
  };
  return encode(value);
}

export function assertRef(ref: ObjectRef, pool?: Pool): void {
  if (!ref || (ref.pool !== "data" && ref.pool !== "agent-state") || (pool && ref.pool !== pool)
    || !/^sha256:[a-f0-9]{64}$/.test(ref.digest) || !Number.isSafeInteger(ref.size) || ref.size < 0
    || typeof ref.mediaType !== "string" || !ref.mediaType) throw new Error("Invalid or cross-pool reference");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Publish without replacing existing bytes, including under concurrent writers. */
async function publish(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally { await file.close(); }
    try { await link(temporary, path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await readFile(path)).equals(bytes)) throw new Error(`Corrupt immutable object: ${path}`);
    }
    await syncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }); }
}

export interface RecordObject<T = unknown> {
  schemaVersion: 1;
  kind: string;
  value: T;
  dependencies: ObjectRef[];
}

/** Each pool is a standalone OCI image layout. Live refs are owned by SQLite, not index.json. */
export class VersionStore {
  private initialized?: Promise<void>;
  constructor(readonly dataDir: string) {}

  poolRoot(pool: Pool): string { return resolve(this.dataDir, "versioning", pool); }

  async initialize(): Promise<void> {
    this.initialized ??= (async () => {
      for (const pool of ["data", "agent-state"] as const) {
        const root = this.poolRoot(pool);
        await mkdir(resolve(root, "blobs", "sha256"), { recursive: true });
        await publish(resolve(root, "oci-layout"), Buffer.from('{"imageLayoutVersion":"1.0.0"}'));
        await publish(resolve(root, "index.json"), Buffer.from('{"schemaVersion":2,"manifests":[]}'));
        await syncDirectory(resolve(root, "blobs"));
        await syncDirectory(root);
      }
      await syncDirectory(resolve(this.dataDir, "versioning"));
      await syncDirectory(this.dataDir);
    })();
    return this.initialized;
  }

  objectPath(ref: ObjectRef): string {
    assertRef(ref);
    return resolve(this.poolRoot(ref.pool), "blobs", "sha256", ref.digest.slice(7));
  }

  async put<P extends Pool>(pool: P, content: string | Buffer, mediaType = "application/octet-stream"): Promise<ObjectRef<P>> {
    await this.initialize();
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const ref: ObjectRef<P> = { pool, digest: `sha256:${hash(bytes)}`, size: bytes.length, mediaType };
    await publish(this.objectPath(ref), bytes);
    return ref;
  }

  async putFile<P extends Pool>(pool: P, source: string): Promise<ObjectRef<P>> {
    const input = await open(source, "r");
    try { return await this.putStream(pool, input.createReadStream({ autoClose: false })); }
    finally { await input.close(); }
  }

  async putStream<P extends Pool>(pool: P, source: AsyncIterable<Buffer | string>): Promise<ObjectRef<P>> {
    await this.initialize();
    const directory = resolve(this.poolRoot(pool), "blobs", "sha256");
    const temporary = resolve(directory, `${randomUUID()}.tmp`);
    const digest = createHash("sha256");
    let size = 0;
    try {
      const output = await open(temporary, "wx", 0o600);
      try {
        for await (const chunk of source) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          digest.update(bytes); size += bytes.length;
          // writeFile handles short writes; stream chunks stay bounded in memory.
          await output.writeFile(bytes);
        }
        await output.sync();
      } finally { await output.close(); }
      const ref: ObjectRef<P> = { pool, digest: `sha256:${digest.digest("hex")}`, size, mediaType: "application/octet-stream" };
      try { await link(temporary, this.objectPath(ref)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.verifyRef(ref);
      }
      await syncDirectory(directory);
      return ref;
    } finally { await rm(temporary, { force: true }); }
  }

  async verifyRef(ref: ObjectRef): Promise<void> {
    const file = await open(this.objectPath(ref), "r");
    const digest = createHash("sha256"); let size = 0;
    try {
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        const bytes = chunk as Buffer; size += bytes.length; digest.update(bytes);
      }
    } finally { await file.close(); }
    if (size !== ref.size || digest.digest("hex") !== ref.digest.slice(7)) throw new Error("Object integrity failure");
  }

  async readData(ref: DataRef): Promise<Buffer> { assertRef(ref, "data"); return this.read(ref); }
  async readState(ref: AgentStateRef): Promise<Buffer> { assertRef(ref, "agent-state"); return this.read(ref); }

  async read(ref: ObjectRef): Promise<Buffer> {
    const bytes = await readFile(this.objectPath(ref));
    if (bytes.length !== ref.size || hash(bytes) !== ref.digest.slice(7)) throw new Error("Object integrity failure");
    return bytes;
  }

  async putRecord<T>(kind: string, value: T, dependencies: ObjectRef[] = []): Promise<AgentStateRef> {
    for (const ref of dependencies) assertRef(ref);
    // Dependencies embedded in values cannot silently escape closure validation.
    const found = new Map<string, ObjectRef>();
    const visit = (v: unknown): void => {
      if (!v || typeof v !== "object") return;
      if ("pool" in v && "digest" in v) {
        const ref = v as ObjectRef;
        assertRef(ref);
        found.set(canonicalize(ref), ref);
      } else for (const child of Object.values(v)) visit(child);
    };
    canonicalize(value); // reject cycles before traversing
    visit(value);
    for (const ref of dependencies) found.set(canonicalize(ref), ref);
    const record: RecordObject<T> = { schemaVersion: 1, kind, value, dependencies: [...found.values()].sort((a, b) => canonicalize(a) < canonicalize(b) ? -1 : canonicalize(a) > canonicalize(b) ? 1 : 0) };
    return this.put("agent-state", canonicalize(record), RECORD_MEDIA_TYPE);
  }

  async readRecord<T = unknown>(ref: AgentStateRef, kind?: string): Promise<RecordObject<T>> {
    assertRef(ref, "agent-state");
    if (ref.mediaType !== RECORD_MEDIA_TYPE) throw new Error("Expected record media type");
    const bytes = await this.readState(ref);
    const record = JSON.parse(bytes.toString("utf8")) as RecordObject<T>;
    if (record.schemaVersion !== 1 || typeof record.kind !== "string" || !Array.isArray(record.dependencies)
      || (kind && record.kind !== kind) || canonicalize(record) !== bytes.toString("utf8")) throw new Error("Unsupported or invalid record schema");
    const declared = new Set(record.dependencies.map((dependency) => { assertRef(dependency); return canonicalize(dependency); }));
    const verifyEdges = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if ("pool" in value && "digest" in value) {
        assertRef(value as ObjectRef);
        if (!declared.has(canonicalize(value))) throw new Error("Undeclared record dependency");
      } else for (const child of Object.values(value)) verifyEdges(child);
    };
    verifyEdges(record.value);
    return record;
  }

  async validateClosure(root: AgentStateRef): Promise<number> {
    const visited = new Set<string>();
    const pending: ObjectRef[] = [root];
    while (pending.length) {
      const ref = pending.pop()!;
      assertRef(ref);
      const key = canonicalize(ref);
      if (visited.has(key)) continue;
      visited.add(key);
      if (ref.mediaType === RECORD_MEDIA_TYPE) {
        assertRef(ref, "agent-state");
        const record = await this.readRecord(ref as AgentStateRef);
        pending.push(...record.dependencies);
      } else await this.verifyRef(ref);
    }
    return visited.size;
  }
}

export type TreeEntry =
  | { name: string; type: "file"; executable: number; content: DataRef }
  | { name: string; type: "directory"; tree: AgentStateRef }
  | { name: string; type: "symlink"; target: string };
export interface WorkspaceTree { entries: TreeEntry[] }

/** Caller must settle workspace writers first. Never follow symlinks, including raw-byte names. */
export async function snapshotWorkspace(store: VersionStore, root: string): Promise<AgentStateRef> {
  const scan = async (path: Buffer): Promise<AgentStateRef> => {
    const before = await lstat(path, { bigint: true });
    if (!before.isDirectory()) throw new Error("Workspace root must be a directory, not a symlink");
    const names = (await readdir(path, { encoding: "buffer" })).sort(Buffer.compare);
    const entries: TreeEntry[] = [];
    for (const name of names) {
      const child = Buffer.concat([path, Buffer.from("/"), name]);
      const info = await lstat(child, { bigint: true });
      const encoded = name.toString("base64url");
      if (info.isSymbolicLink()) {
        entries.push({ name: encoded, type: "symlink", target: (await readlink(child, { encoding: "buffer" })).toString("base64url") });
      } else if (info.isDirectory()) {
        entries.push({ name: encoded, type: "directory", tree: await scan(child) });
      } else if (info.isFile()) {
        const file = await open(child, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let content: DataRef;
        try {
          const opened = await file.stat({ bigint: true });
          if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error("Workspace changed during snapshot");
          content = await store.putStream("data", file.createReadStream({ autoClose: false }));
          const after = await file.stat({ bigint: true });
          if (opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs) throw new Error("Workspace changed during snapshot");
        } finally { await file.close(); }
        entries.push({ name: encoded, type: "file", executable: Number(info.mode & 0o111n), content });
      } else throw new Error("Workspace snapshot rejects FIFO, socket and device files");
      const after = await lstat(child, { bigint: true });
      if (info.ino !== after.ino || info.dev !== after.dev || info.ctimeNs !== after.ctimeNs) throw new Error("Workspace changed during snapshot");
    }
    const after = await lstat(path, { bigint: true });
    if (before.ino !== after.ino || before.ctimeNs !== after.ctimeNs) throw new Error("Workspace changed during snapshot");
    return store.putRecord("WorkspaceTree", { entries } satisfies WorkspaceTree);
  };
  return scan(Buffer.from(resolve(root)));
}

export class RefConflictError extends Error {}

export class RefStore {
  private constructor(private readonly db: DatabaseSync) {}

  static async open(store: VersionStore): Promise<RefStore> {
    await store.initialize();
    const db = new DatabaseSync(resolve(store.dataDir, "versioning", "refs.sqlite"));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS live_refs (name TEXT PRIMARY KEY, target TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history_refs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, target TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS history_by_name ON history_refs(name, id);`);
    return new RefStore(db);
  }

  head(name: string): AgentStateRef | null {
    const row = this.db.prepare("SELECT target FROM live_refs WHERE name=?").get(name);
    return row ? JSON.parse(row.target as string) as AgentStateRef : null;
  }

  history(name: string): AgentStateRef[] {
    return this.db.prepare("SELECT target FROM history_refs WHERE name=? ORDER BY id").all(name)
      .map((row) => JSON.parse(row.target as string) as AgentStateRef);
  }

  roots(): AgentStateRef[] {
    return this.db.prepare("SELECT target FROM live_refs UNION SELECT target FROM history_refs").all()
      .map((row) => JSON.parse(row.target as string) as AgentStateRef);
  }

  /** Closure is checked immediately before entering the synchronous transaction. No deletion API exists. */
  async commit(store: VersionStore, name: string, expected: AgentStateRef | null, target: AgentStateRef,
    fault?: (point: "before-transaction" | "after-live-ref") => void): Promise<void> {
    if (!name || name.length > 512 || /[\x00-\x1f]/.test(name)) throw new Error("Invalid ref name");
    assertRef(target, "agent-state");
    await store.validateClosure(target);
    fault?.("before-transaction");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (canonicalize(this.head(name)) !== canonicalize(expected)) throw new RefConflictError("Agent head changed");
      this.db.prepare("INSERT INTO live_refs(name,target) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET target=excluded.target").run(name, canonicalize(target));
      fault?.("after-live-ref");
      this.db.prepare("INSERT INTO history_refs(name,target) VALUES(?,?)").run(name, canonicalize(target));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  close(): void { this.db.close(); }
}

export interface TrajectoryStep {
  agentId: string;
  trajectoryId: string;
  turn: number;
  parent: AgentStateRef | null;
  revision: AgentStateRef;
  before: AgentStateRef;
  after: AgentStateRef;
  context: AgentStateRef;
  modelContext: AgentStateRef;
  actions: AgentStateRef[];
  childTrajectories: AgentStateRef[];
  eventSegments: { stream: string; start: number; end: number; events: AgentStateRef }[];
}

/** One queue per coordinator; SQLite expected-head comparison also protects independent processes. */
export class StepCommitCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: VersionStore, private readonly refs: RefStore, readonly name: string) {}

  commit(step: TrajectoryStep, fault?: Parameters<RefStore["commit"]>[4]): Promise<AgentStateRef> {
    const operation = this.tail.then(async () => {
      if (!Number.isSafeInteger(step.turn) || step.turn < 0 || !step.agentId || !step.trajectoryId) throw new Error("Invalid Step identity");
      await this.store.readRecord(step.revision, "AgentRevision");
      await this.store.readRecord(step.context, "ContextAssemblyRecord");
      await this.store.readRecord(step.modelContext, "ModelContextSnapshot");
      for (const stateRef of [step.before, step.after]) {
        const state = (await this.store.readRecord<{ agentId: string; agentRevision: AgentStateRef }>(stateRef, "AgentStateSnapshot")).value;
        if (state.agentId !== step.agentId || canonicalize(state.agentRevision) !== canonicalize(step.revision)) throw new Error("Step state belongs to a different Agent or Revision");
      }
      if (step.parent) {
        const parent = (await this.store.readRecord<TrajectoryStep>(step.parent, "TrajectoryStep")).value;
        if (parent.agentId !== step.agentId) throw new Error("Step parent belongs to a different Agent");
      }
      for (const child of step.childTrajectories) await this.store.readRecord(child, "TrajectoryStep");
      for (const segment of step.eventSegments) {
        if (!Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end) || segment.start < 0 || segment.end < segment.start) throw new Error("Invalid event range");
        const value = (await this.store.readRecord<{ stream: string; events: unknown[] }>(segment.events, "EventSegment")).value;
        if (value.stream !== segment.stream || value.events.length !== segment.end - segment.start) throw new Error("Event segment mismatch");
      }
      const ref = await this.store.putRecord("TrajectoryStep", step);
      await this.refs.commit(this.store, this.name, step.parent, ref, fault);
      return ref;
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}

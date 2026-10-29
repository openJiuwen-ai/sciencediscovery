// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, readlink, rm, type FileHandle } from "node:fs/promises";
import { dirname, resolve, toNamespacedPath } from "node:path";
import { DatabaseSync } from "node:sqlite";

// [windows-desktop] Windows cannot fsync a directory handle (EPERM), so
// directory durability goes through the platform facade (posix: fsync, win32: no-op).
import { syncDirectory } from "./platform/index.js";

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

interface ObjectIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

/** Stored-object identity; mediaType only decides whether the bytes are parsed as a record. */
const admissionKey = (ref: ObjectRef): string => `${ref.pool}:${ref.digest}:${ref.size}`;

/** Each pool is a standalone OCI image layout. Live refs are owned by SQLite, not index.json. */
export class VersionStore {
  private initialized?: Promise<void>;
  /**
   * Objects this instance has verified, mapped to whether they were verified as
   * a record together with their whole dependency closure. CAS objects are
   * never rewritten or deleted, so ref commits stop at admitted objects instead
   * of rehashing history. Trust boundary: nothing outside this store changes an
   * object after this process verified it. Admission says only that this instance
   * saw those bytes; existence is re-checked on every admitted read, and reads,
   * full audits and new instances still rehash. File metadata is never taken as
   * evidence of content.
   */
  private readonly admitted = new Map<string, boolean>();
  /** Bumped when admission is revoked, so an in-flight validation cannot re-admit a stale closure. */
  private admissionGeneration = 0;
  /** Refs whose bytes this store hashed; reuse still re-derives the source digest on every call. */
  private readonly workspaceFiles = new Map<string, { source: ObjectIdentity; ref: DataRef }>();
  constructor(readonly dataDir: string) {}

  /**
   * Reuse only bytes this store has already hashed, after re-deriving the digest of the
   * current bytes and re-verifying the stored object. Metadata narrows the work but is
   * never evidence: a same-size in-place rewrite keeps every stat field of its tick.
   * The source bytes are re-hashed on every call; the stored object is verified once per
   * store instance, because it is content-addressed and this process writes it once.
   */
  async putWorkspaceFile(path: Buffer, file: FileHandle): Promise<DataRef> {
    const key = path.toString("base64");
    const before = await file.stat({ bigint: true });
    const cached = this.workspaceFiles.get(key);
    if (cached && this.sameIdentity(before, cached.source)) {
      const source = await this.unchangedWorkspaceBytes(file, before, cached.ref);
      if (source) { this.workspaceFiles.set(key, { source, ref: cached.ref }); return cached.ref; }
    }
    const ref = await this.putStream("data", file.createReadStream({ autoClose: false, start: 0 }));
    const after = await file.stat({ bigint: true });
    if (!this.sameIdentity(before, after)) throw new Error("Workspace changed during snapshot");
    this.workspaceFiles.set(key, { source: after, ref });
    return ref;
  }

  /**
   * The post-read identity when the handle still holds exactly the cached bytes and the
   * stored object still verifies; undefined means the bytes must be republished. An object
   * this instance already verified is admitted instead of read a second time.
   */
  private async unchangedWorkspaceBytes(file: FileHandle, before: ObjectIdentity, ref: DataRef): Promise<ObjectIdentity | undefined> {
    const digest = createHash("sha256"); let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) {
      const bytes = chunk as Buffer; digest.update(bytes); size += bytes.length;
    }
    if (size !== ref.size || digest.digest("hex") !== ref.digest.slice(7)) return undefined;
    const key = admissionKey(ref);
    if (this.admitted.has(key)) {
      // An object can disappear under a live process (restore, cleanup of the same dataDir, disk
      // fault), and admission covers the bytes, not their continued presence. Re-checking existence
      // keeps the republish path self-healing for a cost that is noise next to the source re-hash.
      await this.dropIfVanished(ref);
      if (!this.admitted.has(key)) return undefined;
    } else {
      try { await this.verifyRef(ref); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
      }
      this.admitted.set(key, false); // verified here as a non-record; `checked` revokes it on any integrity failure
    }
    const after = await file.stat({ bigint: true });
    if (!this.sameIdentity(before, after)) throw new Error("Workspace changed during snapshot");
    return after;
  }

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
    await this.checked(ref, () => publish(this.objectPath(ref), bytes));
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
    return this.checked(ref, async () => {
      const file = await open(this.objectPath(ref), "r");
      const digest = createHash("sha256"); let size = 0;
      try {
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          const bytes = chunk as Buffer; size += bytes.length; digest.update(bytes);
        }
      } finally { await file.close(); }
      if (size !== ref.size || digest.digest("hex") !== ref.digest.slice(7)) throw new Error("Object integrity failure");
    });
  }

  async readData(ref: DataRef): Promise<Buffer> { assertRef(ref, "data"); return this.read(ref); }
  async readState(ref: AgentStateRef): Promise<Buffer> { assertRef(ref, "agent-state"); return this.read(ref); }

  async read(ref: ObjectRef): Promise<Buffer> {
    return this.checked(ref, async () => {
      const bytes = await readFile(this.objectPath(ref));
      if (bytes.length !== ref.size || hash(bytes) !== ref.digest.slice(7)) throw new Error("Object integrity failure");
      return bytes;
    });
  }

  /** A missing or corrupt admitted object is tampering evidence: stop trusting any admission. */
  private async checked<T>(ref: ObjectRef, operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (this.admitted.has(admissionKey(ref))) { this.admitted.clear(); this.admissionGeneration++; }
      throw error;
    }
  }

  /**
   * Admission is existence evidence, not content evidence, and the guard is one-directional — a hit
   * proves only that a regular file is still there, never that its bytes are the ones verified. A
   * missing object, or one replaced by a directory or a symlink, revokes every admission so the caller
   * falls back to its own read or verify path, which fails closed on bytes that are not there.
   */
  private async dropIfVanished(ref: ObjectRef): Promise<void> {
    try { if ((await lstat(this.objectPath(ref))).isFile()) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.admitted.clear();
    this.admissionGeneration++;
  }

  async putRecord<T>(kind: string, value: T, dependencies: ObjectRef[] = []): Promise<AgentStateRef> {
    for (const ref of dependencies) assertRef(ref);
    // Dependencies embedded in values cannot silently escape closure validation.
    const found = new Map<string, ObjectRef>();
    const visit = (v: unknown, path = "$"): void => {
      if (!v || typeof v !== "object") return;
      if ("pool" in v && "digest" in v) {
        const ref = v as ObjectRef;
        try { assertRef(ref); } catch (error) {
          throw new Error(`Invalid or cross-pool reference in ${kind} at ${path} (pool=${String(ref.pool).slice(0, 40)}, digestLength=${String(ref.digest).length}, size=${ref.size}, mediaType=${String(ref.mediaType).slice(0, 80)})`, { cause: error });
        }
        found.set(canonicalize(ref), ref);
      } else for (const [key, child] of Object.entries(v)) visit(child, `${path}.${key}`);
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

  private sameIdentity(left: ObjectIdentity, right: ObjectIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size
      && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
  }

  /** Returns how many objects were read and hashed. */
  private async validateReachable(root: AgentStateRef, trustAdmitted: boolean): Promise<number> {
    const generation = this.admissionGeneration;
    const visited = new Set<string>();
    const pending: ObjectRef[] = [root];
    // Admit only after the complete closure succeeds.
    const verified = new Map<string, boolean>();
    let rehashed = 0;
    while (pending.length) {
      const ref = pending.pop()!;
      assertRef(ref);
      const key = canonicalize(ref);
      if (visited.has(key)) continue;
      visited.add(key);
      const asRecord = ref.mediaType === RECORD_MEDIA_TYPE;
      // Both admitted readers re-check existence first: an admission covers bytes this instance
      // verified, not their continued presence, so a vanished object must be verified (and fail) instead
      // of being skipped as an already-checked closure.
      if (trustAdmitted && this.admitted.has(admissionKey(ref))) await this.dropIfVanished(ref);
      const known = this.admitted.get(admissionKey(ref));
      // An admitted record already had its closure verified, so stop here.
      if (trustAdmitted && (known === true || (known === false && !asRecord))) continue;
      if (asRecord) {
        assertRef(ref, "agent-state");
        pending.push(...(await this.readRecord(ref as AgentStateRef)).dependencies);
      } else await this.verifyRef(ref);
      rehashed++;
      verified.set(admissionKey(ref), asRecord || verified.get(admissionKey(ref)) === true);
    }
    if (generation === this.admissionGeneration) {
      for (const [key, asRecord] of verified) this.admitted.set(key, asRecord || this.admitted.get(key) === true);
    }
    return rehashed;
  }

  /** Full byte-and-hash audit of every object reachable from root; never skips admitted objects. */
  async validateClosure(root: AgentStateRef): Promise<number> {
    return this.validateReachable(root, false);
  }

  /** Ref-commit validation: verify only objects this instance has not admitted yet. */
  async validateClosureForCommit(root: AgentStateRef): Promise<number> {
    return this.validateReachable(root, true);
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
          content = await store.putWorkspaceFile(child, file);
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
    const db = new DatabaseSync(toNamespacedPath(resolve(store.dataDir, "versioning", "refs.sqlite")));
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

  /** Durable publication order, not file mtime or RPC completion time. */
  publicationSequence(name: string, target?: AgentStateRef): number | undefined {
    const row = target
      ? this.db.prepare("SELECT id FROM history_refs WHERE name=? AND target=? ORDER BY id DESC LIMIT 1").get(name, canonicalize(target))
      : this.db.prepare("SELECT id FROM history_refs WHERE name=? ORDER BY id DESC LIMIT 1").get(name);
    return row ? Number(row.id) : undefined;
  }

  roots(): AgentStateRef[] {
    return this.db.prepare("SELECT target FROM live_refs UNION SELECT target FROM history_refs").all()
      .map((row) => JSON.parse(row.target as string) as AgentStateRef);
  }

  /** Exact namespace, not SQL LIKE. Authorization belongs to the caller. */
  list(prefix: string): Array<{ name: string; target: AgentStateRef }> {
    return this.db.prepare("SELECT name,target FROM live_refs WHERE substr(name,1,?)=? ORDER BY name").all(prefix.length, prefix)
      .map(row => ({ name: String(row.name), target: JSON.parse(String(row.target)) as AgentStateRef }));
  }

  /** Closure is checked immediately before entering the synchronous transaction. No deletion API exists. */
  async commit(store: VersionStore, name: string, expected: AgentStateRef | null, target: AgentStateRef,
    fault?: (point: "before-transaction" | "after-live-ref") => void): Promise<void> {
    if (!name || name.length > 512 || /[\x00-\x1f]/.test(name)) throw new Error("Invalid ref name");
    assertRef(target, "agent-state");
    await store.validateClosureForCommit(target);
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
  startedAt?: string;
  finishedAt?: string;
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

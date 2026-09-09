// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  SkillPackageBundle,
  SkillPackageManifest,
  SkillPackageMetadata,
} from "@sciencediscovery/schema";

const MANIFEST = ".skill-bundle.json";
const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * A Runner holds the frozen Skill packages a Session selected, so a remote
 * execution can mount the same read-only tree the local Runner mounts.
 *
 * Snapshots are content addressed: the directory name is derived from the
 * selected set's ids, revisions and package hashes. A different selection, a
 * new revision or one changed byte is therefore a different directory, which is
 * what stops a stale tree from being mounted as if it were still current.
 */
export function safeSkillFile(path: string): string {
  if (typeof path !== "string" || !path || path.includes("\\") || path.includes("\0")
    || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid frozen Skill file path");
  }
  return path;
}

function safeSkillId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("Invalid frozen Skill metadata");
  return id;
}

/**
 * Name of the snapshot the selected set needs.
 *
 * Only the metadata takes part: each `hash` already covers that package's file
 * paths and bytes, so the identity can be computed from a manifest without
 * reading or shipping a single file.
 */
export function skillBundleIdentity(manifest: SkillPackageManifest): string {
  if (!manifest || !Array.isArray(manifest.skills) || !manifest.skills.length) throw new Error("Empty Skill bundle");
  const ids = new Set<string>();
  const canonical = manifest.skills.map((skill) => {
    if (!Number.isSafeInteger(skill.revision) || skill.revision < 1 || typeof skill.version !== "string"
      || !/^[a-f0-9]{64}$/.test(skill.hash ?? "")) throw new Error("Invalid frozen Skill metadata");
    const id = safeSkillId(skill.id);
    if (ids.has(id)) throw new Error("Invalid frozen Skill metadata: duplicate selection");
    ids.add(id);
    return { hash: skill.hash, id, revision: skill.revision, version: skill.version };
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return digest(JSON.stringify(canonical));
}

/** Metadata only, so a published snapshot can be described without its bytes. */
export function skillBundleManifest(bundle: SkillPackageBundle): SkillPackageManifest {
  return {
    skills: bundle.skills.map(({ files: _files, ...metadata }) => metadata),
  };
}

/**
 * Recompute each package's hash from the bytes that arrived and compare it with
 * what the sender claimed. A package whose bytes do not add up to its hash is
 * refused before anything is written, so a corrupted or tampered transfer can
 * never become a mountable tree.
 */
export function verifySkillBundle(bundle: SkillPackageBundle): string {
  const identity = skillBundleIdentity(skillBundleManifest(bundle));
  for (const skill of bundle.skills) {
    if (!Array.isArray(skill.files)) throw new Error("Invalid frozen Skill metadata");
    const paths = new Set<string>();
    const hash = createHash("sha256");
    for (const file of [...skill.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
      const path = safeSkillFile(file.path);
      if (paths.has(path) || typeof file.content !== "string") throw new Error("Duplicate or invalid Skill file");
      paths.add(path);
      const bytes = Buffer.from(file.content, "base64");
      if (bytes.toString("base64") !== file.content || bytes.length !== file.size || digest(bytes) !== file.hash) {
        throw new Error(`Frozen Skill file integrity mismatch: ${skill.id}/${path}`);
      }
      hash.update(`${Buffer.byteLength(path)}:${path}:${bytes.length}:`);
      hash.update(bytes);
    }
    if (!paths.has("SKILL.md")) throw new Error(`Frozen Skill package integrity mismatch: ${skill.id} has no SKILL.md`);
    if (hash.digest("hex") !== skill.hash) throw new Error(`Frozen Skill package integrity mismatch: ${skill.id}`);
  }
  return identity;
}

interface StoredManifest extends SkillPackageManifest {
  skills: Array<SkillPackageMetadata & { files: Array<{ hash: string; path: string; size: number }> }>;
}

async function directory(path: string): Promise<void> {
  try { await mkdir(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe Skill snapshot directory");
}

/**
 * Check that a published snapshot still is exactly what its manifest describes:
 * every expected file present with the expected bytes, nothing extra, and no
 * symlink anywhere. Each file is streamed once and fed to both its own hash and
 * the package hash, so a tampered manifest cannot pass by rewriting one of them.
 *
 * This runs before each mount, so a snapshot damaged after publication fails the
 * execution instead of being mounted as if it were still the frozen package.
 */
export async function verifySkillSnapshot(root: string, manifest: StoredManifest): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe Skill snapshot root");
  const expected = new Set<string>();
  for (const skill of manifest.skills) {
    const id = safeSkillId(skill.id);
    if (!Array.isArray(skill.files)) throw new Error("Invalid frozen Skill manifest");
    for (const file of skill.files) {
      const path = `${id}/${safeSkillFile(file.path)}`;
      if (expected.has(path)) throw new Error("Duplicate or invalid Skill file");
      expected.add(path);
    }
  }

  const present = new Set<string>();
  const walk = async (dir: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error("Symlink in Skill snapshot");
      if (entry.isDirectory()) {
        if (![...expected].some((path) => path.startsWith(`${name}/`))) throw new Error(`Unexpected Skill directory: ${name}`);
        await walk(resolve(dir, entry.name), `${name}/`);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Unexpected Skill snapshot file: ${name}`);
      if (name === MANIFEST) continue;
      if (!expected.has(name)) throw new Error(`Unexpected Skill snapshot file: ${name}`);
      present.add(name);
    }
  };
  await walk(root);
  for (const path of expected) {
    if (!present.has(path)) throw new Error(`Incomplete Skill snapshot: ${path} is missing`);
  }

  for (const skill of manifest.skills) {
    const packageHash = createHash("sha256");
    for (const file of [...skill.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
      const fileHash = createHash("sha256");
      let size = 0;
      const handle = await open(resolve(root, skill.id, file.path), "r");
      try {
        packageHash.update(`${Buffer.byteLength(file.path)}:${file.path}:${file.size}:`);
        for await (const chunk of handle.createReadStream()) {
          fileHash.update(chunk as Buffer);
          packageHash.update(chunk as Buffer);
          size += (chunk as Buffer).length;
        }
      } finally {
        await handle.close();
      }
      if (size !== file.size || fileHash.digest("hex") !== file.hash) {
        throw new Error(`Frozen Skill file integrity mismatch: ${skill.id}/${file.path}`);
      }
    }
    if (packageHash.digest("hex") !== skill.hash) throw new Error(`Frozen Skill package integrity mismatch: ${skill.id}`);
  }
}

export class RunnerSkillPackages {
  constructor(private readonly dataDir: string) {}

  /**
   * Snapshots live under the Runner's own `projects/` root, which is the tree
   * the sandbox is already allowed to mount from. Nothing here is an Agent
   * Workspace: the leading dot keeps it out of the Session project namespace.
   */
  private async parent(): Promise<string> {
    await directory(this.dataDir);
    const projects = resolve(this.dataDir, "projects");
    await directory(projects);
    const parent = resolve(projects, ".skill-packages");
    await directory(parent);
    return parent;
  }

  private async storedManifest(root: string): Promise<StoredManifest> {
    const manifestPath = resolve(root, MANIFEST);
    const info = await lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe Skill manifest");
    return JSON.parse(await readFile(manifestPath, "utf8")) as StoredManifest;
  }

  /** The snapshot root for this identity, or just the identity when it is absent. */
  async get(id: string): Promise<{ id: string; root?: string }> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid Skill snapshot id");
    const root = resolve(await this.parent(), id);
    try {
      if ((await lstat(root)).isSymbolicLink()) throw new Error("Unsafe Skill snapshot root");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { id };
      throw error;
    }
    const manifest = await this.storedManifest(root);
    if (skillBundleIdentity(manifest) !== id) throw new Error("Skill snapshot identity mismatch");
    await verifySkillSnapshot(root, manifest);
    return { id, root };
  }

  /** Publish a bundle, or report the snapshot that already holds those bytes. */
  async put(bundle: SkillPackageBundle, signal?: AbortSignal): Promise<{ id: string; root: string }> {
    const id = verifySkillBundle(bundle);
    const found = await this.get(id).catch(() => ({ id, root: undefined }));
    if (found.root) return { id, root: found.root };
    // Staging is outside every mountable root: a half-written upload can never
    // be reached by an execution, and an interrupted one leaves nothing behind.
    const stagingParent = resolve(this.dataDir, ".skill-package-staging");
    await directory(stagingParent);
    const staging = resolve(stagingParent, randomUUID());
    await mkdir(staging);
    const root = resolve(await this.parent(), id);
    try {
      for (const skill of bundle.skills) {
        for (const file of skill.files) {
          signal?.throwIfAborted();
          const path = resolve(staging, skill.id, safeSkillFile(file.path));
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, Buffer.from(file.content, "base64"), { flag: "wx", mode: 0o444 });
        }
      }
      const manifest: StoredManifest = {
        skills: bundle.skills.map((skill) => ({
          files: skill.files.map(({ content: _content, ...file }) => file),
          hash: skill.hash,
          id: skill.id,
          revision: skill.revision,
          version: skill.version,
        })),
      };
      await writeFile(resolve(staging, MANIFEST), JSON.stringify(manifest), { flag: "wx", mode: 0o444 });
      signal?.throwIfAborted();
      try { await rename(staging, root); }
      catch (error) {
        // Another connection publishing the same bytes wins the rename; both
        // end up pointing at the same content-addressed tree.
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      const checked = await this.get(id);
      if (!checked.root) throw new Error("Skill snapshot publication failed");
      return { id, root: checked.root };
    } finally {
      await rm(staging, { force: true, recursive: true });
    }
  }
}

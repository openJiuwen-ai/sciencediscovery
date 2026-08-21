// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
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

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  CommitSkillLibraryVersionRequest,
  CommitSkillLibraryVersionResult,
  PromptSkillLibraryRef,
  SkillLibrary,
  SkillLibraryConflict,
  SkillLibraryDiff,
  SkillLibraryPackageInput,
  SkillLibraryVersion,
  SkillLibraryVersionSkill,
  SkillValidationDiagnostic,
  RollbackSkillLibraryVersionRequest,
} from "@science-agent/schema";

import { validateSkillPackage } from "@science-agent/specialist";

const LIBRARY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface CatalogIndex {
  libraries: Record<string, SkillLibrary>;
  schemaVersion: 1;
}

export class SkillLibraryCatalogError extends Error {
  code: "SKILL_LIBRARY_CONFLICT" | "SKILL_LIBRARY_NOT_FOUND" | "SKILL_LIBRARY_VALIDATION";

  constructor(code: SkillLibraryCatalogError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function validationError(message: string): SkillLibraryCatalogError {
  return new SkillLibraryCatalogError("SKILL_LIBRARY_VALIDATION", message);
}

function decodePackage(input: SkillLibraryPackageInput): Map<string, Buffer> {
  if (!input || !Array.isArray(input.files) || input.files.length === 0) {
    throw validationError("Skill library upsert package must contain files");
  }
  const files = new Map<string, Buffer>();
  for (const file of input.files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      throw validationError("Skill library package files must include path and content");
    }
    if (files.has(file.path)) throw validationError(`Duplicate package file path: ${file.path}`);
    files.set(file.path, Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8"));
  }
  return files;
}

function versionContentHash(skills: SkillLibraryVersionSkill[]): string {
  const hash = createHash("sha256");
  for (const skill of skills.toSorted((left, right) => left.id.localeCompare(right.id))) {
    hash.update(`${skill.id}\0${skill.hash}\0${skill.version}\n`);
  }
  return hash.digest("hex");
}

function diffSkills(
  before: SkillLibraryVersionSkill[],
  after: SkillLibraryVersionSkill[],
): SkillLibraryDiff {
  const beforeById = new Map(before.map((skill) => [skill.id, skill]));
  const afterById = new Map(after.map((skill) => [skill.id, skill]));
  const diff: SkillLibraryDiff = { added: [], deleted: [], modified: [] };
  for (const [skillId, afterSkill] of afterById) {
    const beforeSkill = beforeById.get(skillId);
    if (!beforeSkill) diff.added.push({ after: afterSkill, skillId });
    else if (beforeSkill.hash !== afterSkill.hash || beforeSkill.version !== afterSkill.version) {
      diff.modified.push({ after: afterSkill, before: beforeSkill, skillId });
    }
  }
  for (const [skillId, beforeSkill] of beforeById) {
    if (!afterById.has(skillId)) diff.deleted.push({ before: beforeSkill, skillId });
  }
  for (const entries of [diff.added, diff.deleted, diff.modified]) {
    entries.sort((left, right) => left.skillId.localeCompare(right.skillId));
  }
  return diff;
}

async function writePackageDirectory(root: string, files: ReadonlyMap<string, Buffer>): Promise<void> {
  for (const [path, bytes] of files) {
    const target = resolve(root, ...path.split("/"));
    if (!target.startsWith(`${root}/`)) throw validationError(`Unsafe skill package path: ${path}`);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
}

async function readPackageDirectory(directory: string, prefix = ""): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [childPath, bytes] of await readPackageDirectory(absolute, path)) files.set(childPath, bytes);
    } else if (entry.isFile()) {
      files.set(path, await readFile(absolute));
    }
  }
  return files;
}

async function validateStoredPackageHash(directory: string, expectedHash: string): Promise<void> {
  const loaded = validateSkillPackage(await readPackageDirectory(directory));
  if (loaded.detail.hash !== expectedHash) {
    throw validationError(`Stored skill package hash does not match content: ${expectedHash}`);
  }
}

export class SkillLibraryCatalog {
  private index: CatalogIndex = { libraries: {}, schemaVersion: 1 };
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = resolve(dataDir, "skill-libraries");
  }

  private get indexPath(): string {
    return resolve(this.root, "catalog.json");
  }

  private libraryRoot(libraryId: string): string {
    return resolve(this.root, "libraries", libraryId);
  }

  private packageRoot(hash: string): string {
    return resolve(this.root, "packages", "sha256", hash.slice(0, 2), hash, "package");
  }

  private versionPath(libraryId: string, versionId: string): string {
    return resolve(this.libraryRoot(libraryId), "versions", `${versionId}.json`);
  }

  private async saveIndex(): Promise<void> {
    const temporary = resolve(this.root, `.catalog-${randomUUID()}.json`);
    await writeFile(temporary, `${JSON.stringify(this.index, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, this.indexPath);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".catalog-")) await rm(resolve(this.root, entry.name), { force: true, recursive: true });
    }
    try {
      const saved = JSON.parse(await readFile(this.indexPath, "utf8")) as Partial<CatalogIndex>;
      if (saved.schemaVersion !== 1 || !saved.libraries || typeof saved.libraries !== "object") {
        throw validationError("Skill library catalog has an unsupported schema");
      }
      this.index = saved as CatalogIndex;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.saveIndex();
    }
    this.loaded = true;
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("Skill library catalog is not loaded");
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  list(): SkillLibrary[] {
    this.assertLoaded();
    return Object.values(this.index.libraries)
      .map((library) => structuredClone(library))
      .toSorted((left, right) => left.name.localeCompare(right.name));
  }

  get(libraryId: string): SkillLibrary | undefined {
    this.assertLoaded();
    return this.index.libraries[libraryId] ? structuredClone(this.index.libraries[libraryId]) : undefined;
  }

  async create(input: { id?: string; name?: string } = {}): Promise<SkillLibrary> {
    return await this.mutate(async () => {
      this.assertLoaded();
      const id = input.id?.trim() || randomUUID();
      if (input.id && (!LIBRARY_ID.test(id) || id.length > 64)) {
        throw validationError("Skill library id must contain 1-64 lowercase letters, digits, or single hyphens");
      }
      if (this.index.libraries[id]) throw new SkillLibraryCatalogError("SKILL_LIBRARY_CONFLICT", `Skill library already exists: ${id}`);
      const now = new Date().toISOString();
      const library: SkillLibrary = {
        createdAt: now,
        id,
        name: input.name?.trim() || id,
        updatedAt: now,
      };
      this.index.libraries[id] = library;
      try {
        await mkdir(resolve(this.libraryRoot(id), "versions"), { recursive: true });
        await this.saveIndex();
      } catch (error) {
        delete this.index.libraries[id];
        throw error;
      }
      return structuredClone(library);
    });
  }

  async getVersion(libraryId: string, versionId: string): Promise<SkillLibraryVersion> {
    this.assertLoaded();
    if (!this.index.libraries[libraryId]) {
      throw new SkillLibraryCatalogError("SKILL_LIBRARY_NOT_FOUND", `Skill library not found: ${libraryId}`);
    }
    try {
      return JSON.parse(await readFile(this.versionPath(libraryId, versionId), "utf8")) as SkillLibraryVersion;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SkillLibraryCatalogError("SKILL_LIBRARY_NOT_FOUND", `Skill library version not found: ${versionId}`);
      }
      throw error;
    }
  }

  async listVersions(libraryId: string): Promise<SkillLibraryVersion[]> {
    this.assertLoaded();
    if (!this.index.libraries[libraryId]) {
      throw new SkillLibraryCatalogError("SKILL_LIBRARY_NOT_FOUND", `Skill library not found: ${libraryId}`);
    }
    const versionsRoot = resolve(this.libraryRoot(libraryId), "versions");
    const versions: SkillLibraryVersion[] = [];
    for (const entry of await readdir(versionsRoot).catch(() => [])) {
      if (entry.endsWith(".json")) versions.push(JSON.parse(await readFile(resolve(versionsRoot, entry), "utf8")) as SkillLibraryVersion);
    }
    return versions.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async persistPackage(hash: string, files: ReadonlyMap<string, Buffer>): Promise<void> {
    const destination = this.packageRoot(hash);
    let created = false;
    try {
      await mkdir(resolve(destination, ".."), { recursive: true });
      await mkdir(destination, { recursive: false });
      created = true;
      await writePackageDirectory(destination, files);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      if (created) {
        try {
          await validateStoredPackageHash(destination, hash);
        } catch (error) {
          await rm(destination, { force: true, recursive: true });
          throw error;
        }
      }
    }
  }

  private async buildCommit(
    libraryId: string,
    request: CommitSkillLibraryVersionRequest,
    rollbackOfVersionId?: string,
  ): Promise<{ conflicts: SkillLibraryConflict[]; diagnostics: SkillValidationDiagnostic[]; diff: SkillLibraryDiff; packages: Map<string, ReadonlyMap<string, Buffer>>; version: SkillLibraryVersion }> {
    const library = this.index.libraries[libraryId];
    if (!library) throw new SkillLibraryCatalogError("SKILL_LIBRARY_NOT_FOUND", `Skill library not found: ${libraryId}`);
    if (!request.author || !["self-evolution", "system", "user"].includes(request.author.kind)) {
      throw validationError("Skill library commit author.kind is required");
    }
    if (!Array.isArray(request.operations)) throw validationError("Skill library commit operations must be an array");

    const base = request.baseVersionId ? await this.getVersion(libraryId, request.baseVersionId) : undefined;
    const currentHead = library.headVersionId ? await this.getVersion(libraryId, library.headVersionId) : undefined;
    const conflicts: SkillLibraryConflict[] = [];
    if (library.headVersionId !== request.baseVersionId) {
      conflicts.push({
        code: "STALE_BASE_VERSION",
        message: `Base version ${request.baseVersionId ?? "(empty)"} does not match head ${library.headVersionId ?? "(empty)"}`,
      });
    }
    const nextSkills = new Map((base?.skills ?? []).map((skill) => [skill.id, skill]));
    const packages = new Map<string, ReadonlyMap<string, Buffer>>();
    const diagnostics: SkillValidationDiagnostic[] = [];
    const touched = new Set<string>();

    for (const operation of request.operations) {
      if (operation.type === "upsert") {
        const loaded = validateSkillPackage(decodePackage(operation.package));
        if (touched.has(loaded.detail.id)) {
          conflicts.push({ code: "DUPLICATE_OPERATION", message: `Skill is edited more than once: ${loaded.detail.id}`, skillId: loaded.detail.id });
          continue;
        }
        touched.add(loaded.detail.id);
        diagnostics.push(...loaded.detail.diagnostics);
        packages.set(loaded.detail.hash, loaded.files);
        nextSkills.set(loaded.detail.id, {
          ...(loaded.detail.declaredVersion ? { declaredVersion: loaded.detail.declaredVersion } : {}),
          description: loaded.detail.description,
          hash: loaded.detail.hash,
          id: loaded.detail.id,
          version: loaded.detail.version,
        });
      } else if (operation.type === "delete") {
        const skillId = operation.skillId?.trim();
        if (!skillId) throw validationError("Skill library delete operation requires skillId");
        if (touched.has(skillId)) {
          conflicts.push({ code: "DUPLICATE_OPERATION", message: `Skill is edited more than once: ${skillId}`, skillId });
          continue;
        }
        touched.add(skillId);
        if (!nextSkills.delete(skillId)) {
          conflicts.push({ code: "DELETE_MISSING_SKILL", message: `Skill is not present in the base version: ${skillId}`, skillId });
        }
      } else {
        throw validationError("Unsupported skill library operation type");
      }
    }

    const skills = [...nextSkills.values()].toSorted((left, right) => left.id.localeCompare(right.id));
    const createdAt = new Date().toISOString();
    const version: SkillLibraryVersion = {
      author: structuredClone(request.author),
      ...(base ? { baseVersionId: base.id, parentVersionId: base.id } : {}),
      contentHash: versionContentHash(skills),
      createdAt,
      ...(request.evaluation ? { evaluation: structuredClone(request.evaluation) } : {}),
      id: randomUUID(),
      libraryId,
      ...(rollbackOfVersionId ? { rollbackOfVersionId } : {}),
      skills,
    };
    return {
      conflicts,
      diagnostics,
      diff: diffSkills(currentHead?.skills ?? [], skills),
      packages,
      version,
    };
  }

  async commitVersion(libraryId: string, request: CommitSkillLibraryVersionRequest): Promise<CommitSkillLibraryVersionResult> {
    return await this.mutate(async () => {
      this.assertLoaded();
      const built = await this.buildCommit(libraryId, request);
      if (request.dryRun || built.conflicts.length) {
        return {
          conflicts: built.conflicts,
          diagnostics: built.diagnostics,
          diff: built.diff,
          dryRun: Boolean(request.dryRun),
          ...(request.dryRun ? { version: built.version } : {}),
        };
      }
      await this.publishVersion(libraryId, built.version, built.packages);
      return {
        conflicts: [],
        diagnostics: built.diagnostics,
        diff: built.diff,
        dryRun: false,
        version: structuredClone(built.version),
      };
    });
  }

  private async publishVersion(libraryId: string, version: SkillLibraryVersion, packages: Map<string, ReadonlyMap<string, Buffer>>): Promise<void> {
    const library = this.index.libraries[libraryId]!;
    for (const [hash, files] of packages) await this.persistPackage(hash, files);
    const versionPath = this.versionPath(libraryId, version.id);
    await mkdir(resolve(versionPath, ".."), { recursive: true });
    await writeFile(versionPath, `${JSON.stringify(version, null, 2)}\n`, { flag: "wx" });
    const previous = structuredClone(library);
    library.headVersionId = version.id;
    library.updatedAt = version.createdAt;
    try {
      await this.saveIndex();
    } catch (error) {
      this.index.libraries[libraryId] = previous;
      await rm(versionPath, { force: true });
      throw error;
    }
  }

  async diffVersions(libraryId: string, fromVersionId: string, toVersionId: string): Promise<SkillLibraryDiff> {
    const [fromVersion, toVersion] = await Promise.all([
      this.getVersion(libraryId, fromVersionId),
      this.getVersion(libraryId, toVersionId),
    ]);
    return diffSkills(fromVersion.skills, toVersion.skills);
  }

  async validateRefs(refs: readonly PromptSkillLibraryRef[] | undefined): Promise<PromptSkillLibraryRef[]> {
    this.assertLoaded();
    if (!refs?.length) return [];
    const seen = new Set<string>();
    const validated: PromptSkillLibraryRef[] = [];
    for (const ref of refs) {
      const libraryId = ref.libraryId?.trim();
      const versionId = ref.versionId?.trim();
      const contentHash = ref.contentHash?.trim();
      if (!libraryId || !versionId || !contentHash) {
        throw validationError("Skill library references require libraryId, versionId, and contentHash");
      }
      const key = `${libraryId}\0${versionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const version = await this.getVersion(libraryId, versionId);
      if (version.contentHash !== contentHash) {
        throw validationError(`Skill library reference hash mismatch for ${libraryId}@${versionId}`);
      }
      validated.push({ contentHash, libraryId, versionId });
    }
    return validated.toSorted((left, right) => `${left.libraryId}/${left.versionId}`.localeCompare(`${right.libraryId}/${right.versionId}`));
  }

  async rollback(libraryId: string, request: RollbackSkillLibraryVersionRequest): Promise<CommitSkillLibraryVersionResult> {
    return await this.mutate(async () => {
      this.assertLoaded();
      if (!request.author || !["self-evolution", "system", "user"].includes(request.author.kind)) {
        throw validationError("Skill library rollback author.kind is required");
      }
      const target = await this.getVersion(libraryId, request.targetVersionId);
      const library = this.index.libraries[libraryId]!;
      const current = library.headVersionId ? await this.getVersion(libraryId, library.headVersionId) : undefined;
      const currentById = new Map((current?.skills ?? []).map((skill) => [skill.id, skill]));
      const targetById = new Map(target.skills.map((skill) => [skill.id, skill]));
      const conflicts: SkillLibraryConflict[] = [];
      if (library.headVersionId !== request.baseVersionId) {
        conflicts.push({
          code: "STALE_BASE_VERSION",
          message: `Base version ${request.baseVersionId ?? "(empty)"} does not match head ${library.headVersionId ?? "(empty)"}`,
        });
      }
      if (conflicts.length) {
        return { conflicts, diagnostics: [], diff: diffSkills(current?.skills ?? [], target.skills), dryRun: false };
      }
      const packages = new Map<string, ReadonlyMap<string, Buffer>>();
      for (const skill of target.skills) {
        packages.set(skill.hash, await this.readStoredPackage(skill.hash));
      }
      const version: SkillLibraryVersion = {
        author: structuredClone(request.author),
        ...(current ? { baseVersionId: current.id, parentVersionId: current.id } : {}),
        contentHash: target.contentHash,
        createdAt: new Date().toISOString(),
        ...(request.evaluation ? { evaluation: structuredClone(request.evaluation) } : {}),
        id: randomUUID(),
        libraryId,
        rollbackOfVersionId: target.id,
        skills: [...targetById.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
      };
      const diff = diffSkills([...currentById.values()], version.skills);
      await this.publishVersion(libraryId, version, packages);
      return { conflicts: [], diagnostics: [], diff, dryRun: false, version: structuredClone(version) };
    });
  }

  private async readStoredPackage(hash: string, directory = this.packageRoot(hash), prefix = ""): Promise<Map<string, Buffer>> {
    const files = new Map<string, Buffer>();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        for (const [path, bytes] of await this.readStoredPackage(hash, absolute, childPath)) files.set(path, bytes);
      } else if (entry.isFile()) {
        files.set(childPath, await readFile(absolute));
      }
    }
    return files;
  }
}

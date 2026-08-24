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
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { posix, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { promisify } from "node:util";

import type {
  ChatMessage,
  CreateSkillRequest,
  CreateSkillDialogueDraftRequest,
  DistillSessionSkillRequest,
  ExecutionRun,
  ImportSkillFromGitRequest,
  SkillDescriptor,
  SkillDetail,
  SkillResource,
  SkillResourceContent,
  SkillResourceKind,
  SkillDraft,
  SkillValidationDiagnostic,
  UpdateSkillRequest,
} from "@sciencediscovery/schema";
import { sha256 } from "@sciencediscovery/cas";
import { Unzip, UnzipInflate } from "fflate";
import { parseDocument, stringify } from "yaml";

/** Domain skills bundled with the first-party Specialist catalog. */
export const BUNDLED_SKILL_IDS = [
  "antibody-protenix-pipeline",
  "code-engineer",
  "computation-reviewer",
  "citation-reviewer",
  "evidence-extractor",
  "life-science-evidence-brief",
  "literature-searcher",
  "report-writer",
  "result-evaluator",
  "science-research-team",
  "structure-pocket-inspection",
] as const;

export const SKILL_LIMITS = {
  archiveBytes: 25 * 1024 * 1024,
  extractedBytes: 50 * 1024 * 1024,
  files: 500,
  resourceBytes: 10 * 1024 * 1024,
  runtimeTextBytes: 1024 * 1024,
  skillMarkdownBytes: 512 * 1024,
} as const;

const BUILT_IN_VERSIONS: Record<(typeof BUNDLED_SKILL_IDS)[number], string> = {
  "antibody-protenix-pipeline": "1.0.0",
  "code-engineer": "1.0.0",
  "computation-reviewer": "1.0.0",
  "citation-reviewer": "1.0.0",
  "evidence-extractor": "1.0.0",
  "life-science-evidence-brief": "1.1.0",
  "literature-searcher": "1.0.0",
  "report-writer": "1.0.0",
  "result-evaluator": "1.0.0",
  "science-research-team": "1.0.0",
  "structure-pocket-inspection": "1.0.0",
};
const FRONTMATTER_KEYS = new Set([
  "allowed-tools",
  "compatibility",
  "description",
  "license",
  "metadata",
  "name",
]);
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const execFileAsync = promisify(execFile);

interface CatalogIndex {
  managed: Record<string, { currentRevision: number }>;
  schemaVersion: 1;
}

interface LoadedPackage {
  detail: SkillDetail;
  files: Map<string, Buffer>;
}

interface ManagedPackage extends LoadedPackage {
  createdAt: string;
}

export interface RuntimeSkillSnapshot {
  content: string;
  description: string;
  hash: string;
  id: string;
  readResource: (path: string) => SkillResourceContent;
  resources: SkillResource[];
  revision: number;
  version: string;
}

export class SkillCatalogError extends Error {
  code: "SKILL_CONFLICT" | "SKILL_NOT_FOUND" | "SKILL_READ_ONLY" | "SKILL_VALIDATION";

  constructor(
    code: SkillCatalogError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

function validationError(message: string): SkillCatalogError {
  return new SkillCatalogError("SKILL_VALIDATION", message);
}

function slugify(value: string): string {
  const slug = value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "workflow-skill";
}

export function createDialogueSkillDraft(input: CreateSkillDialogueDraftRequest): SkillDraft {
  const description = input.description?.trim();
  if (!description || description.length > 4_000) {
    throw validationError("Dialogue description must contain 1-4000 characters");
  }
  const title = description.split(/[.!?\n]/, 1)[0]!.trim();
  const name = slugify(title.split(/\s+/).slice(0, 8).join(" "));
  return {
    description: `Reusable workflow for ${title.toLowerCase()}.`.slice(0, 1024),
    instructions: [
      `# ${title}`,
      "",
      "## Goal",
      "",
      description,
      "",
      "## Workflow",
      "",
      "1. Confirm inputs, expected outputs, and acceptance criteria.",
      "2. Inspect the authorized workspace and reuse existing Python, R, or shell scripts when available.",
      "3. Run the workflow in the configured sandboxed environment and preserve execution provenance.",
      "4. Validate generated outputs and report limitations.",
      "",
      "## Safety",
      "",
      "- Stay within user-authorized workspace paths and tools.",
      "- Do not install dependencies or access the network outside the controlled environment workflow.",
    ].join("\n"),
    metadata: { version: "0.1.0" },
    name,
    origin: "dialogue",
    sourceSummary: "Drafted from a natural-language workflow description; review all instructions before saving.",
  };
}

export function createSessionSkillDraft(input: {
  messages: ChatMessage[];
  request: DistillSessionSkillRequest;
  runs: ExecutionRun[];
  sessionTitle: string;
}): SkillDraft {
  if (input.messages.length < 2 && input.runs.length === 0) {
    throw validationError("The Session does not contain a completed workflow to distill");
  }
  const requestedName = input.request.name?.trim();
  const name = requestedName || slugify(input.sessionTitle);
  if (!SKILL_NAME.test(name) || name.length > 64) {
    throw validationError("Draft name must contain 1-64 lowercase letters, digits, or single hyphens");
  }
  const userGoals = input.messages
    .filter((message) => message.role === "user")
    .slice(-5)
    .map((message) => message.content.replace(/\s+/g, " ").trim().slice(0, 240));
  const languages = [...new Set(input.runs.map((run) => run.language).filter(Boolean))];
  const outputPaths = [...new Set(input.runs.flatMap((run) => [...run.createdFiles, ...run.modifiedFiles]))].slice(0, 20);
  const runSteps = input.runs.slice(-12).map((run, index) => (
    `${index + 1}. Run an existing or generated ${run.language ?? "script"} step with the configured sandboxed environment; verify exit status and recorded outputs.`
  ));
  const workflow = runSteps.length ? runSteps : [
    "1. Follow the reviewed Session workflow using only authorized tools and workspace paths.",
    "2. Validate the result against the user's stated acceptance criteria.",
  ];
  return {
    description: `Reviewable workflow distilled from Session “${input.sessionTitle}”.`.slice(0, 1024),
    instructions: [
      `# ${input.sessionTitle}`,
      "",
      "## Intended use",
      "",
      ...(userGoals.length ? userGoals.map((goal) => `- ${goal}`) : ["- Reproduce the completed Session workflow with new user-provided inputs."]),
      "",
      "## Workflow",
      "",
      ...workflow,
      "",
      "## Observed implementation",
      "",
      `- Languages: ${languages.join(", ") || "No code execution recorded"}`,
      `- Output paths: ${outputPaths.join(", ") || "No output paths recorded"}`,
      "",
      "## Validation and safety",
      "",
      "- Ask the user to confirm inputs, outputs, and any assumptions that were specific to the source Session.",
      "- Reuse user-provided Python, R, and shell scripts where appropriate; do not translate them into a proprietary DSL.",
      "- Run only in authorized workspaces and configured sandboxed environments, then inspect provenance and outputs.",
      "- This draft is not active until a user reviews, edits, and saves it.",
    ].join("\n"),
    metadata: { version: "0.1.0" },
    name,
    origin: "session",
    sourceSummary: `Distilled from ${input.messages.length} messages and ${input.runs.length} execution records in Session “${input.sessionTitle}”.`,
  };
}

export function validateGitSkillImportRequest(input: ImportSkillFromGitRequest): Required<Pick<ImportSkillFromGitRequest, "repositoryUrl">> & Pick<ImportSkillFromGitRequest, "ref" | "subdirectory"> {
  const repositoryUrl = input.repositoryUrl?.trim();
  if (!repositoryUrl || repositoryUrl.length > 2_000) throw validationError("Git repository URL is required");
  const scpStyle = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s\0]+$/.test(repositoryUrl);
  if (!scpStyle) {
    let parsed: URL;
    try {
      parsed = new URL(repositoryUrl);
    } catch {
      throw validationError("Git repository URL must use HTTPS, SSH, or SSH scp syntax");
    }
    if (!new Set(["https:", "ssh:"]).has(parsed.protocol)) {
      throw validationError("Git repository URL must use HTTPS or SSH");
    }
    if (!parsed.hostname) throw validationError("Git repository URL must include a host");
    if (parsed.username || parsed.password) {
      throw validationError("Put Git credentials in the local credential helper or SSH configuration, not in the URL");
    }
  }
  const ref = input.ref?.trim() || undefined;
  if (ref && (ref.length > 200 || ref.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(ref))) {
    throw validationError("Git ref contains unsupported characters");
  }
  const rawSubdirectory = input.subdirectory?.trim().replace(/\/$/, "") || undefined;
  const subdirectory = rawSubdirectory ? normalizedPackagePath(rawSubdirectory) : undefined;
  return { repositoryUrl, ...(ref ? { ref } : {}), ...(subdirectory ? { subdirectory } : {}) };
}

function payloadTooLarge(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = "PAYLOAD_TOO_LARGE";
  return error;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, key: string, maxLength?: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw validationError(`${key} must be a string`);
  const result = value.trim();
  if (!result) throw validationError(`${key} must not be empty`);
  if (maxLength !== undefined && result.length > maxLength) {
    throw validationError(`${key} must be at most ${maxLength} characters`);
  }
  return result;
}

function normalizeMetadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, "metadata");
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") throw validationError(`metadata.${key} must be a string`);
    metadata[key] = item;
  }
  return metadata;
}

export interface ParsedSkillMarkdown {
  frontmatter: Record<string, unknown>;
  instructions: string;
}

export function parseSkillMarkdown(bytes: Buffer): ParsedSkillMarkdown {
  if (bytes.length > SKILL_LIMITS.skillMarkdownBytes) {
    throw payloadTooLarge(`SKILL.md exceeds ${SKILL_LIMITS.skillMarkdownBytes} bytes`);
  }
  let source: string;
  try {
    source = utf8Decoder.decode(bytes);
  } catch {
    throw validationError("SKILL.md must be valid UTF-8");
  }
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw validationError("SKILL.md must begin with YAML frontmatter delimited by ---");
  const document = parseDocument(match[1]!, { schema: "core" });
  if (document.errors.length) {
    throw validationError(`SKILL.md frontmatter is invalid YAML: ${document.errors[0]!.message}`);
  }
  const frontmatter = asRecord(document.toJS({ maxAliasCount: 20 }), "SKILL.md frontmatter");
  const instructions = source.slice(match[0].length).trim();
  if (!instructions) throw validationError("SKILL.md must include Markdown instructions after frontmatter");
  return { frontmatter, instructions };
}

function normalizedPackagePath(path: string): string {
  if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw validationError(`Unsafe skill package path: ${path || "(empty)"}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw validationError(`Unsafe skill package path: ${path}`);
  }
  const normalized = posix.normalize(path);
  if (normalized !== path || normalized.startsWith("../")) {
    throw validationError(`Unsafe skill package path: ${path}`);
  }
  return normalized;
}

function resourceKind(path: string): SkillResourceKind {
  if (path.startsWith("assets/")) return "asset";
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("scripts/")) return "script";
  return "other";
}

function packageHash(files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].toSorted()) {
    const bytes = files.get(path)!;
    hash.update(`${Buffer.byteLength(path)}:`);
    hash.update(path);
    hash.update(`:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function cloneFiles(files: ReadonlyMap<string, Buffer>): Map<string, Buffer> {
  return new Map([...files].map(([path, bytes]) => [path, Buffer.from(bytes)]));
}

export function validateSkillPackage(
  sourceFiles: ReadonlyMap<string, Buffer>,
  options: {
    directoryName?: string;
    readOnly?: boolean;
    revision?: number;
    source?: SkillDescriptor["source"];
    version?: string;
  } = {},
): LoadedPackage {
  if (!sourceFiles.size) throw validationError("Skill package is empty");
  if (sourceFiles.size > SKILL_LIMITS.files) throw payloadTooLarge(`Skill package exceeds ${SKILL_LIMITS.files} files`);
  const files = new Map<string, Buffer>();
  let extractedBytes = 0;
  for (const [rawPath, sourceBytes] of sourceFiles) {
    const path = normalizedPackagePath(rawPath);
    if (files.has(path)) throw validationError(`Duplicate normalized skill package path: ${path}`);
    const bytes = Buffer.from(sourceBytes);
    const limit = path === "SKILL.md" ? SKILL_LIMITS.skillMarkdownBytes : SKILL_LIMITS.resourceBytes;
    if (bytes.length > limit) throw payloadTooLarge(`${path} exceeds ${limit} bytes`);
    extractedBytes += bytes.length;
    if (extractedBytes > SKILL_LIMITS.extractedBytes) {
      throw payloadTooLarge(`Skill package exceeds ${SKILL_LIMITS.extractedBytes} extracted bytes`);
    }
    files.set(path, bytes);
  }
  const skillMarkdown = files.get("SKILL.md");
  if (!skillMarkdown) throw validationError("Skill package must contain SKILL.md at its root");
  const parsed = parseSkillMarkdown(skillMarkdown);
  const name = optionalString(parsed.frontmatter.name, "name", 64);
  if (!name || !SKILL_NAME.test(name)) {
    throw validationError("name must contain 1-64 lowercase letters, digits, or single hyphens");
  }
  if (options.directoryName !== undefined && name !== options.directoryName) {
    throw validationError(`SKILL.md name ${name} must match package directory ${options.directoryName}`);
  }
  const description = optionalString(parsed.frontmatter.description, "description", 1024);
  if (!description) throw validationError("description is required");
  optionalString(parsed.frontmatter.license, "license");
  optionalString(parsed.frontmatter.compatibility, "compatibility", 500);
  optionalString(parsed.frontmatter["allowed-tools"], "allowed-tools");
  const metadata = normalizeMetadata(parsed.frontmatter.metadata);
  const diagnostics: SkillValidationDiagnostic[] = [];
  if (parsed.frontmatter["allowed-tools"] !== undefined) {
    diagnostics.push({
      code: "UNSUPPORTED_ALLOWED_TOOLS",
      level: "warning",
      message: "allowed-tools is preserved but is not enforced by this runtime",
      path: "SKILL.md",
    });
  }
  for (const key of Object.keys(parsed.frontmatter).filter((key) => !FRONTMATTER_KEYS.has(key)).toSorted()) {
    diagnostics.push({
      code: "PRESERVED_UNKNOWN_FRONTMATTER",
      level: "info",
      message: `Frontmatter field ${key} is preserved but has no runtime semantics`,
      path: "SKILL.md",
    });
  }
  const resources = [...files]
    .filter(([path]) => path !== "SKILL.md")
    .map(([path, bytes]): SkillResource => ({
      hash: sha256(bytes),
      kind: resourceKind(path),
      path,
      size: bytes.length,
    }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const revision = options.revision ?? 1;
  const declaredVersion = metadata?.version?.trim() || undefined;
  const version = options.version ?? declaredVersion ?? `revision:${revision}`;
  const kinds: SkillDetail["resourceSummary"]["kinds"] = {
    asset: 0,
    other: 0,
    reference: 0,
    script: 0,
  };
  for (const resource of resources) kinds[resource.kind] += 1;
  return {
    detail: {
      currentRevision: revision,
      ...(declaredVersion ? { declaredVersion } : {}),
      description,
      diagnostics,
      frontmatter: structuredClone(parsed.frontmatter),
      hash: packageHash(files),
      id: name,
      instructions: parsed.instructions,
      name,
      readOnly: options.readOnly ?? false,
      resources,
      resourceSummary: {
        bytes: resources.reduce((total, resource) => total + resource.size, 0),
        files: resources.length,
        kinds,
      },
      source: options.source ?? "managed",
      version,
    },
    files,
  };
}

function createSkillMarkdown(input: CreateSkillRequest, existing: Record<string, unknown> = {}): Buffer {
  const frontmatter: Record<string, unknown> = structuredClone(existing);
  frontmatter.name = input.name;
  frontmatter.description = input.description;
  for (const [key, value] of [
    ["license", input.license],
    ["compatibility", input.compatibility],
    ["metadata", input.metadata],
    ["allowed-tools", input.allowedTools],
  ] as const) {
    if (value === undefined) delete frontmatter[key];
    else frontmatter[key] = value;
  }
  const yaml = stringify(frontmatter, { lineWidth: 0 }).trimEnd();
  return Buffer.from(`---\n${yaml}\n---\n\n${input.instructions.trim()}\n`, "utf8");
}

async function readPackageDirectory(root: string, directory = root, prefix = "", skipGitMetadata = false): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((left, right) => left.name.localeCompare(right.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (skipGitMetadata && (path === ".git" || path.startsWith(".git/"))) continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw validationError(`Skill package cannot contain symlink: ${path}`);
    if (entry.isDirectory()) {
      for (const [childPath, bytes] of await readPackageDirectory(root, absolute, path, skipGitMetadata)) files.set(childPath, bytes);
    } else if (entry.isFile()) {
      files.set(path, await readFile(absolute));
    }
  }
  return files;
}

async function writePackageDirectory(root: string, files: ReadonlyMap<string, Buffer>): Promise<void> {
  for (const [path, bytes] of files) {
    const normalized = normalizedPackagePath(path);
    const target = resolve(root, ...normalized.split("/"));
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
}

function inspectZip(bytes: Buffer): void {
  if (bytes.length > SKILL_LIMITS.archiveBytes) {
    throw payloadTooLarge(`Skill archive exceeds ${SKILL_LIMITS.archiveBytes} bytes`);
  }
  let eocd = -1;
  for (let offset = Math.max(0, bytes.length - 65_557); offset <= bytes.length - 22; offset += 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) eocd = offset;
  }
  if (eocd < 0) throw validationError("Skill ZIP is missing an end-of-central-directory record");
  const entries = bytes.readUInt16LE(eocd + 10);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (entries === 0xffff || centralOffset === 0xffffffff) throw validationError("ZIP64 skill archives are not supported");
  if (entries > SKILL_LIMITS.files) throw payloadTooLarge(`Skill archive exceeds ${SKILL_LIMITS.files} entries`);
  let offset = centralOffset;
  let extractedBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw validationError("Skill ZIP central directory is malformed");
    }
    const madeBy = bytes.readUInt16LE(offset + 4);
    const flags = bytes.readUInt16LE(offset + 8);
    const compression = bytes.readUInt16LE(offset + 10);
    const originalSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    if (flags & 1) throw validationError("Encrypted ZIP entries are not supported");
    if (compression !== 0 && compression !== 8) throw validationError(`Unsupported ZIP compression method: ${compression}`);
    if ((madeBy >> 8) === 3 && ((externalAttributes >>> 16) & 0o170000) === 0o120000) {
      throw validationError("Skill ZIP cannot contain symlinks");
    }
    if (originalSize > SKILL_LIMITS.resourceBytes) {
      throw payloadTooLarge(`Skill ZIP entry exceeds ${SKILL_LIMITS.resourceBytes} bytes`);
    }
    extractedBytes += originalSize;
    if (extractedBytes > SKILL_LIMITS.extractedBytes) {
      throw payloadTooLarge(`Skill archive exceeds ${SKILL_LIMITS.extractedBytes} extracted bytes`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function extractZip(bytes: Buffer): Map<string, Buffer> {
  inspectZip(bytes);
  const extracted = new Map<string, Buffer>();
  let extractedBytes = 0;
  const unzip = new Unzip((file) => {
    const path = file.name;
    const chunks: Buffer[] = [];
    let fileBytes = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw validationError(`Could not extract ${path}: ${error.message}`);
      if (chunk.length) {
        fileBytes += chunk.length;
        extractedBytes += chunk.length;
        if (fileBytes > SKILL_LIMITS.resourceBytes || extractedBytes > SKILL_LIMITS.extractedBytes) {
          file.terminate();
          throw payloadTooLarge(`Skill archive exceeds extracted byte limits`);
        }
        chunks.push(Buffer.from(chunk));
      }
      if (final && !path.endsWith("/")) {
        const normalized = normalizedPackagePath(path);
        if (extracted.has(normalized)) throw validationError(`Duplicate normalized skill package path: ${normalized}`);
        extracted.set(normalized, Buffer.concat(chunks));
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.push(bytes, true);
  return extracted;
}

function stripArchiveRoot(files: ReadonlyMap<string, Buffer>): { directoryName?: string; files: Map<string, Buffer> } {
  if (files.has("SKILL.md")) return { files: cloneFiles(files) };
  const firstSegments = new Set([...files.keys()].map((path) => path.split("/")[0]!));
  if (firstSegments.size !== 1) throw validationError("Skill ZIP must contain one package root");
  const directoryName = [...firstSegments][0]!;
  const prefix = `${directoryName}/`;
  const stripped = new Map<string, Buffer>();
  for (const [path, bytes] of files) {
    if (!path.startsWith(prefix)) throw validationError("Skill ZIP contains entries outside its package root");
    stripped.set(path.slice(prefix.length), Buffer.from(bytes));
  }
  if (!stripped.has("SKILL.md")) throw validationError("Skill ZIP package root must contain SKILL.md");
  return { directoryName, files: stripped };
}

export function packageFromUpload(filename: string, bytes: Buffer): LoadedPackage {
  const zip = filename.toLowerCase().endsWith(".zip") || bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (!zip) return validateSkillPackage(new Map([["SKILL.md", bytes]]));
  const rooted = stripArchiveRoot(extractZip(bytes));
  return validateSkillPackage(rooted.files, { directoryName: rooted.directoryName });
}

function resourceContent(detail: SkillDetail, files: ReadonlyMap<string, Buffer>, rawPath: string): SkillResourceContent {
  const path = normalizedPackagePath(rawPath);
  if (path === "SKILL.md") throw validationError("Use skill detail to read SKILL.md instructions");
  const resource = detail.resources.find((item) => item.path === path);
  const bytes = files.get(path);
  if (!resource || !bytes) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill resource not found: ${path}`);
  if (bytes.length > SKILL_LIMITS.runtimeTextBytes) {
    throw payloadTooLarge(`Skill resource exceeds ${SKILL_LIMITS.runtimeTextBytes} text bytes`);
  }
  let content: string;
  try {
    content = utf8Decoder.decode(bytes);
  } catch {
    throw validationError(`Skill resource is not valid UTF-8: ${path}`);
  }
  return {
    content,
    hash: resource.hash,
    path,
    revision: detail.currentRevision,
    skillId: detail.id,
    size: bytes.length,
  };
}

export class SkillCatalog {
  private builtIns = new Map<string, LoadedPackage>();
  private index: CatalogIndex = { managed: {}, schemaVersion: 1 };
  private loaded = false;
  private managed = new Map<string, ManagedPackage>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly repositoryRoot: string;
  private readonly root: string;

  constructor(dataDir: string, repositoryRoot: string) {
    this.root = resolve(dataDir, "skills");
    this.repositoryRoot = resolve(repositoryRoot);
  }

  private get indexPath(): string {
    return resolve(this.root, "catalog.json");
  }

  private revisionRoot(id: string, revision: number): string {
    return resolve(this.root, id, "revisions", String(revision));
  }

  private async saveIndex(): Promise<void> {
    const temporary = resolve(this.root, `.catalog-${randomUUID()}.json`);
    await writeFile(temporary, `${JSON.stringify(this.index, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, this.indexPath);
  }

  private async loadManaged(id: string, revision: number): Promise<ManagedPackage> {
    const root = this.revisionRoot(id, revision);
    const files = await readPackageDirectory(resolve(root, "package"));
    const loaded = validateSkillPackage(files, { directoryName: id, revision });
    let createdAt = new Date(0).toISOString();
    try {
      const metadata = JSON.parse(await readFile(resolve(root, "revision.json"), "utf8")) as { createdAt?: string; hash?: string };
      if (metadata.createdAt) createdAt = metadata.createdAt;
      if (metadata.hash && metadata.hash !== loaded.detail.hash) {
        throw validationError(`Managed skill revision hash does not match stored package: ${id}@${revision}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { ...loaded, createdAt };
  }

  private async recoverManagedStorage(): Promise<void> {
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.name === "catalog.json" || entry.name === ".staging") continue;
      if (entry.name.startsWith(".catalog-")) {
        await rm(resolve(this.root, entry.name), { force: true, recursive: true });
        continue;
      }
      if (!entry.isDirectory()) continue;
      const current = this.index.managed[entry.name]?.currentRevision;
      if (!current) {
        await rm(resolve(this.root, entry.name), { force: true, recursive: true });
        continue;
      }
      const revisionsRoot = resolve(this.root, entry.name, "revisions");
      let revisions: string[] = [];
      try {
        revisions = await readdir(revisionsRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const revisionName of revisions) {
        const revision = Number(revisionName);
        if (!Number.isInteger(revision) || revision < 1 || revision > current) {
          await rm(resolve(revisionsRoot, revisionName), { force: true, recursive: true });
        }
      }
    }
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.root, { recursive: true });
    await rm(resolve(this.root, ".staging"), { force: true, recursive: true });
    await mkdir(resolve(this.root, ".staging"), { recursive: true });
    for (const id of BUNDLED_SKILL_IDS) {
      const files = await readPackageDirectory(resolve(this.repositoryRoot, "skills", id));
      this.builtIns.set(id, validateSkillPackage(files, {
        directoryName: id,
        readOnly: true,
        revision: 1,
        source: "built-in",
        version: BUILT_IN_VERSIONS[id],
      }));
    }
    try {
      const saved = JSON.parse(await readFile(this.indexPath, "utf8")) as Partial<CatalogIndex>;
      if (saved.schemaVersion !== 1 || !saved.managed || typeof saved.managed !== "object") {
        throw validationError("Managed skill catalog has an unsupported schema");
      }
      this.index = saved as CatalogIndex;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.saveIndex();
    }
    await this.recoverManagedStorage();
    for (const [id, entry] of Object.entries(this.index.managed)) {
      if (!SKILL_NAME.test(id) || !Number.isInteger(entry.currentRevision) || entry.currentRevision < 1) {
        throw validationError(`Managed skill catalog entry is invalid: ${id}`);
      }
      this.managed.set(id, await this.loadManaged(id, entry.currentRevision));
    }
    this.loaded = true;
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

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("Skill catalog is not loaded");
  }

  ids(): string[] {
    this.assertLoaded();
    return [...this.builtIns.keys(), ...this.managed.keys()].toSorted();
  }

  list(): SkillDescriptor[] {
    this.assertLoaded();
    return [...this.builtIns.values(), ...this.managed.values()]
      .map(({ detail }) => {
        const { frontmatter: _frontmatter, instructions: _instructions, resources: _resources, ...descriptor } = detail;
        return structuredClone(descriptor);
      })
      .toSorted((left, right) => left.name.localeCompare(right.name));
  }

  get(id: string): SkillDetail | undefined {
    this.assertLoaded();
    const value = this.builtIns.get(id) ?? this.managed.get(id);
    return value ? structuredClone(value.detail) : undefined;
  }

  private async commitManaged(loaded: LoadedPackage, revision: number, createdAt: string): Promise<ManagedPackage> {
    const id = loaded.detail.id;
    const staging = resolve(this.root, ".staging", `${id}-${revision}-${randomUUID()}`);
    const destination = this.revisionRoot(id, revision);
    await mkdir(resolve(staging, "package"), { recursive: true });
    try {
      await writePackageDirectory(resolve(staging, "package"), loaded.files);
      await writeFile(resolve(staging, "revision.json"), `${JSON.stringify({ createdAt, hash: loaded.detail.hash, revision }, null, 2)}\n`, { flag: "wx" });
      await mkdir(resolve(destination, ".."), { recursive: true });
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { force: true, recursive: true });
      throw error;
    }
    return { ...loaded, createdAt };
  }

  async create(input: CreateSkillRequest): Promise<SkillDetail> {
    return await this.mutate(async () => {
      this.assertLoaded();
      const loaded = validateSkillPackage(new Map([["SKILL.md", createSkillMarkdown(input)]]), {
        directoryName: input.name,
        revision: 1,
      });
      if (this.builtIns.has(loaded.detail.id) || this.managed.has(loaded.detail.id)) {
        throw new SkillCatalogError("SKILL_CONFLICT", `Skill already exists: ${loaded.detail.id}`);
      }
      const committed = await this.commitManaged(loaded, 1, new Date().toISOString());
      this.index.managed[loaded.detail.id] = { currentRevision: 1 };
      try {
        await this.saveIndex();
      } catch (error) {
        delete this.index.managed[loaded.detail.id];
        await rm(this.revisionRoot(loaded.detail.id, 1), { force: true, recursive: true });
        throw error;
      }
      this.managed.set(loaded.detail.id, committed);
      return structuredClone(committed.detail);
    });
  }

  async import(filename: string, bytes: Buffer): Promise<SkillDetail> {
    return await this.mutate(async () => {
      this.assertLoaded();
      const loaded = packageFromUpload(filename, bytes);
      if (this.builtIns.has(loaded.detail.id) || this.managed.has(loaded.detail.id)) {
        throw new SkillCatalogError("SKILL_CONFLICT", `Skill already exists: ${loaded.detail.id}`);
      }
      const committed = await this.commitManaged(loaded, 1, new Date().toISOString());
      this.index.managed[loaded.detail.id] = { currentRevision: 1 };
      try {
        await this.saveIndex();
      } catch (error) {
        delete this.index.managed[loaded.detail.id];
        await rm(this.revisionRoot(loaded.detail.id, 1), { force: true, recursive: true });
        throw error;
      }
      this.managed.set(loaded.detail.id, committed);
      return structuredClone(committed.detail);
    });
  }

  async importFromGit(input: ImportSkillFromGitRequest): Promise<SkillDetail> {
    this.assertLoaded();
    const normalized = validateGitSkillImportRequest(input);
    const importRoot = resolve(this.root, ".imports");
    const checkout = resolve(importRoot, randomUUID());
    await mkdir(importRoot, { recursive: true });
    try {
      const arguments_ = [
        "-c", "protocol.file.allow=never",
        "clone",
        "--depth=1",
        "--filter=blob:limit=10m",
        "--no-tags",
        ...(normalized.ref ? ["--branch", normalized.ref] : []),
        "--",
        normalized.repositoryUrl,
        checkout,
      ];
      try {
        await execFileAsync("git", arguments_, {
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          maxBuffer: 1024 * 1024,
          timeout: 120_000,
        });
      } catch {
        throw validationError("Git skill checkout failed; verify the repository, ref, and locally configured credentials");
      }
      const packageRoot = normalized.subdirectory
        ? resolve(checkout, ...normalized.subdirectory.split("/"))
        : checkout;
      const rootInfo = await lstat(packageRoot).catch(() => undefined);
      if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
        throw validationError("Git skill subdirectory must resolve to a regular directory");
      }
      const files = await readPackageDirectory(packageRoot, packageRoot, "", true);
      const loaded = validateSkillPackage(files);
      return await this.mutate(async () => {
        if (this.builtIns.has(loaded.detail.id) || this.managed.has(loaded.detail.id)) {
          throw new SkillCatalogError("SKILL_CONFLICT", `Skill already exists: ${loaded.detail.id}`);
        }
        const committed = await this.commitManaged(loaded, 1, new Date().toISOString());
        this.index.managed[loaded.detail.id] = { currentRevision: 1 };
        try {
          await this.saveIndex();
        } catch (error) {
          delete this.index.managed[loaded.detail.id];
          await rm(this.revisionRoot(loaded.detail.id, 1), { force: true, recursive: true });
          throw error;
        }
        this.managed.set(loaded.detail.id, committed);
        return structuredClone(committed.detail);
      });
    } finally {
      await rm(checkout, { force: true, recursive: true });
    }
  }

  async update(id: string, input: UpdateSkillRequest): Promise<SkillDetail> {
    return await this.mutate(async () => {
      this.assertLoaded();
      if (this.builtIns.has(id)) throw new SkillCatalogError("SKILL_READ_ONLY", `Built-in skill is read-only: ${id}`);
      const current = this.managed.get(id);
      if (!current) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill not found: ${id}`);
      if (input.name !== id) throw validationError("Skill name is a stable identity and cannot be changed in place");
      if (input.expectedRevision !== current.detail.currentRevision) {
        throw new SkillCatalogError("SKILL_CONFLICT", `Skill revision conflict: expected ${input.expectedRevision}, current ${current.detail.currentRevision}`);
      }
      const revision = current.detail.currentRevision + 1;
      const files = cloneFiles(current.files);
      files.set("SKILL.md", createSkillMarkdown(input, current.detail.frontmatter));
      const loaded = validateSkillPackage(files, { directoryName: id, revision });
      const committed = await this.commitManaged(loaded, revision, new Date().toISOString());
      const previous = this.index.managed[id]!;
      this.index.managed[id] = { currentRevision: revision };
      try {
        await this.saveIndex();
      } catch (error) {
        this.index.managed[id] = previous;
        await rm(this.revisionRoot(id, revision), { force: true, recursive: true });
        throw error;
      }
      this.managed.set(id, committed);
      return structuredClone(committed.detail);
    });
  }

  async delete(id: string): Promise<void> {
    await this.mutate(async () => {
      this.assertLoaded();
      if (this.builtIns.has(id)) throw new SkillCatalogError("SKILL_READ_ONLY", `Built-in skill cannot be deleted: ${id}`);
      if (!this.managed.has(id)) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill not found: ${id}`);
      const source = resolve(this.root, id);
      const staged = resolve(this.root, ".staging", `delete-${id}-${randomUUID()}`);
      await rename(source, staged);
      const previous = this.index.managed[id]!;
      delete this.index.managed[id];
      try {
        await this.saveIndex();
      } catch (error) {
        this.index.managed[id] = previous;
        await rename(staged, source);
        throw error;
      }
      this.managed.delete(id);
      await rm(staged, { force: true, recursive: true });
    });
  }

  readCurrentResource(id: string, path: string): SkillResourceContent {
    this.assertLoaded();
    const value = this.builtIns.get(id) ?? this.managed.get(id);
    if (!value) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill not found: ${id}`);
    return resourceContent(value.detail, value.files, path);
  }

  resolve(ids: string[]): RuntimeSkillSnapshot[] {
    this.assertLoaded();
    return ids.map((id) => {
      const value = this.builtIns.get(id) ?? this.managed.get(id);
      if (!value) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill not found: ${id}`);
      const detail = structuredClone(value.detail);
      const files = cloneFiles(value.files);
      return {
        content: detail.instructions,
        description: detail.description,
        hash: detail.hash,
        id: detail.id,
        readResource: (path: string) => resourceContent(detail, files, path),
        resources: structuredClone(detail.resources),
        revision: detail.currentRevision,
        version: detail.version,
      };
    });
  }
}

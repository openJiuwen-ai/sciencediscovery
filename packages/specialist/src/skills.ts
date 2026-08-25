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
import { posix, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { promisify } from "node:util";

import type {
  ChatMessage,
  ConfirmSkillReviewDraftRequest,
  CreateSkillPackageRequest,
  CreateSkillRequest,
  CreateSkillDialogueDraftRequest,
  DistillSessionSkillRequest,
  ExecutionRun,
  CreateGitSkillReviewDraftsRequest,
  CreateGitSkillReviewDraftsResponse,
  GitSkillImportCandidate,
  GitSkillRepositoryInspection,
  ImportSkillFromGitRequest,
  InspectGitSkillRepositoryRequest,
  MergeSkillReviewDraftsRequest,
  SkillDescriptor,
  SkillDetail,
  SkillResource,
  SkillResourceContent,
  SkillResourceKind,
  SkillReviewDraft,
  SkillReviewDraftSummary,
  SkillReviewFile,
  SkillVersionSnapshot,
  SkillVersionSummary,
  SkillVersionProvenance,
  SkillDraft,
  SkillValidationDiagnostic,
  UpdateSkillRequest,
  UpdateSkillFileRequest,
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
  "skill-creator",
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
  "skill-creator": "1.3.0",
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
const GIT_SKILL_DISCOVERY_LIMIT = 100;
const GIT_SKILL_DISCOVERY_DEPTH = 12;

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
  provenance: SkillVersionProvenance;
}

interface StoredSkillReviewFile {
  binary?: boolean;
  content?: string;
  encodedContent?: string;
  path: string;
}

interface StoredSkillReviewDraft {
  baseRevision?: number;
  comparisonFiles?: StoredSkillReviewFile[];
  createdAt: string;
  draftId: string;
  files: StoredSkillReviewFile[];
  name: string;
  provenance?: SkillVersionProvenance;
  proposalHistory?: Array<{
    createdAt: string;
    files: StoredSkillReviewFile[];
    provenance?: SkillVersionProvenance;
    proposalId: string;
  }>;
  updatedAt: string;
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
  let repositoryUrl = input.repositoryUrl?.trim();
  if (!repositoryUrl || repositoryUrl.length > 2_000) throw validationError("Git repository URL is required");
  const scpStyle = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s\0]+$/.test(repositoryUrl);
  let linkedRef: string | undefined;
  let linkedSubdirectory: string | undefined;
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
    if (parsed.protocol === "https:" && new Set(["github.com", "www.github.com"]).has(parsed.hostname.toLowerCase())) {
      let segments: string[];
      try {
        segments = parsed.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
      } catch {
        throw validationError("GitHub repository URL contains invalid path encoding");
      }
      if (segments.length >= 4 && segments[2] === "tree") {
        const repositoryName = segments[1]!.replace(/\.git$/, "");
        repositoryUrl = `https://github.com/${encodeURIComponent(segments[0]!)}/${encodeURIComponent(repositoryName)}.git`;
        linkedRef = segments[3];
        linkedSubdirectory = segments.slice(4).join("/") || undefined;
      }
    }
  }
  const ref = input.ref?.trim() || linkedRef || undefined;
  if (ref && (ref.length > 200 || ref.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(ref))) {
    throw validationError("Git ref contains unsupported characters");
  }
  const rawSubdirectory = input.subdirectory?.trim().replace(/\/+$/, "") || linkedSubdirectory || undefined;
  const subdirectory = rawSubdirectory ? normalizedPackagePath(rawSubdirectory) : undefined;
  return { repositoryUrl, ...(ref ? { ref } : {}), ...(subdirectory ? { subdirectory } : {}) };
}

export async function discoverGitSkillRoots(checkout: string, requestedSubdirectory?: string): Promise<string[]> {
  const discoveryRoot = requestedSubdirectory
    ? resolve(checkout, ...requestedSubdirectory.split("/"))
    : checkout;
  if (requestedSubdirectory) {
    const rootInfo = await lstat(discoveryRoot).catch(() => undefined);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
      throw validationError(`Git search path is not a regular directory: ${requestedSubdirectory}`);
    }
    const skillMarkdown = await lstat(resolve(discoveryRoot, "SKILL.md")).catch(() => undefined);
    if (skillMarkdown?.isFile() && !skillMarkdown.isSymbolicLink()) return [requestedSubdirectory];
  }
  const roots: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (roots.length >= GIT_SKILL_DISCOVERY_LIMIT || depth > GIT_SKILL_DISCOVERY_DEPTH) return;
    const entries = await readdir(directory, { withFileTypes: true });
    const skillMarkdown = entries.find((entry) => entry.name === "SKILL.md");
    if (skillMarkdown?.isFile() && !skillMarkdown.isSymbolicLink()) {
      const subdirectory = relative(checkout, directory).split("\\").join("/") || ".";
      roots.push(subdirectory);
      return;
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (roots.length >= GIT_SKILL_DISCOVERY_LIMIT) return;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (new Set([".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv"]).has(entry.name)) continue;
      await visit(resolve(directory, entry.name), depth + 1);
    }
  }
  await visit(discoveryRoot, 0);
  if (!roots.length) {
    throw validationError(requestedSubdirectory
      ? `Git search path does not contain a discoverable SKILL.md: ${requestedSubdirectory}`
      : "Git repository does not contain a discoverable SKILL.md");
  }
  return roots.toSorted();
}

async function checkoutGitSkillRepository(
  importRoot: string,
  input: InspectGitSkillRepositoryRequest,
): Promise<{
  checkout: string;
  commit: string;
  normalized: ReturnType<typeof validateGitSkillImportRequest>;
}> {
  const normalized = validateGitSkillImportRequest(input);
  const checkout = resolve(importRoot, randomUUID());
  await mkdir(importRoot, { recursive: true });
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
    const { stdout } = await execFileAsync("git", ["-C", checkout, "rev-parse", "HEAD"], {
      maxBuffer: 64 * 1024,
      timeout: 10_000,
    });
    return { checkout, commit: stdout.trim().toLowerCase(), normalized };
  } catch {
    await rm(checkout, { force: true, recursive: true });
    throw validationError("Git skill checkout failed; verify the repository, ref, and locally configured credentials");
  }
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

function compareSkillPaths(left: { path: string }, right: { path: string }): number {
  if (left.path === "SKILL.md") return right.path === "SKILL.md" ? 0 : -1;
  if (right.path === "SKILL.md") return 1;
  return left.path.localeCompare(right.path);
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
  private reviewDrafts = new Map<string, StoredSkillReviewDraft>();
  private readonly repositoryRoot: string;
  private readonly root: string;

  constructor(dataDir: string, repositoryRoot: string) {
    this.root = resolve(dataDir, "skills");
    this.repositoryRoot = resolve(repositoryRoot);
  }

  private get indexPath(): string {
    return resolve(this.root, "catalog.json");
  }

  private get reviewDraftRoot(): string {
    return resolve(this.root, ".drafts");
  }

  private reviewDraftPath(draftId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(draftId)) throw validationError(`Invalid Skill draft id: ${draftId}`);
    return resolve(this.reviewDraftRoot, `${draftId}.json`);
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
    let provenance: SkillVersionProvenance = { source: "manual" };
    try {
      const metadata = JSON.parse(await readFile(resolve(root, "revision.json"), "utf8")) as { createdAt?: string; hash?: string; provenance?: SkillVersionProvenance };
      if (metadata.createdAt) createdAt = metadata.createdAt;
      if (metadata.provenance) provenance = metadata.provenance;
      if (metadata.hash && metadata.hash !== loaded.detail.hash) {
        throw validationError(`Managed skill revision hash does not match stored package: ${id}@${revision}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { ...loaded, createdAt, provenance };
  }

  private async recoverManagedStorage(): Promise<void> {
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.name === "catalog.json" || entry.name === ".drafts" || entry.name === ".staging") continue;
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
    await mkdir(this.reviewDraftRoot, { recursive: true });
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
    const storedReviewDrafts: Array<{ draft: StoredSkillReviewDraft; filename: string }> = [];
    for (const filename of await readdir(this.reviewDraftRoot)) {
      if (!filename.endsWith(".json")) continue;
      const stored = JSON.parse(await readFile(resolve(this.reviewDraftRoot, filename), "utf8")) as StoredSkillReviewDraft;
      if (`${stored.draftId}.json` !== filename || !Array.isArray(stored.files)
        || (stored.comparisonFiles !== undefined && !Array.isArray(stored.comparisonFiles))) {
        throw validationError(`Stored Skill review draft is invalid: ${filename}`);
      }
      storedReviewDrafts.push({ draft: stored, filename });
    }
    const reviewDraftsByName = new Map<string, Array<{ draft: StoredSkillReviewDraft; filename: string }>>();
    for (const stored of storedReviewDrafts) {
      const group = reviewDraftsByName.get(stored.draft.name) ?? [];
      group.push(stored);
      reviewDraftsByName.set(stored.draft.name, group);
    }
    for (const drafts of reviewDraftsByName.values()) {
      drafts.sort((left, right) => left.draft.updatedAt.localeCompare(right.draft.updatedAt)
        || left.draft.createdAt.localeCompare(right.draft.createdAt));
      const latest = drafts.at(-1)!;
      const proposalHistory: NonNullable<StoredSkillReviewDraft["proposalHistory"]> = [];
      for (const [draftIndex, stored] of drafts.entries()) {
        if (stored.draft.proposalHistory?.length) {
          proposalHistory.push(...stored.draft.proposalHistory.map((proposal) => ({
            ...proposal,
            files: proposal.files.map((file) => ({ ...file })),
          })));
        } else if (stored.draft.comparisonFiles?.length) {
          proposalHistory.push({
            createdAt: stored.draft.createdAt,
            files: stored.draft.comparisonFiles.map((file) => ({ ...file })),
            provenance: stored.draft.provenance ?? { source: "agent" },
            proposalId: randomUUID(),
          });
        }
        if (draftIndex < drafts.length - 1) {
          proposalHistory.push({
            createdAt: stored.draft.updatedAt,
            files: stored.draft.files.map((file) => ({ ...file })),
            provenance: stored.draft.provenance ?? { source: "agent" },
            proposalId: randomUUID(),
          });
        }
      }
      const requiresMigration = drafts.length > 1
        || (!latest.draft.proposalHistory && proposalHistory.length > 0);
      if (requiresMigration) {
        const previous = drafts.at(-2)!;
        latest.draft = {
          ...latest.draft,
          ...(previous ? { comparisonFiles: previous.draft.files.map((file) => ({ ...file })) } : {}),
          createdAt: drafts[0]!.draft.createdAt,
          proposalHistory,
        };
        await this.saveReviewDraft(latest.draft);
        for (const superseded of drafts.slice(0, -1)) {
          await rm(resolve(this.reviewDraftRoot, superseded.filename), { force: true });
        }
      }
      this.reviewDrafts.set(latest.draft.draftId, latest.draft);
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

  private reviewSummary(draft: StoredSkillReviewDraft): SkillReviewDraftSummary {
    return {
      ...(draft.baseRevision !== undefined ? { baseRevision: draft.baseRevision } : {}),
      ...(draft.comparisonFiles
        ? { comparisonSource: "previous-agent-draft" as const }
        : draft.baseRevision !== undefined
          ? { comparisonSource: "installed-revision" as const }
          : {}),
      createdAt: draft.createdAt,
      draftId: draft.draftId,
      fileCount: draft.files.length,
      name: draft.name,
      provenance: draft.provenance ?? { source: "agent" },
      updatedAt: draft.updatedAt,
    };
  }

  private async saveReviewDraft(draft: StoredSkillReviewDraft, create = false): Promise<void> {
    const destination = this.reviewDraftPath(draft.draftId);
    if (create) {
      await writeFile(destination, `${JSON.stringify(draft, null, 2)}\n`, { flag: "wx" });
      return;
    }
    const temporary = resolve(this.reviewDraftRoot, `${draft.draftId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(draft, null, 2)}\n`, { flag: "wx" });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private reviewFile(path: string, bytes: Buffer): SkillReviewFile {
    try {
      return { content: utf8Decoder.decode(bytes), path, size: bytes.length };
    } catch {
      return { binary: true, path, size: bytes.length };
    }
  }

  private storedReviewFile(path: string, bytes: Buffer): StoredSkillReviewFile {
    try {
      return { content: utf8Decoder.decode(bytes), path };
    } catch {
      return { binary: true, encodedContent: bytes.toString("base64"), path };
    }
  }

  private storedReviewFileBytes(file: StoredSkillReviewFile): Buffer {
    if (file.binary) {
      if (!file.encodedContent) throw validationError(`Binary Skill proposal is missing content: ${file.path}`);
      return Buffer.from(file.encodedContent, "base64");
    }
    if (file.content === undefined) throw validationError(`Text Skill proposal is missing content: ${file.path}`);
    return Buffer.from(file.content, "utf8");
  }

  private publicReviewFile(file: StoredSkillReviewFile, includeEncodedContent = false): SkillReviewFile {
    const bytes = this.storedReviewFileBytes(file);
    return {
      ...(file.binary ? { binary: true } : { content: file.content }),
      ...(file.binary && includeEncodedContent ? { encodedContent: file.encodedContent } : {}),
      path: file.path,
      size: bytes.length,
    };
  }

  private renameReviewFiles(files: StoredSkillReviewFile[], name: string): StoredSkillReviewFile[] {
    const renamed = files.map((file) => ({ ...file }));
    const skillMarkdown = renamed.find((file) => file.path === "SKILL.md");
    if (!skillMarkdown || skillMarkdown.binary || skillMarkdown.content === undefined) {
      throw validationError("Every Skill proposal must include a text SKILL.md");
    }
    const parsed = parseSkillMarkdown(Buffer.from(skillMarkdown.content, "utf8"));
    parsed.frontmatter.name = name;
    skillMarkdown.content = `---\n${stringify(parsed.frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${parsed.instructions}\n`;
    validateSkillPackage(new Map(renamed.map((file) => [file.path, this.storedReviewFileBytes(file)])), { directoryName: name });
    return renamed.toSorted(compareSkillPaths);
  }

  listReviewDrafts(): SkillReviewDraftSummary[] {
    this.assertLoaded();
    return [...this.reviewDrafts.values()]
      .map((draft) => this.reviewSummary(draft))
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getReviewDraft(draftId: string): Promise<SkillReviewDraft | undefined> {
    this.assertLoaded();
    const draft = this.reviewDrafts.get(draftId);
    if (!draft) return undefined;
    const base = draft.comparisonFiles
      ? undefined
      : draft.baseRevision === undefined
        ? undefined
        : await this.loadManaged(draft.name, draft.baseRevision);
    return {
      ...this.reviewSummary(draft),
      baseFiles: draft.comparisonFiles
        ? draft.comparisonFiles
          .map((file) => this.publicReviewFile(file))
          .toSorted(compareSkillPaths)
        : base
        ? [...base.files].map(([path, bytes]) => this.reviewFile(path, bytes)).toSorted(compareSkillPaths)
        : [],
      files: draft.files.map((file) => this.publicReviewFile(file, true)),
    };
  }

  private packageReviewFiles(files: ReadonlyMap<string, Buffer>): SkillReviewFile[] {
    return [...files]
      .map(([path, bytes]) => this.reviewFile(path, bytes))
      .toSorted(compareSkillPaths);
  }

  async listSkillVersions(id: string): Promise<SkillVersionSummary[]> {
    this.assertLoaded();
    const versions: SkillVersionSummary[] = [];
    const builtIn = this.builtIns.get(id);
    if (builtIn) {
      versions.push({
        current: true,
        fileCount: builtIn.files.size,
        id: "built-in",
        kind: "built-in",
        label: `Built-in · ${builtIn.detail.version}`,
        provenance: { source: "built-in" },
        revision: 1,
      });
    }
    const managed = this.managed.get(id);
    if (managed) {
      for (let revision = 1; revision <= managed.detail.currentRevision; revision += 1) {
        const loaded = revision === managed.detail.currentRevision ? managed : await this.loadManaged(id, revision);
        versions.push({
          createdAt: loaded.createdAt,
          current: revision === managed.detail.currentRevision,
          fileCount: loaded.files.size,
          id: `revision:${revision}`,
          kind: "managed-revision",
          label: `Installed revision r${revision}`,
          provenance: loaded.provenance,
          revision,
        });
      }
    }
    const draft = [...this.reviewDrafts.values()].find((candidate) => candidate.name === id);
    if (draft) {
      for (const [index, proposal] of (draft.proposalHistory ?? []).entries()) {
        versions.push({
          createdAt: proposal.createdAt,
          current: false,
          fileCount: proposal.files.length,
          id: `proposal:${proposal.proposalId}`,
          kind: "agent-proposal",
          label: `Agent proposal ${index + 1}`,
          provenance: proposal.provenance ?? draft.provenance ?? { source: "agent" },
        });
      }
      versions.push({
        createdAt: draft.updatedAt,
        current: true,
        fileCount: draft.files.length,
        id: `draft:${draft.draftId}`,
        kind: "agent-proposal",
        label: "Current pending proposal",
        provenance: draft.provenance ?? { source: "agent" },
      });
    }
    if (!versions.length) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill not found: ${id}`);
    return versions.toReversed();
  }

  async getSkillVersion(id: string, versionId: string): Promise<SkillVersionSnapshot> {
    const versions = await this.listSkillVersions(id);
    const summary = versions.find((version) => version.id === versionId);
    if (!summary) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill version not found: ${id}@${versionId}`);
    if (versionId === "built-in") {
      const loaded = this.builtIns.get(id)!;
      return { ...summary, files: this.packageReviewFiles(loaded.files), skillId: id };
    }
    if (versionId.startsWith("revision:")) {
      const revision = Number(versionId.slice("revision:".length));
      const current = this.managed.get(id)!;
      const loaded = revision === current.detail.currentRevision ? current : await this.loadManaged(id, revision);
      return { ...summary, files: this.packageReviewFiles(loaded.files), skillId: id };
    }
    const draft = [...this.reviewDrafts.values()].find((candidate) => candidate.name === id)!;
    if (versionId === `draft:${draft.draftId}`) {
      return {
        ...summary,
        files: draft.files.map((file) => this.publicReviewFile(file)).toSorted(compareSkillPaths),
        skillId: id,
      };
    }
    const proposal = draft.proposalHistory?.find((candidate) => `proposal:${candidate.proposalId}` === versionId);
    if (!proposal) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill version not found: ${id}@${versionId}`);
    return {
      ...summary,
      files: proposal.files.map((file) => this.publicReviewFile(file)).toSorted(compareSkillPaths),
      skillId: id,
    };
  }

  async createReviewDraft(
    input: CreateSkillPackageRequest,
    provenance: SkillVersionProvenance = { source: "agent" },
  ): Promise<SkillReviewDraftSummary> {
    return await this.mutate(async () => {
      this.assertLoaded();
      const files = new Map<string, Buffer>([["SKILL.md", createSkillMarkdown(input)]]);
      for (const resource of input.resources ?? []) {
        if (resource.path === "SKILL.md" || files.has(resource.path)) {
          throw validationError(`Duplicate skill package path: ${resource.path}`);
        }
        files.set(resource.path, Buffer.from(resource.content, "utf8"));
      }
      const loaded = validateSkillPackage(files, { directoryName: input.name });
      return await this.upsertReviewDraft(loaded, provenance);
    });
  }

  private async upsertReviewDraft(
    loaded: LoadedPackage,
    provenance: SkillVersionProvenance,
  ): Promise<SkillReviewDraftSummary> {
    if (this.builtIns.has(loaded.detail.id)) {
      throw new SkillCatalogError("SKILL_READ_ONLY", `Built-in skill is read-only: ${loaded.detail.id}`);
    }
    const now = new Date().toISOString();
    const proposedFiles = [...loaded.files]
      .map(([path, bytes]) => this.storedReviewFile(path, bytes))
      .toSorted(compareSkillPaths);
    const existing = [...this.reviewDrafts.values()].find((candidate) => candidate.name === loaded.detail.id);
    if (existing) {
      const parsedUpdatedAt = Date.parse(existing.updatedAt);
      const updatedAt = new Date(Math.max(
        Date.now(),
        Number.isNaN(parsedUpdatedAt) ? Date.now() : parsedUpdatedAt + 1,
      )).toISOString();
      const updated: StoredSkillReviewDraft = {
        ...existing,
        comparisonFiles: existing.files.map((file) => ({ ...file })),
        files: proposedFiles,
        proposalHistory: [
          ...(existing.proposalHistory ?? []),
          {
            createdAt: existing.updatedAt,
            files: existing.files.map((file) => ({ ...file })),
            provenance: existing.provenance ?? { source: "agent" },
            proposalId: randomUUID(),
          },
        ],
        provenance,
        updatedAt,
      };
      await this.saveReviewDraft(updated);
      this.reviewDrafts.set(updated.draftId, updated);
      return this.reviewSummary(updated);
    }
    const draft: StoredSkillReviewDraft = {
      ...(this.managed.get(loaded.detail.id)?.detail.currentRevision !== undefined
        ? { baseRevision: this.managed.get(loaded.detail.id)!.detail.currentRevision }
        : {}),
      createdAt: now,
      draftId: randomUUID(),
      files: proposedFiles,
      name: loaded.detail.id,
      provenance,
      updatedAt: now,
    };
    await this.saveReviewDraft(draft, true);
    this.reviewDrafts.set(draft.draftId, draft);
    return this.reviewSummary(draft);
  }

  async discardReviewDraft(draftId: string): Promise<void> {
    await this.mutate(async () => {
      this.assertLoaded();
      if (!this.reviewDrafts.has(draftId)) {
        throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill review draft not found: ${draftId}`);
      }
      await rm(this.reviewDraftPath(draftId), { force: true });
      this.reviewDrafts.delete(draftId);
    });
  }

  async mergeReviewDrafts(input: MergeSkillReviewDraftsRequest): Promise<SkillReviewDraftSummary> {
    return await this.mutate(async () => {
      this.assertLoaded();
      const draftIds = [...new Set(input.draftIds)];
      if (draftIds.length < 2 || !draftIds.includes(input.targetDraftId)) {
        throw validationError("Select at least two drafts and include the primary draft");
      }
      const drafts = draftIds.map((draftId) => {
        const draft = this.reviewDrafts.get(draftId);
        if (!draft) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill review draft not found: ${draftId}`);
        return draft;
      });
      if (drafts.some((draft) => draft.baseRevision !== undefined)) {
        throw validationError("Installed Skill revisions cannot be combined with drafts from another Skill");
      }
      const target = this.reviewDrafts.get(input.targetDraftId)!;
      const proposals = drafts.flatMap((draft) => [
        ...(draft.proposalHistory ?? []).map((proposal) => ({
          createdAt: proposal.createdAt,
          files: this.renameReviewFiles(proposal.files, target.name),
          provenance: proposal.provenance ?? draft.provenance ?? { source: "agent" },
          proposalId: proposal.proposalId,
        })),
        {
          createdAt: draft.updatedAt,
          files: this.renameReviewFiles(draft.files, target.name),
          provenance: draft.provenance ?? { source: "agent" },
          proposalId: randomUUID(),
        },
      ]).toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)
        || left.proposalId.localeCompare(right.proposalId));
      const current = proposals.at(-1)!;
      const proposalHistory = proposals.slice(0, -1);
      const updated: StoredSkillReviewDraft = {
        createdAt: drafts.map((draft) => draft.createdAt).toSorted()[0]!,
        ...(proposalHistory.length ? { comparisonFiles: proposalHistory.at(-1)!.files.map((file) => ({ ...file })) } : {}),
        draftId: target.draftId,
        files: current.files.map((file) => ({ ...file })),
        name: target.name,
        proposalHistory,
        provenance: current.provenance,
        updatedAt: current.createdAt,
      };
      await this.saveReviewDraft(updated);
      this.reviewDrafts.set(updated.draftId, updated);
      for (const source of drafts) {
        if (source.draftId === updated.draftId) continue;
        await rm(this.reviewDraftPath(source.draftId), { force: true });
        this.reviewDrafts.delete(source.draftId);
      }
      return this.reviewSummary(updated);
    });
  }

  async confirmReviewDraft(draftId: string, input: ConfirmSkillReviewDraftRequest): Promise<SkillDetail> {
    return await this.mutate(async () => {
      this.assertLoaded();
      const draft = this.reviewDrafts.get(draftId);
      if (!draft) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill review draft not found: ${draftId}`);
      if (input.expectedUpdatedAt !== draft.updatedAt) {
        throw new SkillCatalogError("SKILL_CONFLICT", "Skill review draft changed; reload it before confirming");
      }
      const files = new Map<string, Buffer>();
      for (const file of input.files) {
        if (files.has(file.path)) throw validationError(`Duplicate skill package path: ${file.path}`);
        files.set(file.path, this.storedReviewFileBytes(file));
      }
      const current = this.managed.get(draft.name);
      if (draft.baseRevision !== undefined) {
        if (!current || current.detail.currentRevision !== draft.baseRevision) {
          throw new SkillCatalogError("SKILL_CONFLICT", `Skill ${draft.name} changed after this draft was created`);
        }
      }
      const revision = draft.baseRevision === undefined ? 1 : draft.baseRevision + 1;
      const loaded = validateSkillPackage(files, {
        ...(draft.baseRevision !== undefined ? { directoryName: draft.name } : {}),
        revision,
      });
      if (draft.baseRevision === undefined && (this.builtIns.has(loaded.detail.id) || this.managed.has(loaded.detail.id))) {
        throw new SkillCatalogError("SKILL_CONFLICT", `Skill already exists: ${loaded.detail.id}`);
      }
      const committed = await this.commitManaged(
        loaded,
        revision,
        new Date().toISOString(),
        draft.provenance ?? { source: "agent" },
      );
      const previous = this.index.managed[loaded.detail.id];
      this.index.managed[loaded.detail.id] = { currentRevision: revision };
      try {
        await this.saveIndex();
      } catch (error) {
        if (previous) this.index.managed[loaded.detail.id] = previous;
        else delete this.index.managed[loaded.detail.id];
        await rm(this.revisionRoot(loaded.detail.id, revision), { force: true, recursive: true });
        throw error;
      }
      this.managed.set(loaded.detail.id, committed);
      await rm(this.reviewDraftPath(draftId), { force: true });
      this.reviewDrafts.delete(draftId);
      return structuredClone(committed.detail);
    });
  }

  private async commitManaged(
    loaded: LoadedPackage,
    revision: number,
    createdAt: string,
    provenance: SkillVersionProvenance,
  ): Promise<ManagedPackage> {
    const id = loaded.detail.id;
    const staging = resolve(this.root, ".staging", `${id}-${revision}-${randomUUID()}`);
    const destination = this.revisionRoot(id, revision);
    await mkdir(resolve(staging, "package"), { recursive: true });
    try {
      await writePackageDirectory(resolve(staging, "package"), loaded.files);
      await writeFile(resolve(staging, "revision.json"), `${JSON.stringify({ createdAt, hash: loaded.detail.hash, provenance, revision }, null, 2)}\n`, { flag: "wx" });
      await mkdir(resolve(destination, ".."), { recursive: true });
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { force: true, recursive: true });
      throw error;
    }
    return { ...loaded, createdAt, provenance };
  }

  async create(input: CreateSkillRequest): Promise<SkillDetail> {
    return await this.createPackage(input);
  }

  async createPackage(input: CreateSkillPackageRequest): Promise<SkillDetail> {
    return await this.mutate(async () => {
      this.assertLoaded();
      const files = new Map<string, Buffer>([["SKILL.md", createSkillMarkdown(input)]]);
      for (const resource of input.resources ?? []) {
        if (resource.path === "SKILL.md" || files.has(resource.path)) {
          throw validationError(`Duplicate skill package path: ${resource.path}`);
        }
        files.set(resource.path, Buffer.from(resource.content, "utf8"));
      }
      const loaded = validateSkillPackage(files, {
        directoryName: input.name,
        revision: 1,
      });
      if (this.builtIns.has(loaded.detail.id) || this.managed.has(loaded.detail.id)) {
        throw new SkillCatalogError("SKILL_CONFLICT", `Skill already exists: ${loaded.detail.id}`);
      }
      const committed = await this.commitManaged(loaded, 1, new Date().toISOString(), {
        ...(input.sourceSessionId ? { sessionId: input.sourceSessionId } : {}),
        source: "manual",
      });
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
      const committed = await this.commitManaged(loaded, 1, new Date().toISOString(), { source: "local-import" });
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

  private async inspectGitCheckout(
    checkout: string,
    subdirectory?: string,
  ): Promise<Array<{ candidate: GitSkillImportCandidate; loaded?: LoadedPackage }>> {
    const roots = await discoverGitSkillRoots(checkout, subdirectory);
    const results: Array<{ candidate: GitSkillImportCandidate; loaded?: LoadedPackage }> = [];
    for (const root of roots) {
      try {
        const packageRoot = root === "." ? checkout : resolve(checkout, ...root.split("/"));
        const files = await readPackageDirectory(packageRoot, packageRoot, "", true);
        const loaded = validateSkillPackage(files);
        const current = this.managed.get(loaded.detail.id);
        const builtIn = this.builtIns.get(loaded.detail.id);
        const status: GitSkillImportCandidate["status"] = builtIn
          ? "invalid"
          : !current
            ? "new"
            : current.detail.hash === loaded.detail.hash
              ? "unchanged"
              : "update";
        results.push({
          candidate: {
            ...(current ? { currentRevision: current.detail.currentRevision } : {}),
            description: loaded.detail.description,
            diagnostics: [
              ...(builtIn ? [`${loaded.detail.id} is built in and read-only`] : []),
              ...loaded.detail.diagnostics.map((diagnostic) => diagnostic.message),
            ],
            name: loaded.detail.name,
            packageHash: loaded.detail.hash,
            status,
            subdirectory: root,
          },
          ...(builtIn ? {} : { loaded }),
        });
      } catch (error) {
        results.push({
          candidate: {
            diagnostics: [error instanceof Error ? error.message : String(error)],
            status: "invalid",
            subdirectory: root,
          },
        });
      }
    }
    return results;
  }

  async inspectGitRepository(input: InspectGitSkillRepositoryRequest): Promise<GitSkillRepositoryInspection> {
    this.assertLoaded();
    const importRoot = resolve(this.root, ".imports");
    const { checkout, commit, normalized } = await checkoutGitSkillRepository(importRoot, input);
    try {
      const inspected = await this.inspectGitCheckout(checkout, normalized.subdirectory);
      return {
        candidates: inspected.map(({ candidate }) => candidate),
        commit,
        ...(normalized.ref ? { ref: normalized.ref } : {}),
        repositoryUrl: normalized.repositoryUrl,
      };
    } finally {
      await rm(checkout, { force: true, recursive: true });
    }
  }

  async createGitReviewDrafts(
    input: CreateGitSkillReviewDraftsRequest,
  ): Promise<CreateGitSkillReviewDraftsResponse> {
    this.assertLoaded();
    const expectedCommit = input.commit?.trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(expectedCommit)) {
      throw validationError("Git commit must be the exact commit returned by repository inspection");
    }
    const subdirectories = [...new Set(input.subdirectories?.map((path) => {
      const trimmed = path?.trim();
      return trimmed === "." ? "." : normalizedPackagePath(trimmed);
    }) ?? [])];
    if (!subdirectories.length || subdirectories.length > GIT_SKILL_DISCOVERY_LIMIT) {
      throw validationError(`Select between 1 and ${GIT_SKILL_DISCOVERY_LIMIT} Git Skill packages`);
    }
    const importRoot = resolve(this.root, ".imports");
    const { checkout, commit, normalized } = await checkoutGitSkillRepository(importRoot, input);
    try {
      if (commit !== expectedCommit) {
        throw new SkillCatalogError(
          "SKILL_CONFLICT",
          `Git ref moved after inspection (expected ${expectedCommit.slice(0, 12)}, found ${commit.slice(0, 12)}); scan again before importing`,
        );
      }
      const inspected = await this.inspectGitCheckout(checkout, normalized.subdirectory);
      const byPath = new Map(inspected.map((entry) => [entry.candidate.subdirectory, entry]));
      const selected = subdirectories.map((subdirectory) => {
        const entry = byPath.get(subdirectory);
        if (!entry) throw validationError(`Selected Git Skill was not found at commit ${commit.slice(0, 12)}: ${subdirectory}`);
        if (!entry.loaded || entry.candidate.status === "invalid") {
          throw validationError(`Selected Git Skill is invalid: ${subdirectory}`);
        }
        if (entry.candidate.status === "unchanged") {
          throw validationError(`Selected Git Skill has no changes: ${subdirectory}`);
        }
        return { loaded: entry.loaded, subdirectory };
      });
      const names = selected.map(({ loaded }) => loaded.detail.id);
      if (new Set(names).size !== names.length) {
        throw validationError("Selected Git packages declare duplicate Skill names");
      }
      const drafts = await this.mutate(async () => {
        const previous = new Map<string, StoredSkillReviewDraft | undefined>();
        for (const { loaded } of selected) {
          previous.set(
            loaded.detail.id,
            structuredClone([...this.reviewDrafts.values()].find((draft) => draft.name === loaded.detail.id)),
          );
        }
        try {
          const created: SkillReviewDraftSummary[] = [];
          for (const { loaded, subdirectory } of selected) {
            created.push(await this.upsertReviewDraft(loaded, {
              git: {
                commit,
                ...(normalized.ref ? { ref: normalized.ref } : {}),
                repositoryUrl: normalized.repositoryUrl,
                subdirectory,
              },
              source: "git",
            }));
          }
          return created;
        } catch (error) {
          for (const [name, snapshot] of previous) {
            const current = [...this.reviewDrafts.values()].find((draft) => draft.name === name);
            if (current) {
              await rm(this.reviewDraftPath(current.draftId), { force: true });
              this.reviewDrafts.delete(current.draftId);
            }
            if (snapshot) {
              await this.saveReviewDraft(snapshot, true);
              this.reviewDrafts.set(snapshot.draftId, snapshot);
            }
          }
          throw error;
        }
      });
      return { commit, drafts };
    } finally {
      await rm(checkout, { force: true, recursive: true });
    }
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
        const { stdout } = await execFileAsync("git", ["-C", checkout, "rev-parse", "HEAD"], { timeout: 10_000 });
        const committed = await this.commitManaged(loaded, 1, new Date().toISOString(), {
          git: {
            commit: stdout.trim(),
            ...(normalized.ref ? { ref: normalized.ref } : {}),
            repositoryUrl: normalized.repositoryUrl,
            subdirectory: normalized.subdirectory ?? ".",
          },
          source: "git",
        });
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
      const committed = await this.commitManaged(loaded, revision, new Date().toISOString(), {
        ...(input.sourceSessionId ? { sessionId: input.sourceSessionId } : {}),
        source: "manual",
      });
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

  async updateFile(id: string, path: string, input: UpdateSkillFileRequest): Promise<SkillDetail> {
    return await this.mutate(async () => {
      this.assertLoaded();
      if (this.builtIns.has(id)) throw new SkillCatalogError("SKILL_READ_ONLY", `Built-in skill is read-only: ${id}`);
      const current = this.managed.get(id);
      if (!current) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill not found: ${id}`);
      if (input.expectedRevision !== current.detail.currentRevision) {
        throw new SkillCatalogError("SKILL_CONFLICT", `Skill revision conflict: expected ${input.expectedRevision}, current ${current.detail.currentRevision}`);
      }
      const revision = current.detail.currentRevision + 1;
      const files = cloneFiles(current.files);
      files.set(path, Buffer.from(input.content, "utf8"));
      const loaded = validateSkillPackage(files, { directoryName: id, revision });
      const committed = await this.commitManaged(loaded, revision, new Date().toISOString(), {
        ...(input.sourceSessionId ? { sessionId: input.sourceSessionId } : {}),
        source: "manual",
      });
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

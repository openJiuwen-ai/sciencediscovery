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
  chmod,
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
  DeleteSkillFileRequest,
  DistillSessionSkillRequest,
  ExecutionRun,
  CreateGitSkillReviewDraftsRequest,
  CreateGitSkillReviewDraftsResponse,
  GitSkillImportCandidate,
  GitSkillRepositoryInspection,
  ImportSkillFromGitRequest,
  InspectGitSkillRepositoryRequest,
  StartGitSkillImportJobRequest,
  MergeSkillReviewDraftsRequest,
  RenameSkillFileRequest,
  SkillDescriptor,
  SkillDetail,
  SkillPackageFileBytes,
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
  SkillMarkdownContent,
  SkillValidationDiagnostic,
  UpdateSkillMarkdownRequest,
  UpdateSkillRequest,
  UpdateSkillFileRequest,
} from "@sciencediscovery/schema";
import { sha256 } from "@sciencediscovery/cas";
import { settledExecutionRuns } from "@sciencediscovery/provenance";
import { Unzip, UnzipInflate, zipSync } from "fflate";
import { parseDocument, stringify } from "yaml";

/** Domain skills bundled with the first-party Specialist catalog. */
export const BUNDLED_SKILL_IDS = [
  "antibody-design",
  "assessment-screening",
  "code-engineer",
  "computation-reviewer",
  "citation-reviewer",
  "creative-material-design",
  "evidence-extractor",
  "evolve-design",
  "idea-tree-team",
  "insight-aggregator",
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
  "antibody-design": "1.0.0",
  "assessment-screening": "1.0.0",
  "code-engineer": "1.0.0",
  "computation-reviewer": "1.0.0",
  "citation-reviewer": "1.0.0",
  "creative-material-design": "1.0.0",
  "evidence-extractor": "1.0.0",
  "evolve-design": "1.1.0",
  "idea-tree-team": "4.0.0",
  "insight-aggregator": "1.0.0",
  "life-science-evidence-brief": "1.2.0",
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
/** How many packages one inspection response carries. A repository can hold
 *  more than this, so the response also says how many there are and hands
 *  back a cursor for the next page; discovery itself walks every `SKILL.md`
 *  in the checkout, and only the page's files are read. */
const GIT_SKILL_INSPECTION_PAGE_SIZE = 500;
/** One bulk review request may name at most this many packages. */
const GIT_SKILL_SELECTION_LIMIT = 500;
const GIT_SKILL_DISCOVERY_DEPTH = 12;
/** A shallow clone of a large skills repository takes tens of seconds; the
 *  ceiling has to leave room for a slow network without holding a request
 *  forever. */
const GIT_CHECKOUT_TIMEOUT_MS = 180_000;
/** The metadata clone carries no blobs, so a healthy one finishes in seconds
 *  even on a slow link. Waiting the whole checkout ceiling for a connection
 *  that never opened is what makes a bad network look like a hung import. */
const GIT_CLONE_TIMEOUT_MS = 60_000;
/** A connection that stops moving is a dead one, not a slow one: abandon it
 *  after half a minute below 1 KiB/s instead of holding the request until the
 *  whole-command ceiling. What a stalled transfer costs is the retry below. */
const GIT_TRANSPORT_CONFIG = [
  "-c", "http.lowSpeedLimit=1000",
  "-c", "http.lowSpeedTime=30",
];
/** How long the checkout an inspection just made stays on disk for the imports
 *  that follow it. */
const GIT_CHECKOUT_RETENTION_MS = 15 * 60_000;

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
  readPackageFiles: () => SkillPackageFileBytes[];
  metadata: Record<string, unknown>;
  readResource: (path: string) => SkillResourceContent;
  resources: SkillResource[];
  revision: number;
  version: string;
}

export interface PreparedSkillReviewDraft {
  detail: SkillDetail;
  files: ReadonlyMap<string, Buffer>;
  provenance: SkillVersionProvenance;
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
  // Only executions with an observed outcome describe a reproducible step. An
  // execution whose status observation was lost (`unconfirmed`) is neither a
  // success nor a failure, and a reconciliation that later settles it replaces
  // the observation with the real outcome.
  const runs = settledExecutionRuns(input.runs);
  if (input.messages.length < 2 && runs.length === 0) {
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
  const languages = [...new Set(runs.map((run) => run.language).filter(Boolean))];
  const outputPaths = [...new Set(runs.flatMap((run) => [...run.createdFiles, ...run.modifiedFiles]))].slice(0, 20);
  const runSteps = runs.slice(-12).map((run, index) => (
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

function normalizeGitCommit(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const commit = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    throw validationError("Git commit must be the exact commit returned by repository inspection");
  }
  return commit;
}

/** The `nextCursor` an inspection returned: the subdirectory the next page
 *  starts after. `.` is a legitimate package root and means the checkout
 *  itself, so it is kept rather than rejected as an empty path segment. */
function normalizeGitCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cursor = value.trim();
  if (!cursor) throw validationError("Git inspection cursor must not be empty");
  return cursor === "." ? "." : normalizedPackagePath(cursor);
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
    if (depth > GIT_SKILL_DISCOVERY_DEPTH) return;
    const entries = await readdir(directory, { withFileTypes: true });
    const skillMarkdown = entries.find((entry) => entry.name === "SKILL.md");
    if (skillMarkdown?.isFile() && !skillMarkdown.isSymbolicLink()) {
      const subdirectory = relative(checkout, directory).split("\\").join("/") || ".";
      roots.push(subdirectory);
      return;
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
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

/** A shallow checkout of one Git repository, used by inspection, review and
 *  import alike. Injectable so the import branches can be tested without a
 *  network: the real transport refuses `file://` repositories on purpose. */
export type GitSkillCheckout = (
  importRoot: string,
  input: InspectGitSkillRepositoryRequest,
) => Promise<{
  checkout: string;
  commit: string;
  normalized: ReturnType<typeof validateGitSkillImportRequest>;
  /** Only `SKILL.md` files were checked out; a package's resources are fetched
   *  by `expandGitSparseCheckout` when something needs to read them. */
  partial?: boolean;
}>;

type NormalizedGitImport = ReturnType<typeof validateGitSkillImportRequest>;

/** Two requests belong to the same clone when they ask for the same repository
 *  at the same ref; the subdirectory only chooses what to read out of it. */
function gitCheckoutKey(normalized: NormalizedGitImport): string {
  return `${normalized.repositoryUrl}\u0000${normalized.ref ?? ""}`;
}

/** The checkout a Git request reads from: the one this call just made, or the
 *  one an inspection left behind at the commit the request names. A request
 *  that names no commit is answered by a fresh clone, so the fallback commit
 *  is always there when the retained checkout is. */
function checkoutSource(
  fetched: { checkout: string; commit: string; partial?: boolean } | undefined,
  reused: { checkout: string; partial: boolean } | undefined,
  commit: string | undefined,
): { checkout: string; commit: string; partial: boolean } {
  if (fetched !== undefined) {
    return { checkout: fetched.checkout, commit: fetched.commit, partial: fetched.partial === true };
  }
  if (reused === undefined || commit === undefined) {
    throw validationError("The Git inspection expired or was replaced; inspect the repository again");
  }
  return { checkout: reused.checkout, commit, partial: reused.partial };
}

/** Every `SKILL.md` at any depth. Discovery only needs these files, and a
 *  repository whose packages carry hundreds of megabytes of data is scanned
 *  in seconds when the data stays on the server. */
const GIT_SPARSE_SKILL_MARKDOWN = "**/SKILL.md";

async function runGit(arguments_: string[], timeout = GIT_CHECKOUT_TIMEOUT_MS): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync("git", arguments_, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 1024 * 1024,
    timeout,
  });
  return { stdout };
}

/** A `git` command that changes nothing a second run would find strange —
 *  setting the sparse patterns, checking out the files they name — is run once
 *  more when the transfer behind it broke. The user asked for the package;
 *  a connection that dropped mid-fetch is not their answer. */
async function runGitRetry(arguments_: string[], timeout = GIT_CHECKOUT_TIMEOUT_MS): Promise<{ stdout: string }> {
  try {
    return await runGit(arguments_, timeout);
  } catch (error) {
    if (!gitTransportFailure(error)) throw error;
    return await runGit(arguments_, timeout);
  }
}

/** The clone command itself, attempted twice when the first connection broke
 *  or never opened. Only this step is retried on a timeout: a checkout that
 *  ran out of time has files to show for it, and starting the download over
 *  would spend the ceiling twice. */
async function cloneRepository(
  arguments_: string[],
  checkout: string,
  timeout: number,
  retryTimeout: boolean,
): Promise<void> {
  const attempt = () => runGit(arguments_, timeout);
  try {
    await attempt();
  } catch (error) {
    await rm(checkout, { force: true, recursive: true });
    if (!gitTransportFailure(error) && !(retryTimeout && gitTimedOut(error))) throw error;
    await attempt();
  }
}

async function cloneGitRepository(
  normalized: NormalizedGitImport,
  checkout: string,
  partial: boolean,
  timeout = GIT_CLONE_TIMEOUT_MS,
): Promise<void> {
  const branch = normalized.ref ? ["--branch", normalized.ref] : [];
  if (!partial) {
    // The fallback is for a server that refuses the filter, so it asks for
    // none: the whole working tree arrives, which is slower but is what a
    // repository without partial-clone support can answer.
    await cloneRepository([
      "-c", "protocol.file.allow=never", ...GIT_TRANSPORT_CONFIG,
      "clone", "--depth=1", "--no-tags", ...branch,
      "--", normalized.repositoryUrl, checkout,
    ], checkout, GIT_CHECKOUT_TIMEOUT_MS, false);
    return;
  }
  await cloneRepository([
    "-c", "protocol.file.allow=never", ...GIT_TRANSPORT_CONFIG,
    "clone", "--depth=1", "--filter=blob:none", "--no-checkout", "--no-tags", "--single-branch",
    ...branch, "--", normalized.repositoryUrl, checkout,
  ], checkout, timeout, true);
  await runGit(["-C", checkout, "sparse-checkout", "set", "--no-cone", GIT_SPARSE_SKILL_MARKDOWN]);
  await runGitRetry(["-C", checkout, ...GIT_TRANSPORT_CONFIG, "checkout"]);
}

function gitErrorText(error: unknown): string {
  const value = error as { message?: unknown; stderr?: unknown } | undefined;
  return [value?.stderr, value?.message]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

function gitTimedOut(error: unknown): boolean {
  return (error as { killed?: boolean } | undefined)?.killed === true;
}

/** A transfer that broke or stopped moving. The repository is not at fault and
 *  the same clone can be attempted again. A command that used its whole
 *  ceiling is not this kind of failure: it is handled where the ceiling that
 *  applies to it is known. */
function gitTransportFailure(error: unknown): boolean {
  if (gitTimedOut(error)) return false;
  return /early eof|rpc failed|connection reset|operation too slow|the remote end hung up|could not read from remote|gnutls|ssl/i
    .test(gitErrorText(error));
}

/** Only a server that refuses the filter justifies a full download; a broken
 *  transfer that happens to mention the filter is still a transport problem. */
function gitFilterRefused(error: unknown): boolean {
  if (gitTransportFailure(error)) return false;
  return /filtering not recognized|filter[^\n]*(?:not supported|unsupported)|does not support (?:the )?filter/i
    .test(gitErrorText(error));
}

/** Fetch the files under `roots` that a partial checkout left on the server.
 *  The caller only passes a checkout the transport marked partial, so these
 *  files really are missing; a failed fetch is an error, not an empty package. */
async function expandGitSparseCheckout(checkout: string, roots: readonly string[]): Promise<void> {
  const { stdout } = await runGit(["-C", checkout, "sparse-checkout", "list"], 30_000);
  const current = stdout.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("-"));
  const wanted = roots.map((root) => (root === "." ? "/*" : `/${root}`));
  const missing = wanted.filter((pattern) => !current.includes(pattern));
  if (!missing.length) return;
  await runGit(["-C", checkout, "sparse-checkout", "set", "--no-cone", ...current, ...missing]);
  await runGitRetry(["-C", checkout, ...GIT_TRANSPORT_CONFIG, "checkout"]);
}

export async function checkoutGitSkillRepository(
  importRoot: string,
  input: InspectGitSkillRepositoryRequest,
  options: { cloneTimeoutMs?: number } = {},
): Promise<{
  checkout: string;
  commit: string;
  normalized: ReturnType<typeof validateGitSkillImportRequest>;
  partial: boolean;
}> {
  const normalized = validateGitSkillImportRequest(input);
  const checkout = resolve(importRoot, randomUUID());
  await mkdir(importRoot, { recursive: true });
  try {
    let partial = true;
    try {
      await cloneGitRepository(normalized, checkout, true, options.cloneTimeoutMs ?? GIT_CLONE_TIMEOUT_MS);
    } catch (error) {
      await rm(checkout, { force: true, recursive: true });
      // Only a server that refuses the filter is worth a full download. Any
      // other failure has already been retried as the same clone, because
      // falling back here is what turns a broken transfer into hundreds of
      // megabytes the user waits for.
      if (!gitFilterRefused(error)) throw error;
      partial = false;
      await cloneGitRepository(normalized, checkout, false);
    }
    const { stdout } = await runGit(["-C", checkout, "rev-parse", "HEAD"], 10_000);
    return { checkout, commit: stdout.trim().toLowerCase(), normalized, partial };
  } catch (error) {
    await rm(checkout, { force: true, recursive: true });
    // A clone that is cut off at the timeout is the one failure a user cannot
    // tell apart from a broken URL, so it names the way out.
    throw validationError(gitTimedOut(error)
      ? "Git skill checkout timed out; retry, or narrow the import with a Ref or subdirectory"
      : gitTransportFailure(error)
        ? "Git skill checkout lost its connection to the repository; retry the import"
        : "Git skill checkout failed; verify the repository, ref, and locally configured credentials");
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

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, "metadata");
  const metadata: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (item === undefined || item === null) continue;
    metadata[key] = item;
  }
  return metadata;
}

export interface ParsedSkillMarkdown {
  frontmatter: Record<string, unknown>;
  instructions: string;
}

export function parseSkillMarkdown(bytes: Buffer): ParsedSkillMarkdown {
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

export function hashSkillPackageFiles(files: ReadonlyMap<string, Uint8Array>): string {
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
    allowLegacyDescription?: boolean;
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
  // A path cannot be both a file and a folder. The writer would have to mkdir
  // a path that a file now occupies (or the reverse) after the revision was
  // committed, and that surfaces as a raw EEXIST rather than a package error.
  for (const path of files.keys()) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const ancestor = segments.slice(0, depth).join("/");
      if (files.has(ancestor)) {
        throw validationError(`Skill package path is both a file and a folder: ${ancestor}`);
      }
    }
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
  const description = typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : "";
  if (!options.allowLegacyDescription && !description.trim()) {
    throw validationError("description must be a non-empty string");
  }
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
  const rawVersion = metadata?.version;
  const declaredVersion = typeof rawVersion === "string" ? rawVersion.trim() || undefined : undefined;
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
      hash: hashSkillPackageFiles(files),
      id: name,
      instructions: parsed.instructions,
      ...(metadata ? { metadata } : {}),
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

/** A script that declares its own interpreter (`#!`) is meant to be run
 *  directly. The catalog stores bytes, not Unix modes, so the shebang is the
 *  one piece of the source package's executable intent that survives; without
 *  it an imported `scripts/run.py` would be refused with "permission denied"
 *  where the repository's copy runs. */
function isExecutableScript(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21;
}

async function writePackageDirectory(root: string, files: ReadonlyMap<string, Buffer>): Promise<void> {
  for (const [path, bytes] of files) {
    const normalized = normalizedPackagePath(path);
    const target = resolve(root, ...normalized.split("/"));
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
    if (isExecutableScript(bytes)) await chmod(target, 0o755);
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

/** The same package under another name: the SKILL.md `name` line is the only
 *  place the identity is stored, so rewriting that line re-validates the whole
 *  package under the new directory the catalog will write it to. */
function renameSkillPackage(loaded: LoadedPackage, name: string): LoadedPackage {
  const markdown = loaded.files.get("SKILL.md");
  if (!markdown) throw validationError("Skill package must contain SKILL.md at its root");
  const text = markdown.toString("utf8");
  const close = text.indexOf("\n---", 3);
  if (close === -1) throw validationError("SKILL.md frontmatter is invalid");
  const block = text.slice(0, close);
  const renamed = block.replace(/^name\s*:.*$/m, `name: ${name}`);
  if (renamed === block) throw validationError("SKILL.md name is missing");
  const files = new Map(loaded.files);
  files.set("SKILL.md", Buffer.from(renamed + text.slice(close), "utf8"));
  return validateSkillPackage(files, { revision: loaded.detail.currentRevision });
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

function packageFileBytes(files: ReadonlyMap<string, Buffer>): SkillPackageFileBytes[] {
  return [...files]
    .map(([path, bytes]) => ({
      bytes: Buffer.from(bytes),
      hash: sha256(bytes),
      path,
      size: bytes.length,
    }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

export class SkillCatalog {
  private builtIns = new Map<string, LoadedPackage>();
  private index: CatalogIndex = { managed: {}, schemaVersion: 1 };
  private loaded = false;
  private managed = new Map<string, ManagedPackage>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private reviewDrafts = new Map<string, StoredSkillReviewDraft>();
  private readonly checkoutGit: GitSkillCheckout;
  private readonly repositoryRoot: string;
  private readonly root: string;
  /**
   * The checkout the last inspection made, kept for the imports that follow.
   *
   * Importing one package per request means the client asks the server N times
   * for the same repository; cloning it N times made importing a repository of
   * a hundred skills take most of an hour. The clone is the expensive half of
   * every request, so inspection leaves its checkout behind for a short while
   * and an import pinned to that same commit reads from it.
   */
  private retainedGitCheckout?: {
    checkout: string;
    commit: string;
    expiresAt: number;
    key: string;
    normalized: NormalizedGitImport;
    partial: boolean;
  };

  /** Expansions rewrite one shared sparse-pattern list, so they run one at a
   *  time; two imports reading the same checkout must not lose each other's
   *  paths, which would install a package without its resources. */
  private sparseCheckoutQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string, repositoryRoot: string, options: { checkoutGit?: GitSkillCheckout } = {}) {
    this.root = resolve(dataDir, "skills");
    this.repositoryRoot = resolve(repositoryRoot);
    this.checkoutGit = options.checkoutGit ?? checkoutGitSkillRepository;
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
    const loaded = validateSkillPackage(files, { allowLegacyDescription: true, directoryName: id, revision });
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
      if (entry.name === "catalog.json" || entry.name === ".drafts" || entry.name === ".imports" || entry.name === ".staging") continue;
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
    // Inspections keep a checkout for the imports that follow them. A process
    // that exited since then cannot use it, so a restart starts clean rather
    // than accumulating partial clones under the data directory.
    await rm(resolve(this.root, ".imports"), { force: true, recursive: true });
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
        files: draft.files.map((file) => this.publicReviewFile(file, true)).toSorted(compareSkillPaths),
        skillId: id,
      };
    }
    const proposal = draft.proposalHistory?.find((candidate) => `proposal:${candidate.proposalId}` === versionId);
    if (!proposal) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill version not found: ${id}@${versionId}`);
    return {
      ...summary,
      files: proposal.files.map((file) => this.publicReviewFile(file, true)).toSorted(compareSkillPaths),
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
      // Ties are common: drafts written in quick succession share a millisecond,
      // and every draft's own proposal carries a freshly generated id, so a
      // tie broken by proposalId would order the merged history at random. The
      // sort is stable, so an equal timestamp keeps the order the caller listed
      // the drafts in, which is the only ordering the caller can predict.
      ]).toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
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
      const { draft, loaded, provenance: confirmedProvenance } = this.prepareReviewDraftConfirmation(draftId, input);
      this.assertDraftInstallable(loaded, draft.baseRevision);
      const committed = await this.installReviewedDraft(loaded, confirmedProvenance);
      await rm(this.reviewDraftPath(draftId), { force: true });
      this.reviewDrafts.delete(draftId);
      return structuredClone(committed.detail);
    });
  }

  /** Refuse a draft that would install over an existing Skill, before anything
   *  is written: a publisher that has already committed must not be left with a
   *  version whose reviewed package was rejected here. */
  private assertDraftInstallable(loaded: LoadedPackage, baseRevision: number | undefined): void {
    if (baseRevision === undefined && (this.builtIns.has(loaded.detail.id) || this.managed.has(loaded.detail.id))) {
      throw new SkillCatalogError("SKILL_CONFLICT", `Skill already exists: ${loaded.detail.id}`);
    }
  }

  /**
   * Install reviewed bytes into the managed Skill catalog: the revision
   * directory, the index entry and the in-memory package.
   *
   * Both confirmation paths end here. A Library publication keeps an archive of
   * what was confirmed, but the catalog is what the Skills page lists and what a
   * Session selects from, so a draft that only reached a Library would be
   * invisible to the user who had just confirmed it.
   */
  private async installReviewedDraft(
    loaded: LoadedPackage,
    provenance: SkillVersionProvenance,
  ): Promise<LoadedPackage> {
    const revision = loaded.detail.currentRevision;
    const committed = await this.commitManaged(loaded, revision, new Date().toISOString(), provenance);
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
    return committed;
  }

  /**
   * Keep an Agent package inactive while it is reviewed, then hand the exact
   * reviewed bytes to an external publisher. The draft is removed only after
   * that publisher succeeds.
   */
  async publishReviewDraft<T>(
    draftId: string,
    input: ConfirmSkillReviewDraftRequest,
    publish: (prepared: PreparedSkillReviewDraft) => Promise<T>,
  ): Promise<T> {
    return await this.mutate(async () => {
      this.assertLoaded();
      const { draft, files, loaded, provenance } = this.prepareReviewDraftConfirmation(draftId, input);
      // Checked before the publisher runs, so a rejected install cannot leave a
      // committed Library version behind.
      this.assertDraftInstallable(loaded, draft.baseRevision);
      const result = await publish({
        detail: structuredClone(loaded.detail),
        files: new Map([...files].map(([path, bytes]) => [path, Buffer.from(bytes)])),
        provenance: structuredClone(provenance),
      });
      // The Library holds the archive; the user confirmed a Skill, so it has to
      // exist where the Skills page and a Session look for it. Installed after
      // the publisher succeeds, so a Library failure leaves the draft intact.
      await this.installReviewedDraft(loaded, provenance);
      await rm(this.reviewDraftPath(draft.draftId), { force: true });
      this.reviewDrafts.delete(draft.draftId);
      return result;
    });
  }

  private prepareReviewDraftConfirmation(draftId: string, input: ConfirmSkillReviewDraftRequest): {
    draft: StoredSkillReviewDraft;
    files: Map<string, Buffer>;
    loaded: LoadedPackage;
    provenance: SkillVersionProvenance;
  } {
    const draft = this.reviewDrafts.get(draftId);
    if (!draft) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill review draft not found: ${draftId}`);
    if (input.expectedUpdatedAt !== draft.updatedAt) {
      throw new SkillCatalogError("SKILL_CONFLICT", "Skill review draft changed; reload it before confirming");
    }
    let provenance = draft.provenance ?? { source: "agent" as const };
    if (input.sourceVersionId && input.sourceVersionId !== `draft:${draft.draftId}`) {
      const selectedProposal = draft.proposalHistory?.find(
        (candidate) => `proposal:${candidate.proposalId}` === input.sourceVersionId,
      );
      if (!selectedProposal) {
        throw validationError(`Skill proposal does not belong to this draft: ${input.sourceVersionId}`);
      }
      provenance = selectedProposal.provenance ?? provenance;
    }
    const files = new Map<string, Buffer>();
    for (const file of input.files) {
      if (files.has(file.path)) throw validationError(`Duplicate skill package path: ${file.path}`);
      files.set(file.path, this.storedReviewFileBytes(file));
    }
    const current = this.managed.get(draft.name);
    if (draft.baseRevision !== undefined && (!current || current.detail.currentRevision !== draft.baseRevision)) {
      throw new SkillCatalogError("SKILL_CONFLICT", `Skill ${draft.name} changed after this draft was created`);
    }
    const revision = draft.baseRevision === undefined ? 1 : draft.baseRevision + 1;
    const loaded = validateSkillPackage(files, {
      ...(draft.baseRevision !== undefined ? { directoryName: draft.name } : {}),
      revision,
    });
    return { draft, files, loaded, provenance };
  }

  private runtimeSnapshot(value: LoadedPackage): RuntimeSkillSnapshot {
    const detail = structuredClone(value.detail);
    const files = cloneFiles(value.files);
    return {
      content: detail.instructions,
      description: detail.description,
      hash: detail.hash,
      id: detail.id,
      metadata: structuredClone(detail.metadata ?? {}),
      readPackageFiles: () => packageFileBytes(files),
      readResource: (path: string) => resourceContent(detail, files, path),
      resources: structuredClone(detail.resources),
      revision: detail.currentRevision,
      version: detail.version,
    };
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

  /** The next free name for an import whose own name is taken: `name-2`,
   *  `name-3`, … The suffix must still fit the 64-character rule and the
   *  result must not end in a hyphen after truncation. */
  private availableSkillName(base: string): string {
    const taken = (candidate: string) =>
      this.builtIns.has(candidate) || this.managed.has(candidate);
    if (!taken(base)) return base;
    for (let index = 2; index < 10_000; index += 1) {
      const suffix = `-${index}`;
      const stem = base.slice(0, Math.max(1, 64 - suffix.length)).replace(/-+$/, "") || "skill";
      const candidate = `${stem}${suffix}`;
      if (!taken(candidate)) return candidate;
    }
    throw new SkillCatalogError("SKILL_CONFLICT", `No available name for imported Skill: ${base}`);
  }

  async import(
    filename: string,
    bytes: Buffer,
    options: { onDuplicate?: "reject" | "rename" } = {},
  ): Promise<SkillDetail> {
    return await this.mutate(async () => {
      this.assertLoaded();
      // A second package with the same name is not a mistake to refuse: the
      // reader chose a file, and the catalog can hold both. The import gets
      // the next free name rather than making the reader rename the source.
      const uploaded = packageFromUpload(filename, bytes);
      const taken = this.builtIns.has(uploaded.detail.id) || this.managed.has(uploaded.detail.id);
      if (taken && options.onDuplicate !== "rename") {
        throw new SkillCatalogError("SKILL_CONFLICT", `Skill already exists: ${uploaded.detail.id}`);
      }
      const loaded = taken
        ? renameSkillPackage(uploaded, this.availableSkillName(uploaded.detail.id))
        : uploaded;
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

  /** One page of discovery. Discovery walks every `SKILL.md` in the checkout
   *  (cheap: a partial checkout holds nothing else), then the page's files are
   *  read and validated. `total` is the repository's count, not the page's. */
  private async inspectGitCheckout(
    checkout: string,
    subdirectory: string | undefined,
    partial: boolean,
    cursor?: string,
  ): Promise<{
    entries: Array<{ candidate: GitSkillImportCandidate; loaded?: LoadedPackage }>;
    nextCursor?: string;
    total: number;
  }> {
    const roots = await discoverGitSkillRoots(checkout, subdirectory);
    const start = cursor === undefined ? 0 : roots.findIndex((root) => root > cursor);
    const from = start === -1 ? roots.length : start;
    const page = roots.slice(from, from + GIT_SKILL_INSPECTION_PAGE_SIZE);
    const entries = await this.inspectGitRoots(checkout, page, partial);
    const last = page.at(-1);
    return {
      entries,
      ...(last !== undefined && from + page.length < roots.length ? { nextCursor: last } : {}),
      total: roots.length,
    };
  }

  private async inspectGitRoots(
    checkout: string,
    roots: readonly string[],
    partial: boolean,
  ): Promise<Array<{ candidate: GitSkillImportCandidate; loaded?: LoadedPackage }>> {
    const results: Array<{ candidate: GitSkillImportCandidate; loaded?: LoadedPackage }> = [];
    for (const root of roots) {
      try {
        const packageRoot = root === "." ? checkout : resolve(checkout, ...root.split("/"));
        let files = await readPackageDirectory(packageRoot, packageRoot, "", true);
        let loaded = validateSkillPackage(files);
        const builtIn = this.builtIns.get(loaded.detail.id);
        const current = this.managed.get(loaded.detail.id);
        // A partial checkout holds the SKILL.md files only: enough to name a
        // package and describe it, not enough to answer "unchanged or update".
        // That question belongs to the few packages that are already installed,
        // so those are the only ones whose resources are fetched here.
        let complete = !partial;
        if (partial && !builtIn && current) {
          await this.expandCheckout(checkout, [root]);
          files = await readPackageDirectory(packageRoot, packageRoot, "", true);
          loaded = validateSkillPackage(files);
          complete = true;
        }
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
            ...(complete ? { packageHash: loaded.detail.hash } : {}),
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

  private async expandCheckout(checkout: string, roots: readonly string[]): Promise<void> {
    const run = this.sparseCheckoutQueue.then(
      () => expandGitSparseCheckout(checkout, roots),
      () => expandGitSparseCheckout(checkout, roots),
    );
    this.sparseCheckoutQueue = run.catch(() => undefined);
    await run;
  }

  /** A checkout an inspection left behind, when this request is about the same
   *  repository at the commit that inspection saw. Anything else is a clone. */
  private retainedCheckoutFor(
    normalized: NormalizedGitImport,
    commit?: string,
  ): { checkout: string; partial: boolean } | undefined {
    const retained = this.retainedGitCheckout;
    if (!retained) return undefined;
    if (retained.expiresAt < Date.now()) {
      // The retention window is only a hint about reuse; a stale checkout is
      // dropped the next time one is made or asked for.
      this.retainedGitCheckout = undefined;
      void rm(retained.checkout, { force: true, recursive: true }).catch(() => undefined);
      return undefined;
    }
    if (retained.key !== gitCheckoutKey(normalized)) return undefined;
    // An import without a commit means "whatever the ref points at now", which
    // a remembered checkout cannot answer.
    if (commit === undefined || commit !== retained.commit) return undefined;
    return { checkout: retained.checkout, partial: retained.partial };
  }

  /** Keep this checkout for the imports that follow, replacing the last one. */
  private async retainCheckout(
    checkout: string,
    commit: string,
    normalized: NormalizedGitImport,
    partial: boolean,
  ): Promise<void> {
    const previous = this.retainedGitCheckout;
    this.retainedGitCheckout = {
      checkout,
      commit,
      expiresAt: Date.now() + GIT_CHECKOUT_RETENTION_MS,
      key: gitCheckoutKey(normalized),
      normalized,
      partial,
    };
    if (previous && previous.checkout !== checkout) {
      await rm(previous.checkout, { force: true, recursive: true }).catch(() => undefined);
    }
  }

  async inspectGitRepository(input: InspectGitSkillRepositoryRequest): Promise<GitSkillRepositoryInspection> {
    this.assertLoaded();
    const importRoot = resolve(this.root, ".imports");
    const normalized = validateGitSkillImportRequest(input);
    const requestedCommit = normalizeGitCommit(input.commit);
    const cursor = normalizeGitCursor(input.cursor);
    if (cursor !== undefined && requestedCommit === undefined) {
      throw validationError("A Git inspection cursor requires the commit the inspection returned");
    }
    // A page after the first reads the checkout the first page made: same
    // tree, same commit, no second clone.
    const reused = this.retainedCheckoutFor(normalized, requestedCommit);
    if (requestedCommit !== undefined && reused === undefined) {
      throw validationError("The Git inspection expired or was replaced; inspect the repository again");
    }
    const fetched = reused === undefined ? await this.checkoutGit(importRoot, input) : undefined;
    const { checkout, commit, partial } = checkoutSource(fetched, reused, requestedCommit);
    let retained = reused !== undefined;
    try {
      const inspected = await this.inspectGitCheckout(checkout, normalized.subdirectory, partial, cursor);
      // Reading another page is using the checkout, so the window restarts:
      // a long list should not expire halfway through.
      await this.retainCheckout(checkout, commit, normalized, partial);
      retained = true;
      return {
        candidates: inspected.entries.map(({ candidate }) => candidate),
        commit,
        ...(inspected.nextCursor !== undefined ? { nextCursor: inspected.nextCursor } : {}),
        ...(normalized.ref ? { ref: normalized.ref } : {}),
        repositoryUrl: normalized.repositoryUrl,
        total: inspected.total,
      };
    } finally {
      if (!retained) await rm(checkout, { force: true, recursive: true });
    }
  }

  async createGitReviewDrafts(
    input: CreateGitSkillReviewDraftsRequest,
  ): Promise<CreateGitSkillReviewDraftsResponse> {
    this.assertLoaded();
    const expectedCommit = normalizeGitCommit(input.commit);
    if (expectedCommit === undefined) {
      throw validationError("Git commit must be the exact commit returned by repository inspection");
    }
    const subdirectories = [...new Set(input.subdirectories?.map((path) => {
      const trimmed = path?.trim();
      return trimmed === "." ? "." : normalizedPackagePath(trimmed);
    }) ?? [])];
    if (!subdirectories.length || subdirectories.length > GIT_SKILL_SELECTION_LIMIT) {
      throw validationError(`Select between 1 and ${GIT_SKILL_SELECTION_LIMIT} Git Skill packages`);
    }
    const importRoot = resolve(this.root, ".imports");
    const requested = validateGitSkillImportRequest(input);
    const reused = this.retainedCheckoutFor(requested, expectedCommit);
    const fetched = reused === undefined ? await this.checkoutGit(importRoot, input) : undefined;
    const { checkout, commit, partial } = checkoutSource(fetched, reused, expectedCommit);
    const normalized = requested;
    try {
      if (commit !== expectedCommit) {
        throw new SkillCatalogError(
          "SKILL_CONFLICT",
          `Git ref moved after inspection (expected ${expectedCommit.slice(0, 12)}, found ${commit.slice(0, 12)}); scan again before importing`,
        );
      }
      // The scan kept only SKILL.md files; the packages being reviewed need
      // their resources before they can be read as packages.
      if (partial) await this.expandCheckout(checkout, subdirectories);
      // The request names its packages, so read those rather than paging
      // through a discovery that may hold thousands of them.
      const inspected = await this.inspectGitRoots(checkout, subdirectories, partial);
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
      if (reused === undefined) await rm(checkout, { force: true, recursive: true });
    }
  }

  /** Warm one checkout for every package a background import will read.
   *
   *  The inspection leaves a metadata-only checkout holding only SKILL.md
   *  files. Fetching a package's resources creates a sparse pattern and a checkout; a
   *  background batch that did that 175 times would spend most of its time
   *  asking Git the same questions. One expansion over every selected root
   *  fetches all of them in one operation, and each per-package import then
   *  finds its files already on disk. */
  async prepareGitImport(input: StartGitSkillImportJobRequest): Promise<{ commit: string }> {
    this.assertLoaded();
    const normalized = validateGitSkillImportRequest(input);
    const requestedCommit = normalizeGitCommit(input.commit);
    if (requestedCommit === undefined) {
      throw validationError("Importing a Git selection requires the commit returned by inspection");
    }
    const roots = [...new Set((input.items ?? []).map((item) => {
      const trimmed = item?.subdirectory?.trim();
      return !trimmed || trimmed === "." ? "." : normalizedPackagePath(trimmed);
    }))];
    if (!roots.length || roots.length > GIT_SKILL_SELECTION_LIMIT) {
      throw validationError(`Select between 1 and ${GIT_SKILL_SELECTION_LIMIT} Git Skill packages`);
    }
    const reused = this.retainedCheckoutFor(normalized, requestedCommit);
    if (reused === undefined) {
      throw new SkillCatalogError(
        "SKILL_CONFLICT",
        "The Git inspection expired or was replaced; inspect the repository again",
      );
    }
    const { checkout, commit, partial } = checkoutSource(undefined, reused, requestedCommit);
    if (commit !== requestedCommit) {
      throw new SkillCatalogError(
        "SKILL_CONFLICT",
        `Git ref moved after inspection (expected ${requestedCommit.slice(0, 12)}, found ${commit.slice(0, 12)}); scan again before importing`,
      );
    }
    if (partial) await this.expandCheckout(checkout, roots);
    await this.retainCheckout(checkout, commit, normalized, partial);
    return { commit };
  }

  async importFromGit(input: ImportSkillFromGitRequest): Promise<SkillDetail> {
    this.assertLoaded();
    // Discovery names a package at the checkout root ".". The path validator
    // refuses every "." segment, so the root form is re-expressed as "no
    // subdirectory" before it is validated.
    const normalized = validateGitSkillImportRequest(
      input.subdirectory?.trim() === "." ? { ...input, subdirectory: undefined } : input,
    );
    const requestedCommit = normalizeGitCommit(input.commit);
    if (input.overwrite !== undefined && typeof input.overwrite !== "boolean") {
      throw validationError("overwrite must be a boolean");
    }
    if (input.overwrite && input.expectedRevision === undefined) {
      throw validationError("Overwriting an installed Skill requires expectedRevision");
    }
    if (input.expectedRevision !== undefined && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)) {
      throw validationError("expectedRevision must be a positive integer");
    }
    const importRoot = resolve(this.root, ".imports");
    const reused = this.retainedCheckoutFor(normalized, requestedCommit);
    const fetched = reused === undefined ? await this.checkoutGit(importRoot, normalized) : undefined;
    const { checkout, commit, partial } = checkoutSource(fetched, reused, requestedCommit);
    const checked = normalized;
    try {
      if (requestedCommit && requestedCommit !== commit) {
        throw new SkillCatalogError(
          "SKILL_CONFLICT",
          `Git ref moved after inspection (expected ${requestedCommit.slice(0, 12)}, found ${commit.slice(0, 12)}); scan again before importing`,
        );
      }
      // A partial checkout left this package's resources on the server.
      if (partial) await this.expandCheckout(checkout, [checked.subdirectory ?? "."]);
      const packageRoot = checked.subdirectory
        ? resolve(checkout, ...checked.subdirectory.split("/"))
        : checkout;
      const rootInfo = await lstat(packageRoot).catch(() => undefined);
      if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
        throw validationError("Git skill subdirectory must resolve to a regular directory");
      }
      const files = await readPackageDirectory(packageRoot, packageRoot, "", true);
      const loaded = validateSkillPackage(files);
      return await this.mutate(async () => {
        if (this.builtIns.has(loaded.detail.id)) {
          throw new SkillCatalogError("SKILL_READ_ONLY", `Built-in skill is read-only: ${loaded.detail.id}`);
        }
        const current = this.managed.get(loaded.detail.id);
        if (current && !input.overwrite) {
          throw new SkillCatalogError("SKILL_CONFLICT", `Skill already exists: ${loaded.detail.id}`);
        }
        if (current && input.expectedRevision !== current.detail.currentRevision) {
          throw new SkillCatalogError(
            "SKILL_CONFLICT",
            `Skill revision conflict: expected ${input.expectedRevision}, current ${current.detail.currentRevision}`,
          );
        }
        // Re-importing identical bytes is a no-op rather than an empty version.
        if (current && current.detail.hash === loaded.detail.hash) {
          return structuredClone(current.detail);
        }
        const revision = current ? current.detail.currentRevision + 1 : 1;
        // `commitManaged` keeps the detail it is given, so the revision has to
        // be validated in here rather than patched onto the returned object.
        const committed = await this.commitManaged(validateSkillPackage(files, { revision }), revision, new Date().toISOString(), {
          git: {
            commit,
            ...(checked.ref ? { ref: checked.ref } : {}),
            repositoryUrl: checked.repositoryUrl,
            subdirectory: checked.subdirectory ?? ".",
          },
          source: "git",
        });
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
        return structuredClone(committed.detail);
      });
    } finally {
      if (reused === undefined) await rm(checkout, { force: true, recursive: true });
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

  /** The raw bytes of SKILL.md, frontmatter included: the file editor shows
   *  the document it is about to write back. */
  readSkillMarkdown(id: string): SkillMarkdownContent {
    this.assertLoaded();
    const value = this.builtIns.get(id) ?? this.managed.get(id);
    if (!value) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill not found: ${id}`);
    const bytes = value.files.get("SKILL.md");
    if (!bytes) throw new SkillCatalogError("SKILL_NOT_FOUND", `SKILL.md is missing: ${id}`);
    return { content: bytes.toString("utf8"), revision: value.detail.currentRevision, skillId: id };
  }

  /** Replace SKILL.md with the text the editor showed. The package is
   *  validated after the write, so a bad frontmatter or a renamed identity is
   *  refused instead of committed. */
  async updateSkillMarkdown(id: string, input: UpdateSkillMarkdownRequest): Promise<SkillDetail> {
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
      files.set("SKILL.md", Buffer.from(input.content, "utf8"));
      const loaded = validateSkillPackage(files, { directoryName: id, revision });
      const committed = await this.commitManaged(loaded, revision, new Date().toISOString(), {
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

  /** Remove one resource, or every resource under a folder path. SKILL.md is
   *  the package's identity and is never removed here; deleting the Skill is
   *  the catalog's own operation. */
  async deleteFile(id: string, rawPath: string, input: DeleteSkillFileRequest): Promise<SkillDetail> {
    return await this.mutate(async () => {
      this.assertLoaded();
      if (this.builtIns.has(id)) throw new SkillCatalogError("SKILL_READ_ONLY", `Built-in skill is read-only: ${id}`);
      const current = this.managed.get(id);
      if (!current) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill not found: ${id}`);
      if (input.expectedRevision !== current.detail.currentRevision) {
        throw new SkillCatalogError("SKILL_CONFLICT", `Skill revision conflict: expected ${input.expectedRevision}, current ${current.detail.currentRevision}`);
      }
      const path = normalizedPackagePath(rawPath);
      if (path === "SKILL.md") throw validationError("SKILL.md cannot be deleted");
      const targets = [...current.files.keys()].filter((candidate) => candidate === path || candidate.startsWith(`${path}/`));
      if (targets.length === 0) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill file not found: ${path}`);
      const revision = current.detail.currentRevision + 1;
      const files = cloneFiles(current.files);
      for (const target of targets) files.delete(target);
      const loaded = validateSkillPackage(files, { directoryName: id, revision });
      const committed = await this.commitManaged(loaded, revision, new Date().toISOString(), {
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

  /** Move a file, or a folder and everything under it, to a new path. */
  async renameFile(id: string, rawFrom: string, input: RenameSkillFileRequest): Promise<SkillDetail> {
    return await this.mutate(async () => {
      this.assertLoaded();
      if (this.builtIns.has(id)) throw new SkillCatalogError("SKILL_READ_ONLY", `Built-in skill is read-only: ${id}`);
      const current = this.managed.get(id);
      if (!current) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill not found: ${id}`);
      if (input.expectedRevision !== current.detail.currentRevision) {
        throw new SkillCatalogError("SKILL_CONFLICT", `Skill revision conflict: expected ${input.expectedRevision}, current ${current.detail.currentRevision}`);
      }
      const from = normalizedPackagePath(rawFrom);
      const to = normalizedPackagePath(input.to);
      if (from === "SKILL.md" || to === "SKILL.md" || to.startsWith("SKILL.md/")) {
        throw validationError("SKILL.md keeps its name");
      }
      if (to === from || to.startsWith(`${from}/`)) {
        throw validationError(`A file cannot be moved into itself: ${from} -> ${to}`);
      }
      const moved = [...current.files.keys()].filter((candidate) => candidate === from || candidate.startsWith(`${from}/`));
      if (moved.length === 0) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill file not found: ${from}`);
      const renamed = new Map(moved.map((candidate) => [
        candidate,
        candidate === from ? to : `${to}${candidate.slice(from.length)}`,
      ]));
      const movedSet = new Set(moved);
      for (const target of renamed.values()) {
        if (current.files.has(target) && !movedSet.has(target)) {
          throw validationError(`A file already exists at ${target}`);
        }
      }
      const revision = current.detail.currentRevision + 1;
      const files = cloneFiles(current.files);
      for (const source of moved) files.delete(source);
      for (const [source, target] of renamed) {
        files.set(target, Buffer.from(current.files.get(source)!));
      }
      const loaded = validateSkillPackage(files, { directoryName: id, revision });
      const committed = await this.commitManaged(loaded, revision, new Date().toISOString(), {
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

  /**
   * One installed package as a ZIP the importer accepts back.
   *
   * The archive keeps the shape an uploaded package has — a single root
   * directory named after the Skill, holding `SKILL.md` and its resources — so
   * what is exported can be imported again, here or on another machine,
   * without the caller rearranging anything. Built-in packages are exportable
   * too: being read-only says who may change them, not who may copy them.
   */
  exportPackage(id: string): { bytes: Buffer; filename: string } {
    this.assertLoaded();
    const value = this.builtIns.get(id) ?? this.managed.get(id);
    if (!value) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill not found: ${id}`);
    const entries: Record<string, Uint8Array> = {};
    for (const [path, content] of value.files) entries[`${id}/${path}`] = content;
    return { bytes: Buffer.from(zipSync(entries, { level: 6 })), filename: `${id}.zip` };
  }

  /** Resolve an immutable historical package and verify its frozen identity. */
  async resolveRevision(ref: {
    hash: string;
    id: string;
    revision: number;
    version: string;
  }): Promise<RuntimeSkillSnapshot> {
    this.assertLoaded();
    if (!Number.isInteger(ref.revision) || ref.revision < 1) {
      throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill revision is invalid: ${ref.id}@${ref.revision}`);
    }
    let value: LoadedPackage | undefined;
    const builtIn = this.builtIns.get(ref.id);
    if (builtIn) {
      if (ref.revision !== builtIn.detail.currentRevision) {
        throw new SkillCatalogError("SKILL_NOT_FOUND", `Built-in Skill revision not found: ${ref.id}@${ref.revision}`);
      }
      value = builtIn;
    } else {
      const currentRevision = this.index.managed[ref.id]?.currentRevision;
      if (!currentRevision || ref.revision > currentRevision) {
        throw new SkillCatalogError("SKILL_NOT_FOUND", `Managed Skill revision not found: ${ref.id}@${ref.revision}`);
      }
      value = ref.revision === currentRevision
        ? this.managed.get(ref.id)
        : await this.loadManaged(ref.id, ref.revision);
    }
    if (!value || value.detail.hash !== ref.hash || value.detail.version !== ref.version) {
      throw new SkillCatalogError(
        "SKILL_CONFLICT",
        `Frozen Skill identity does not match persisted revision: ${ref.id}@${ref.revision}`,
      );
    }
    return this.runtimeSnapshot(value);
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
        metadata: { ...detail.metadata },
        readPackageFiles: () => packageFileBytes(files),
        readResource: (path: string) => resourceContent(detail, files, path),
        resources: structuredClone(detail.resources),
        revision: detail.currentRevision,
        version: detail.version,
      };
    });
  }
}

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

import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AgentTool } from "@sciencediscovery/tools";
import type { WorkspaceTransfer, WorkspaceTransferInput } from "@sciencediscovery/schema";
import {
  SANDBOX_SKILL_EXTENSIONS_ROOT,
  SANDBOX_SKILL_PACKAGES_ROOT,
  SKILL_EXTENSIONS_WORKSPACE_PATH,
  SKILL_EXTENSIONS_ENVIRONMENT_VARIABLE,
  SKILL_PACKAGES_ENVIRONMENT_VARIABLE,
  SKILL_PACKAGES_PORTABLE_ROOT,
  skillRootAliases,
} from "@sciencediscovery/schema";
import { detectBinaryFile, guessMediaType, readTextFilePage } from "./file-page.js";
import type {
  ArtifactDownloadResult,
  ArtifactReadResult,
  ConnectorId,
  CreateSkillPackageRequest,
  CreateEnvironmentRequest,
  CreateNpuJobRequest,
  DeclareClaimInput,
  DeclareClaimResult,
  DeclareEvidenceInput,
  DeclareResult,
  Subagent,
  SubagentInput,
  Environment,
  EnvironmentRevision,
  InstallEnvironmentRequest,
  JsonValue,
  KernelMode,
  MemoryGraphMatchResponse,
  MemoryGraphTraceResult,
  NpuJob,
  NpuJobLogs,
  NpuJobResult,
  NpuWorkloadDescriptor,
  ProposeSkillLibraryUpdateRequest,
  PublishSkillLibraryUpdateProposalsResult,
  PythonExecutionResult,
  SkillLibraryUpdateProposal,
  RemoteWorkspaceFile,
  RemoteWorkspaceSyncRecord,
  ReviewCheckpointRequest,
  ReviewCheckpointResult,
  ScientificArtifact,
  ScientificArtifactVersion,
  ScientificExecutionResult,
  ScientificEnvironmentSetup,
  ScientificLanguage,
  SkillResource,
  SkillResourceContent,
  SkillReviewDraftSummary,
  ShellExecutionResult,
  UninstallEnvironmentRequest,
  WorkspaceFileProvenance,
} from "@sciencediscovery/schema";
import { Type, type TSchema } from "typebox";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
  GENERAL_PURPOSE_SUBAGENT,
  MAX_SUBAGENT_MAX_TURNS,
  MAX_SUBAGENT_TIMEOUT_SECONDS,
} from "@sciencediscovery/orchestration";
import { ENVIRONMENT_TOOL_NAMES } from "./environment-tool-names.js";

export interface WorkspaceFileInfo {
  modifiedAt: string;
  path: string;
  size: number;
}

export interface WorkspaceScanResult {
  files: WorkspaceFileInfo[];
  truncated: boolean;
}

export interface ToolFilterPolicy {
  allowed?: readonly string[] | null;
  disallowed?: readonly string[] | null;
}

/** Apply the established runtime policy: allowlist first, denylist second. */
export function filterTools<T extends { name: string }>(tools: readonly T[], policy: ToolFilterPolicy = {}): T[] {
  const allowedNames = policy.allowed === undefined || policy.allowed === null
    ? undefined
    : new Set(policy.allowed);
  const allowed = allowedNames ? tools.filter((tool) => allowedNames.has(tool.name)) : [...tools];
  if (!policy.disallowed?.length) return allowed;
  const disallowed = new Set(policy.disallowed);
  return allowed.filter((tool) => !disallowed.has(tool.name));
}

const MAX_DECLARE_ARTIFACT_PATHS = 50;
const SUBAGENT_RESULT_TEXT_LIMIT = 20_000;

type SubagentContractStopReason = "loop_capped" | "token_capped" | "turn_capped";
type SubagentStopReason =
  | "cancelled"
  | "completed"
  | "failed"
  | "result_validation_failed"
  | "timed_out"
  | SubagentContractStopReason;

function subagentTokenUsage(usage: Subagent["usage"]): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
}

function subagentStopReason(subagent: Subagent): SubagentStopReason {
  if (subagent.resultValidation?.status === "failed") return "result_validation_failed";
  if (subagent.status === "timed_out" && /maxTurns=/i.test(subagent.error ?? "")) return "turn_capped";
  if (subagent.status === "timed_out") return "timed_out";
  if (subagent.status === "cancelled") return "cancelled";
  if (subagent.status === "failed") return "failed";
  return "completed";
}

function contractStopReason(stopReason: SubagentStopReason): SubagentContractStopReason | undefined {
  return stopReason === "turn_capped" || stopReason === "token_capped" || stopReason === "loop_capped"
    ? stopReason
    : undefined;
}

function summarizeSubagentResult(subagent: Subagent): {
  brief?: string;
  error?: string;
  finalText?: string;
  id: string;
  rawStructuredResult?: string;
  resultValidation?: Subagent["resultValidation"];
  status: Subagent["status"];
  stopReason: SubagentStopReason;
  structuredResult?: unknown;
  subagent_error?: string;
  subagent_model_name?: string;
  subagent_result_brief?: string;
  subagent_result_sha256?: string;
  subagent_status: Subagent["status"];
  subagent_stop_reason?: SubagentContractStopReason;
  subagent_token_usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  turnCount: number;
  usage?: Subagent["usage"];
} {
  const fullFinalText = subagent.steps
    .findLast((step) => step.kind === "assistant" && step.content.trim())
    ?.content.trim();
  const finalText = fullFinalText?.slice(0, SUBAGENT_RESULT_TEXT_LIMIT);
  const stopReason = subagentStopReason(subagent);
  const subagentContractStopReason = contractStopReason(stopReason);
  const tokenUsage = subagentTokenUsage(subagent.usage);
  const modelName = subagent.model?.model ?? subagent.model?.name;
  return {
    ...(finalText ? { brief: finalText } : {}),
    ...(subagent.error ? { error: subagent.error } : {}),
    ...(finalText ? { finalText } : {}),
    id: subagent.id,
    ...(subagent.rawStructuredResult ? { rawStructuredResult: subagent.rawStructuredResult } : {}),
    ...(subagent.resultValidation ? { resultValidation: subagent.resultValidation } : {}),
    status: subagent.status,
    ...(subagent.resultValidation?.status === "passed" && subagent.structuredResult !== undefined
      ? { structuredResult: subagent.structuredResult }
      : {}),
    stopReason,
    ...(subagent.error && subagent.status !== "completed" ? { subagent_error: subagent.error.slice(0, SUBAGENT_RESULT_TEXT_LIMIT) } : {}),
    ...(modelName ? { subagent_model_name: modelName } : {}),
    ...(subagent.status === "completed" && finalText ? { subagent_result_brief: finalText } : {}),
    ...(subagent.status === "completed" && fullFinalText
      ? { subagent_result_sha256: createHash("sha256").update(fullFinalText).digest("hex") }
      : {}),
    subagent_status: subagent.status,
    ...(subagentContractStopReason ? { subagent_stop_reason: subagentContractStopReason } : {}),
    ...(tokenUsage ? { subagent_token_usage: tokenUsage } : {}),
    turnCount: subagent.turnCount,
    ...(subagent.usage ? { usage: subagent.usage } : {}),
  };
}

export interface WorkspaceToolOptions {
  timers?: {
    create(input: { afterMs?: number; at?: string; message: string; executionId?: string }): Promise<unknown>;
    list(): unknown;
    cancel(id: string): unknown;
  };
  shellExecutions?: {
    start(code: string, input: { environmentId?: string; cwd?: string }, signal?: AbortSignal, toolCallId?: string, runnerId?: string): Promise<import("@sciencediscovery/schema").AgentShellExecution>;
    wait(id: string, waitMs: number, signal?: AbortSignal): Promise<import("@sciencediscovery/schema").AgentShellExecution>;
    list(): import("@sciencediscovery/schema").AgentShellExecution[];
    get(id: string): Promise<import("@sciencediscovery/schema").AgentShellExecution>;
    logs(id: string, cursor?: number): Promise<import("@sciencediscovery/schema").ExecutionLogPage>;
    cancel(id: string): Promise<import("@sciencediscovery/schema").AgentShellExecution>;
  };
  createSkill?: (input: CreateSkillPackageRequest, signal?: AbortSignal) => Promise<SkillReviewDraftSummary>;
  declareArtifact?: (input: {
    description?: string;
    name?: string;
    path: string;
  }) => Promise<{ artifact: ScientificArtifact; version: ScientificArtifactVersion; instruction?: string }>;
  enabledConnectorIds: ConnectorId[];
  /** `machine` names one of `remoteRunners`; omitted or "local" runs on this machine. */
  executePython: (code: string, signal?: AbortSignal, toolCallId?: string, machine?: string) => Promise<PythonExecutionResult>;
  executeShell?: (
    code: string,
    kernelMode: KernelMode,
    signal?: AbortSignal,
    toolCallId?: string,
    machine?: string,
    environment?: { environmentId?: string; cwd?: string },
  ) => Promise<ShellExecutionResult>;
  executeScientific?: (
    language: ScientificLanguage,
    code: string,
    environmentRevisionId: string | undefined,
    kernelMode: KernelMode,
    signal?: AbortSignal,
    toolCallId?: string,
    machine?: string,
  ) => Promise<ScientificExecutionResult>;
  environments?: Environment[];
  environmentManagement?: {
    create: (input: CreateEnvironmentRequest, signal?: AbortSignal, runnerId?: string) => Promise<Environment>;
    delete: (environmentId: string, signal?: AbortSignal, runnerId?: string) => Promise<void>;
    install: (environmentId: string, input: InstallEnvironmentRequest, signal?: AbortSignal, runnerId?: string) => Promise<EnvironmentRevision>;
    list: (signal?: AbortSignal, runnerId?: string) => Promise<Environment[]>;
    setup?: (retry: boolean, signal?: AbortSignal, runnerId?: string) => Promise<ScientificEnvironmentSetup>;
    uninstall: (environmentId: string, input: UninstallEnvironmentRequest, signal?: AbortSignal, runnerId?: string) => Promise<EnvironmentRevision>;
  };
  artifactDownload?: (input: {
    candidateId: string;
    destinationPath?: string;
    mcpInvocationId: string;
  }, signal?: AbortSignal) => Promise<ArtifactDownloadResult>;
  mcpTools?: Array<{
    description: string;
    displayName: string;
    execute: (toolCallId: string, input: JsonValue, signal?: AbortSignal) => Promise<unknown>;
    inputSchema: Record<string, unknown>;
    name: string;
    routing: {
      keywords: string[];
      mode: "off" | "prefer";
      priority: number;
    };
    sourceId: string;
    toolId: string;
  }>;
  /** Optional parent workspace exposed to read-only tools for isolated subagents. */
  readOnlyWorkspaceRoot?: string;
  /** Host root of this Agent run's complete frozen Skill packages. */
  skillPackagesRoot?: string;
  npuBroker?: {
    cancel: (jobId: string, signal?: AbortSignal) => Promise<NpuJob>;
    get: (jobId: string, signal?: AbortSignal) => Promise<NpuJob>;
    listWorkloads: (signal?: AbortSignal) => Promise<NpuWorkloadDescriptor[]>;
    logs: (jobId: string, signal?: AbortSignal) => Promise<NpuJobLogs>;
    result: (jobId: string, signal?: AbortSignal) => Promise<NpuJobResult>;
    submit: (
      input: Omit<CreateNpuJobRequest, "sessionId" | "workspaceRoot" | "environmentRevisionId"> & { environmentId?: string },
      signal?: AbortSignal,
    ) => Promise<NpuJob>;
  };
  paperExtractPdf?: (input: {
    artifactJobId: string;
  }, signal?: AbortSignal) => Promise<unknown>;
  webFetch?: (toolCallId: string, url: string, signal?: AbortSignal) => Promise<unknown>;
  webSearch?: (toolCallId: string, query: string, signal?: AbortSignal) => Promise<unknown>;
  approvalMode?: "always_allow" | "ask_for_dangerous";
  runSubagent?: (input: SubagentInput, signal?: AbortSignal) => Promise<Subagent>;
  /**
   * Remote machines this Session is allowed to use. Being allowed is not being
   * pinned: every execution tool still defaults to this machine, and each of
   * these entries is an additional place the model may choose to run.
   */
  workspaceTransfers?: {
    workspaces(): Array<{ id: string; runnerId: string; description: string }>;
    start(input: WorkspaceTransferInput, signal?: AbortSignal): Promise<WorkspaceTransfer>;
    list(): WorkspaceTransfer[];
    get(id: string): WorkspaceTransfer;
    cancel(id: string): Promise<WorkspaceTransfer>;
  };
  localRunnerAllowed?: boolean;
  remoteRunners?: Array<{
    runnerId: string;
    description?: string;
    hostAlias: string;
    list: (signal?: AbortSignal) => Promise<RemoteWorkspaceFile[]>;
    sync: (input: {
      conflict: "overwrite" | "reject";
      direction: "pull" | "push";
      paths: string[];
    }, signal?: AbortSignal) => Promise<{ files: string[]; record: RemoteWorkspaceSyncRecord }>;
  }>;
  /** Cross-session memory-graph substring search (the `query_graph` LLM tool). */
  queryGraph?: (query: string) => Promise<MemoryGraphMatchResponse>;
  /** Create an Evidence node + extracts edge, Paper → Evidence (the
   * `declare_evidence` LLM tool). Returns a structured error code instead of
   * degrading. */
  declareEvidence?: (input: DeclareEvidenceInput) => Promise<DeclareResult>;
  /** Create a Claim node + supports edges (Evidence/Artifact → Claim) +
   * optional stated_in/produces edges (the `declare_claim` LLM tool). Returns
   * the alias → node chip_map the LLM uses to write chip aliases into the
   * report body. */
  declareClaim?: (input: DeclareClaimInput) => Promise<DeclareClaimResult>;
  listArtifacts?: () => Promise<ScientificArtifact[]>;
  getFileProvenance?: (path: string) => Promise<WorkspaceFileProvenance>;
  readArtifact?: (input: {
    artifactId?: string;
    /** Maximum lines in the returned text page. */
    limit?: number;
    name?: string;
    /** 1-based line the returned text page starts at. */
    offset?: number;
    version?: number;
  }) => Promise<ArtifactReadResult>;
  reviewCheckpoint?: (
    input: ReviewCheckpointRequest,
    signal?: AbortSignal,
    toolCallId?: string,
  ) => Promise<ReviewCheckpointResult>;
  proposeSkillLibraryUpdate?: (
    input: ProposeSkillLibraryUpdateRequest,
    signal?: AbortSignal,
    toolCallId?: string,
  ) => Promise<SkillLibraryUpdateProposal>;
  publishSkillLibraryUpdate?: (
    input: { proposalIds: string[] },
    signal?: AbortSignal,
    toolCallId?: string,
  ) => Promise<PublishSkillLibraryUpdateProposalsResult>;
  /** Trace a node's provenance chain and return whether it is intact
   * (`trace_provenance` tool, reviewer specialist authenticity check).
   * Returns `{startNode, chain, broken, truncated, reason}` — the caller
   * derives a `decision` from `broken`; this callback only forwards the trace. */
  traceProvenance?: (
    input: {
      nodeId: string;
      targetLabel?: string;
      maxHops?: number;
    },
    signal?: AbortSignal,
    toolCallId?: string,
  ) => Promise<MemoryGraphTraceResult>;
  skills?: Array<{
    content: string;
    description: string;
    hash: string;
    id: string;
    /** Sandbox path of the staged frozen package; absent for nested agents that run without a sandbox. */
    packagePath?: string;
    readResource: (path: string) => SkillResourceContent | Promise<SkillResourceContent>;
    resources: SkillResource[];
    revision: number;
    version: string;
  }>;
  specialists?: Array<{
    builtIn?: boolean;
    connectorIds: readonly ConnectorId[];
    description: string;
    enabledSkillIds: readonly string[];
    id: string;
    name: string;
  }>;
  toolPolicy?: ToolFilterPolicy;
}

function assertWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  if (!requestedPath.trim() || isAbsolute(requestedPath)) {
    throw new Error("Workspace paths must be non-empty and relative");
  }

  const root = resolve(workspaceRoot);
  const candidate = resolve(root, requestedPath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`Path escapes the workspace: ${requestedPath}`);
  }
  return candidate;
}

function descendantPath(parent: string, child: string): string | undefined {
  const path = relative(parent, child);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
  return path.split(sep).join("/");
}

async function resolveSandboxScriptPath(
  workspaceRoot: string,
  readOnlyWorkspaceRoot: string | undefined,
  skillPackagesRoot: string | undefined,
  requestedPath: string,
): Promise<{ environmentVariable?: string; path: string }> {
  const mounted = normalizeMountedReadPath(requestedPath);
  const mountedRoot = mounted.root === "skills"
    ? skillPackagesRoot
    : mounted.root === "extensions"
      ? resolve(workspaceRoot, SKILL_EXTENSIONS_WORKSPACE_PATH)
      : undefined;
  const hostRoot = mountedRoot ?? workspaceRoot;
  if ((mounted.root === "skills" || mounted.root === "extensions") && !mountedRoot) {
    throw new Error(`The mounted ${mounted.root} directory is unavailable`);
  }
  const candidate = assertWorkspacePath(hostRoot, mounted.path);
  let canonicalRoot: string;
  let canonicalScript: string;
  try {
    [canonicalRoot, canonicalScript] = await Promise.all([realpath(hostRoot), realpath(candidate)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`scriptPath does not exist in an authorized mount: ${requestedPath}`);
    }
    throw error;
  }
  if (canonicalScript !== canonicalRoot && !canonicalScript.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error(`scriptPath escapes its authorized mount: ${requestedPath}`);
  }
  if (!(await stat(canonicalScript)).isFile()) throw new Error("scriptPath must reference a regular file");

  const relativeScriptPath = relative(canonicalRoot, canonicalScript).split(sep).join("/");
  if (mounted.root === "skills") {
    return { environmentVariable: SKILL_PACKAGES_ENVIRONMENT_VARIABLE, path: relativeScriptPath };
  }
  if (mounted.root === "extensions") {
    return { environmentVariable: SKILL_EXTENSIONS_ENVIRONMENT_VARIABLE, path: relativeScriptPath };
  }

  let sandboxRoot = "/workspace";
  if (readOnlyWorkspaceRoot) {
    const canonicalParent = await realpath(readOnlyWorkspaceRoot);
    const writablePath = descendantPath(canonicalParent, canonicalRoot);
    if (writablePath) sandboxRoot = `${sandboxRoot}/${writablePath}`;
  }
  return { path: `${sandboxRoot}/${relativeScriptPath}` };
}

const SKILL_PACKAGE_ALIASES = skillRootAliases(SANDBOX_SKILL_PACKAGES_ROOT, SKILL_PACKAGES_ENVIRONMENT_VARIABLE);
const SKILL_EXTENSION_ALIASES = skillRootAliases(SANDBOX_SKILL_EXTENSIONS_ROOT, SKILL_EXTENSIONS_ENVIRONMENT_VARIABLE);

/** Strip any accepted spelling of a mounted root, returning the package-relative remainder. */
function stripMountedRoot(path: string, aliases: readonly string[]): string | undefined {
  for (const alias of aliases) {
    if (path === alias) return ".";
    if (path.startsWith(`${alias}/`)) return path.slice(alias.length + 1);
  }
  return undefined;
}

function normalizeMountedReadPath(requestedPath: string): {
  path: string;
  root: "extensions" | "parent" | "skills" | "workspace";
} {
  const path = requestedPath.trim();
  // Prompts advertise the environment-variable form because it resolves on both
  // bubblewrap and Seatbelt; tools are Node-side, so accept it unexpanded too.
  const skills = stripMountedRoot(path, SKILL_PACKAGE_ALIASES);
  if (skills !== undefined) return { path: skills, root: "skills" };
  const extensions = stripMountedRoot(path, SKILL_EXTENSION_ALIASES);
  if (extensions !== undefined) return { path: extensions, root: "extensions" };
  if (path === "/parent_workspace") return { path: ".", root: "parent" };
  if (path.startsWith("/parent_workspace/")) return { path: path.slice("/parent_workspace/".length), root: "parent" };
  if (path === "/workspace") return { path: ".", root: "workspace" };
  if (path.startsWith("/workspace/")) return { path: path.slice("/workspace/".length), root: "workspace" };
  return { path, root: "workspace" };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function summarizeSpecialistsForTaskTool(
  specialists: NonNullable<WorkspaceToolOptions["specialists"]> | undefined,
): string | undefined {
  if (!specialists?.length) return undefined;
  return specialists
    .map((specialist) => {
      const skills = specialist.enabledSkillIds.length ? specialist.enabledSkillIds.join(", ") : "none";
      const connectors = specialist.connectorIds.length ? specialist.connectorIds.join(", ") : "none";
      return `id: ${specialist.id}; description: ${specialist.description}; skills: ${skills}; connectors: ${connectors}`;
    })
    .join("; ");
}

const MAX_WORKSPACE_SCAN_FILES = 500;

export async function scanWorkspaceWithStatus(workspaceRoot: string): Promise<WorkspaceScanResult> {
  await mkdir(workspaceRoot, { recursive: true });
  const files: WorkspaceFileInfo[] = [];

  async function visit(directory: string): Promise<void> {
    if (files.length > MAX_WORKSPACE_SCAN_FILES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length > MAX_WORKSPACE_SCAN_FILES) break;
      const fullPath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const metadata = await stat(fullPath);
      files.push({
        modifiedAt: metadata.mtime.toISOString(),
        path: relative(resolve(workspaceRoot), fullPath).split(sep).join("/"),
        size: metadata.size,
      });
    }
  }

  await visit(resolve(workspaceRoot));
  return {
    files: files.slice(0, MAX_WORKSPACE_SCAN_FILES),
    truncated: files.length > MAX_WORKSPACE_SCAN_FILES,
  };
}

export async function scanWorkspace(workspaceRoot: string): Promise<WorkspaceFileInfo[]> {
  return (await scanWorkspaceWithStatus(workspaceRoot)).files;
}

function yamlQuoted(value: string): string {
  return JSON.stringify(value);
}

function renderGeneratedSkillMarkdown(input: {
  allowedTools?: string;
  compatibility?: string;
  description: string;
  instructions: string;
  license?: string;
  metadata?: Record<string, string>;
  name: string;
  version?: string;
}): string {
  const lines = [
    "---",
    `name: ${yamlQuoted(input.name)}`,
    `description: ${yamlQuoted(input.description)}`,
  ];
  if (input.version) lines.push(`version: ${yamlQuoted(input.version)}`);
  if (input.allowedTools) lines.push(`allowed-tools: ${yamlQuoted(input.allowedTools)}`);
  if (input.compatibility) lines.push(`compatibility: ${yamlQuoted(input.compatibility)}`);
  if (input.license) lines.push(`license: ${yamlQuoted(input.license)}`);
  const metadata = input.metadata ? Object.entries(input.metadata).filter(([key, value]) => key.trim() && value.trim()) : [];
  if (metadata.length) {
    lines.push("metadata:");
    for (const [key, value] of metadata.toSorted(([left], [right]) => left.localeCompare(right))) {
      lines.push(`  ${yamlQuoted(key)}: ${yamlQuoted(value)}`);
    }
  }
  return `${lines.join("\n")}\n---\n\n${input.instructions.trim()}\n`;
}

export function createWorkspaceTools(workspaceRoot: string, options: WorkspaceToolOptions): AgentTool[] {
  const emptyParameters = Type.Object({});
  const readFileParameters = Type.Object({
    limit: Type.Optional(Type.Integer({
      description: "Maximum number of lines to return; the page is additionally capped at 40 KB.",
      maximum: 10_000,
      minimum: 1,
    })),
    offset: Type.Optional(Type.Integer({
      description: "1-based line to start reading from. Use the offset reported by the previous page to continue.",
      minimum: 1,
    })),
    path: Type.String({ minLength: 1 }),
  });
  const readOnlyWorkspaceRoot = options.readOnlyWorkspaceRoot
    && resolve(options.readOnlyWorkspaceRoot) !== resolve(workspaceRoot)
    ? options.readOnlyWorkspaceRoot
    : undefined;
  const skillPackagesRoot = options.skillPackagesRoot;
  const skillExtensionsRoot = resolve(workspaceRoot, SKILL_EXTENSIONS_WORKSPACE_PATH);
  const loadedSkillIds = new Set<string>();

  /**
   * Describe only the Runners selected for this Session; location does not
   * bypass the execution permission check.
   */
  const runnerCatalog = [
    ...(options.localRunnerAllowed === false ? [] : [{ runnerId: "local", description: "Sandbox on this machine; current Agent workspace." }]),
    ...(options.remoteRunners ?? []).map((runner) => ({ runnerId: runner.runnerId, description: runner.description || runner.hostAlias })),
  ];
  const runnerSelectionHint = options.localRunnerAllowed !== false
    ? "Optional (default: local)."
    : runnerCatalog.length === 1
      ? `Required. Pass runner_id=${JSON.stringify(runnerCatalog[0]!.runnerId)}; it is the only allowed Runner.`
      : runnerCatalog.length > 1
        ? "Required. Choose an allowed Runner ID explicitly."
        : "No Runner is allowed for this Session; do not invoke Runner tools.";
  const runnerIdParameter = Type.String({
    minLength: 1,
    description: `Sandboxed execution environment ID. ${runnerSelectionHint} Available Runners: ${JSON.stringify(runnerCatalog)}. Runners have independent workspaces; sync selected inputs explicitly.`,
  });
  const machineParameter = {
    runner_id: options.localRunnerAllowed === false ? runnerIdParameter : Type.Optional(runnerIdParameter),
  };
  const listFiles: AgentTool<typeof emptyParameters> = {
    description: "List files in the current session workspace",
    execute: async () => {
      const files = await scanWorkspace(workspaceRoot);
      const readOnlyFiles = readOnlyWorkspaceRoot ? await scanWorkspace(readOnlyWorkspaceRoot) : [];
      const skillFiles = skillPackagesRoot ? await scanWorkspace(skillPackagesRoot) : [];
      if (readOnlyWorkspaceRoot || skillPackagesRoot) {
        const text = [
          files.length ? `Writable workspace:\n${files.map((file) => file.path).join("\n")}` : "Writable workspace is empty",
          ...(readOnlyWorkspaceRoot
            ? [readOnlyFiles.length ? `Read-only parent workspace:\n${readOnlyFiles.map((file) => file.path).join("\n")}` : "Read-only parent workspace is empty"]
            : []),
          ...(skillPackagesRoot
            ? [skillFiles.length ? `Read-only Skill packages (${SKILL_PACKAGES_PORTABLE_ROOT}):\n${skillFiles.map((file) => `${SKILL_PACKAGES_PORTABLE_ROOT}/${file.path}`).join("\n")}` : "Read-only Skill packages are empty"]
            : []),
        ].join("\n\n");
        return {
          content: [{ type: "text", text }],
          details: { files, readOnlyFiles, skillFiles },
        };
      }
      return {
        content: [{ type: "text", text: files.length ? files.map((file) => file.path).join("\n") : "Workspace is empty" }],
        details: { files },
      };
    },
    isConcurrencySafe: () => true,
    label: "List workspace files",
    name: "list_files",
    parameters: emptyParameters,
  };

  const readWorkspaceFile: AgentTool<typeof readFileParameters> = {
    description: "Read a page of a text file from the current workspace. Reads start at the first line and return at most 2000 lines or 40 KB; pass offset (1-based line) and limit to page through a larger file. Binary files are not read as text: the result reports the media type and size so you can process the file with run_shell instead.",
    execute: async (_toolCallId, params) => {
      const requested = normalizeMountedReadPath(params.path);
      const roots = requested.root === "parent"
        ? readOnlyWorkspaceRoot ? [readOnlyWorkspaceRoot] : []
        : requested.root === "skills"
          ? skillPackagesRoot ? [skillPackagesRoot] : []
          : requested.root === "extensions"
            ? [skillExtensionsRoot]
            : [workspaceRoot, ...(readOnlyWorkspaceRoot ? [readOnlyWorkspaceRoot] : [])];
      let path = "";
      let metadata: Awaited<ReturnType<typeof stat>> | undefined;
      let lastError: unknown;
      for (const root of roots) {
        try {
          path = assertWorkspacePath(root, requested.path);
          metadata = await stat(path);
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!metadata) {
        if (lastError) throw lastError;
        throw new Error(`The mounted ${requested.root} directory is unavailable`);
      }
      if (!metadata.isFile()) throw new Error(`Not a readable file: ${requested.path}`);

      if (await detectBinaryFile(path)) {
        const details = {
          binary: true,
          mediaType: guessMediaType(requested.path),
          note: "Binary content is never inlined into the conversation. Process this file in the sandbox with run_shell, or expose it to the user with declare_artifact.",
          path: requested.path,
          size: metadata.size,
        };
        return { bounded: true, content: [{ type: "text", text: JSON.stringify(details) }], details };
      }

      const page = await readTextFilePage(path, {
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.offset === undefined ? {} : { offset: params.offset }),
      });
      const details = { ...page, path: requested.path, size: metadata.size };
      // A whole small file keeps its exact bytes and no envelope, so ordinary
      // reads stay byte-identical to the file on disk.
      if (page.startLine === 1 && !page.hasMore) {
        return { bounded: true, content: [{ type: "text", text: page.text }], details };
      }
      const header = [
        `[paginated file] ${requested.path} lines ${page.startLine}-${page.endLine}`
        + `${page.totalLines === undefined ? "" : ` of ${page.totalLines}`}`
        + ` (${metadata.size} bytes total, ${page.bytes} bytes shown).`,
        page.hasMore
          ? `Continue with read_file(path="${requested.path}", offset=${page.nextOffset}).`
          : "This is the end of the file.",
        ...(page.partialLine
          ? [`Line ${page.startLine} is wider than one page and was cut; read the rest with run_shell (for example cut -c) instead of read_file.`]
          : []),
      ].join("\n");
      return { bounded: true, content: [{ type: "text", text: `${header}\n${page.text}` }], details };
    },
    isConcurrencySafe: () => true,
    label: "Read workspace file",
    name: "read_file",
    parameters: readFileParameters,
  };

  const provenanceTools: AgentTool[] = [];
  if (options.getFileProvenance) {
    const provenanceParameters = Type.Object({
      path: Type.String({ minLength: 1 }),
    });
    const getFileProvenance: AgentTool<typeof provenanceParameters> = {
      description: "Return recorded source, revision history, copy lineage, execution context, and linked Artifacts for one file in the current writable workspace. An unknown origin means the backend has no trustworthy attribution and must not be guessed.",
      execute: async (_toolCallId, params) => {
        const provenance = await options.getFileProvenance!(params.path);
        return {
          content: [{ type: "text", text: JSON.stringify(provenance, null, 2) }],
          details: provenance,
        };
      },
      isConcurrencySafe: () => true,
      label: "Get file provenance",
      name: "get_file_provenance",
      parameters: provenanceParameters,
    };
    provenanceTools.push(getFileProvenance);
  }

  const artifactTools: AgentTool[] = [];
  if (options.listArtifacts) {
    artifactTools.push({
      description: "List user-visible artifacts for the current Project across all Sessions, including origin and latest version metadata.",
      execute: async () => {
        const artifacts = await options.listArtifacts!();
        return { content: [{ type: "text", text: JSON.stringify(artifacts) }], details: { artifacts } };
      },
      isConcurrencySafe: () => true,
      label: "List project artifacts",
      name: "list_artifacts",
      parameters: emptyParameters,
    });
  }
  if (options.readArtifact) {
    const parameters = Type.Object({
      artifact_id: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Integer({
        description: "Maximum number of lines to return; the page is additionally capped at 40 KB.",
        maximum: 10_000,
        minimum: 1,
      })),
      name: Type.Optional(Type.String({ minLength: 1 })),
      offset: Type.Optional(Type.Integer({
        description: "1-based line to start reading from. Use page.nextOffset from the previous response to continue.",
        minimum: 1,
      })),
      version: Type.Optional(Type.Integer({ minimum: 1 })),
    });
    const readArtifact: AgentTool<typeof parameters> = {
      description: "Read a Project artifact by artifact_id or name, optionally selecting a version. At least one identifier is required. Text versions return one UTF-8 page (at most 2000 lines or 40 KB) plus a page range; use offset and limit to read the rest. Binary versions return only binary=true with the media type and size — their content is never inlined, so process them with run_shell instead.",
      execute: async (_toolCallId, params) => {
        if (!params.artifact_id && !params.name) throw new Error("artifact_id or name is required");
        const result = await options.readArtifact!({
          ...(params.artifact_id ? { artifactId: params.artifact_id } : {}),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
          ...(params.name ? { name: params.name } : {}),
          ...(params.offset === undefined ? {} : { offset: params.offset }),
          ...(params.version ? { version: params.version } : {}),
        });
        return { bounded: true, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
      isConcurrencySafe: () => true,
      label: "Read project artifact",
      name: "read_artifact",
      parameters,
    };
    artifactTools.push(readArtifact);
  }
  if (options.declareArtifact) {
    const parameters = Type.Object({
      description: Type.Optional(Type.String({ maxLength: 2_000 })),
      name: Type.Optional(Type.String({ maxLength: 2_000, minLength: 1 })),
      path: Type.Optional(Type.String({ maxLength: 2_000, minLength: 1 })),
      paths: Type.Optional(Type.Array(Type.String({ maxLength: 2_000, minLength: 1 }), {
        maxItems: MAX_DECLARE_ARTIFACT_PATHS,
        minItems: 1,
      })),
    });
    const declareArtifact: AgentTool<typeof parameters> = {
      description: "Declare existing files in your writable workspace as user-visible Project artifacts. Use path for one file or paths for 1-50 files; paths takes priority when both are present. A single-file name defaults to its workspace-relative path. Batch items also use their full relative paths and ignore top-level name/description. Batch failures are returned per item while successful items remain declared. Call this for every useful output, including the final output files. ORDER: when declaring a markdown/text artifact whose body carries [alias] citation tokens, call declare_artifact(output) AFTER all declare_claim calls — the chip references accumulated by declare_claim are drained onto this version at call time, so declaring the output before declare_claim ships a version with no references and the [alias] chips will not render. Do NOT declare files produced by other subagents that you only read as inputs — query/list the existing Artifact id and cite it instead, to avoid creating a duplicate node and a false produces edge.",
      execute: async (_toolCallId, params) => {
        if (params.paths !== undefined) {
          if (params.paths.length === 0) throw new Error("paths must contain at least one path");
          if (params.paths.length > MAX_DECLARE_ARTIFACT_PATHS) {
            throw new Error(`paths must contain at most ${MAX_DECLARE_ARTIFACT_PATHS} paths`);
          }
          const artifacts: Array<
            | { artifact_id: string; name: string; ok: true; origin: ScientificArtifact["origin"]; path: string; version: number }
            | { error: string; ok: false; path: string }
          > = [];
          for (const path of params.paths) {
            try {
              const result = await options.declareArtifact!({ path });
              artifacts.push({
                artifact_id: result.artifact.id,
                name: result.artifact.name,
                ok: true,
                origin: result.artifact.origin,
                path,
                version: result.version.version,
              });
            } catch (error) {
              artifacts.push({
                error: error instanceof Error && error.message ? error.message : "Artifact declaration failed",
                ok: false,
                path,
              });
            }
          }
          const details = { artifacts };
          return { content: [{ type: "text", text: JSON.stringify(details) }], details };
        }
        if (!params.path) throw new Error("path or paths is required");
        const result = await options.declareArtifact!({
          ...(params.description ? { description: params.description } : {}),
          ...(params.name ? { name: params.name } : {}),
          path: params.path,
        });
        return { content: [{ type: "text", text: JSON.stringify({
          artifact_id: result.artifact.id,
          content: result.version.content,
          name: result.artifact.name,
          origin: result.artifact.origin,
          version: result.version.version,
          ...(result.instruction ? { instruction: result.instruction } : {}),
        }) }], details: result };
      },
      label: "Declare artifact",
      name: "declare_artifact",
      parameters,
    };
    artifactTools.push(declareArtifact);
  }


  const tools: AgentTool[] = [listFiles, readWorkspaceFile, ...provenanceTools, ...artifactTools];
  if (options.workspaceTransfers) {
    const transfers = options.workspaceTransfers;
    const parameters = Type.Object({
      operation: Type.Union([Type.Literal("workspaces"), Type.Literal("start"), Type.Literal("list"), Type.Literal("status"), Type.Literal("cancel")]),
      transfer_id: Type.Optional(Type.String({ minLength: 1 })),
      source_workspace_id: Type.Optional(Type.String({ minLength: 1 })),
      target_workspace_id: Type.Optional(Type.String({ minLength: 1 })),
      files: Type.Optional(Type.Array(Type.Object({ source_path: Type.String({ minLength: 1 }), target_path: Type.String({ minLength: 1 }) }), { minItems: 1, maxItems: 50 })),
      conflict: Type.Optional(Type.Union([Type.Literal("reject"), Type.Literal("overwrite")])),
    });
    const transferTool: AgentTool<typeof parameters> = { name: "workspace_transfer", label: "Transfer workspace files", parameters,
      description: "Copy explicit file mappings between your authorized Workspaces, locally or across Runners. Discover Workspace IDs with workspaces. start returns a durable Transfer ID immediately; inspect progress, completed files and errors with status/list, or cancel. No mirroring or implicit Artifact declaration. Unknown target outcomes must be inspected before explicit retry.",
      execute: async (_id, params, signal) => {
        let result: unknown;
        if (params.operation === "workspaces") result = transfers.workspaces();
        else if (params.operation === "list") result = transfers.list();
        else if (params.operation === "start") {
          if (!params.source_workspace_id || !params.target_workspace_id || !params.files?.length) throw new Error("Both Workspace IDs and explicit file mappings are required");
          result = await transfers.start({ sourceWorkspaceId: params.source_workspace_id, targetWorkspaceId: params.target_workspace_id,
            files: params.files.map((file) => ({ sourcePath: file.source_path, targetPath: file.target_path })), conflict: params.conflict ?? "reject" }, signal);
        } else {
          if (!params.transfer_id) throw new Error("transfer_id is required");
          result = params.operation === "cancel" ? await transfers.cancel(params.transfer_id) : transfers.get(params.transfer_id);
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    };
    tools.push(transferTool);
  }
  if (options.remoteRunners?.length) {
    const runners = options.remoteRunners;
    const remoteWorkspaceParameters = Type.Object({
      conflict: Type.Optional(Type.Union([Type.Literal("reject"), Type.Literal("overwrite")])),
      // One Session can be allowed to use several machines, and each has its own
      // workspace, so the transfer always names which one it means.
      runner_id: Type.String({
        description: `Runner workspace to exchange files with: one of ${runners.map((runner) => runner.runnerId).join(", ")}.`,
        minLength: 1,
      }),
      operation: Type.Union([Type.Literal("list"), Type.Literal("pull"), Type.Literal("push")]),
      paths: Type.Optional(Type.Array(Type.String({ maxLength: 2_000, minLength: 1 }), {
        maxItems: 50,
        minItems: 1,
      })),
    });
    const remoteWorkspace: AgentTool<typeof remoteWorkspaceParameters> = {
      description: [
        `Explicitly exchange selected paths between the local Session workspace and the independent persistent workspace of an allowed remote machine (${runners.map((runner) => runner.runnerId).join(", ")}).`,
        "Use list to inspect remote files. Use push only when remote execution needs local inputs; use pull only for outputs the user should receive locally.",
        "Nothing is mirrored automatically. Unpulled intermediate files remain remote. The default conflict policy rejects existing destination files; choose overwrite explicitly when intended.",
      ].join(" "),
      execute: async (_toolCallId, params, signal) => {
        const runner = runners.find((candidate) => candidate.runnerId === params.runner_id);
        if (!runner) throw new Error(`This Session may not use ${params.runner_id}; allowed machines: ${runners.map((runner) => runner.runnerId).join(", ")}`);
        if (params.operation === "list") {
          const files = await runner.list(signal);
          return { content: [{ type: "text", text: JSON.stringify({ files }) }], details: { files } };
        }
        if (!params.paths?.length) throw new Error("paths are required for push and pull");
        const result = await runner.sync({
          conflict: params.conflict ?? "reject",
          direction: params.operation,
          paths: params.paths,
        }, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
      label: "Sync remote workspace",
      name: "sync_remote_workspace",
      parameters: remoteWorkspaceParameters,
    };
    tools.push(remoteWorkspace);
  }
  if (options.npuBroker) {
    const npuParameters = Type.Object({
      operation: Type.Union([
        Type.Literal("list_workloads"),
        Type.Literal("submit"),
        Type.Literal("status"),
        Type.Literal("logs"),
        Type.Literal("result"),
        Type.Literal("cancel"),
      ]),
      workload_id: Type.Optional(Type.String({
        description: "Allowlisted NPU workload id returned by operation=list_workloads.",
        minLength: 1,
      })),
      config_path: Type.Optional(Type.String({
        description: "Workspace-relative config path when the selected workload lists requiredInputs including configPath, for example antibody_pipeline/config.json.",
        minLength: 1,
      })),
      environment_id: Type.Optional(Type.String({
        description: "Managed environment ID; always resolves its latest revision. Omit to use the Session-selected environment.",
        minLength: 1,
      })),
      job_id: Type.Optional(Type.String({ minLength: 1 })),
    });
    const declareNpuJobArtifacts = async (paths: string[]) => {
      if (!options.declareArtifact || paths.length === 0) return [];
      const artifacts: Array<
        | { artifact_id: string; name: string; ok: true; origin: ScientificArtifact["origin"]; path: string; version: number }
        | { error: string; ok: false; path: string }
      > = [];
      for (const path of paths.slice(0, MAX_DECLARE_ARTIFACT_PATHS)) {
        try {
          const result = await options.declareArtifact({ path });
          artifacts.push({
            artifact_id: result.artifact.id,
            name: result.artifact.name,
            ok: true,
            origin: result.artifact.origin,
            path,
            version: result.version.version,
          });
        } catch (error) {
          artifacts.push({
            error: error instanceof Error && error.message ? error.message : "Artifact declaration failed",
            ok: false,
            path,
          });
        }
      }
      if (paths.length > MAX_DECLARE_ARTIFACT_PATHS) {
        artifacts.push({
          error: `NPU job returned ${paths.length} created files; only the first ${MAX_DECLARE_ARTIFACT_PATHS} were declared`,
          ok: false,
          path: "(truncated)",
        });
      }
      return artifacts;
    };
    const runNpuJob: AgentTool<typeof npuParameters> = {
      description: [
        "Submit or inspect an allowlisted host NPU Broker job without leaving the ScienceDiscovery sandbox.",
        "Use operation=list_workloads first, then choose only a workload id returned by that call.",
        "For operation=submit, provide config_path when the selected workload's requiredInputs includes configPath.",
        "For a workload with requiresEnvironmentRevision=true, provide environment_id from environment_list; the server resolves its latest revision. Historical revision selection is not supported.",
        "Use status/logs/result/cancel with job_id after submission.",
        "When operation=result returns job.createdFiles, those workspace files are automatically declared as Project artifacts when artifact declaration is available; otherwise call declare_artifact on those exact paths.",
        "Do not use run_shell to access /home, source host env.sh, write host_launch_request.json, or expect NPU devices inside bwrap.",
      ].join(" "),
      execute: async (toolCallId, params, signal) => {
        const broker = options.npuBroker!;
        if (Object.hasOwn(params, "environment_revision_id")) throw new Error("Historical revision selection is not supported; use environment_id");
        if (params.operation === "list_workloads") {
          const workloads = await broker.listWorkloads(signal);
          return { content: [{ type: "text", text: JSON.stringify({ workloads }) }], details: { workloads } };
        }
        if (params.operation === "submit") {
          const workloadId = params.workload_id?.trim();
          if (!workloadId) throw new Error("workload_id is required for submit");
          const workloads = await broker.listWorkloads(signal);
          const workload = workloads.find((candidate) => candidate.id === workloadId);
          if (!workload) throw new Error(`Unsupported NPU workload: ${workloadId}`);
          const requiredInputs = new Set(workload.requiredInputs ?? []);
          const inputs: Record<string, unknown> = {};
          if (requiredInputs.has("configPath")) {
            if (!params.config_path?.trim()) throw new Error(`config_path is required for ${workloadId}`);
            const requested = normalizeMountedReadPath(params.config_path);
            if (requested.root !== "workspace") throw new Error("config_path must be in the writable session workspace");
            inputs.configPath = normalizeWorkspaceRelativePath(workspaceRoot, requested.path);
          }
          const environmentId = params.environment_id?.trim();
          const job = await broker.submit({
            ...(environmentId ? { environmentId } : {}),
            inputs,
            workloadId,
          }, signal);
          return { content: [{ type: "text", text: JSON.stringify({ job }) }], details: { job } };
        }
        const jobId = params.job_id?.trim();
        if (!jobId) throw new Error(`job_id is required for ${params.operation}`);
        if (params.operation === "status") {
          const job = await broker.get(jobId, signal);
          return { content: [{ type: "text", text: JSON.stringify({ job }) }], details: { job } };
        }
        if (params.operation === "logs") {
          const logs = await broker.logs(jobId, signal);
          return { content: [{ type: "text", text: JSON.stringify({ logs }) }], details: { logs } };
        }
        if (params.operation === "result") {
          const result = await broker.result(jobId, signal);
          const artifacts = await declareNpuJobArtifacts(result.job.createdFiles ?? []);
          const details = artifacts.length > 0 ? { ...result, artifacts } : result;
          return { content: [{ type: "text", text: JSON.stringify(details) }], details };
        }
        const job = await broker.cancel(jobId, signal);
        return { content: [{ type: "text", text: JSON.stringify({ job }) }], details: { job } };
      },
      label: "Run NPU broker job",
      name: "run_npu_job",
      parameters: npuParameters,
    };
    tools.push(runNpuJob);
  }
  if (options.webSearch) {
    const parameters = Type.Object({
      query: Type.String({
        description: "Non-empty search query, from 1 to 2000 characters.",
        maxLength: 2_000,
        minLength: 1,
      }),
    });
    const webSearch: AgentTool<typeof parameters> = {
      description: "Search the public web for current information. Results are snippets and links, not proof that a page was fully read. Use web_fetch on an exact returned URL when full page content is needed.",
      execute: async (toolCallId, params, signal) => {
        const result = await options.webSearch!(toolCallId, params.query, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
      isConcurrencySafe: () => true,
      label: "Search the web",
      name: "web_search",
      parameters,
    };
    tools.push(webSearch);
  }
  if (options.webFetch) {
    const parameters = Type.Object({
      url: Type.String({ maxLength: 8_192, minLength: 1 }),
    });
    const webFetch: AgentTool<typeof parameters> = {
      description: "Fetch and extract readable content from an exact public http(s) URL supplied by the user or returned by web_search. Authenticated pages, browser rendering, and private-network URLs are not supported.",
      execute: async (toolCallId, params, signal) => {
        const result = await options.webFetch!(toolCallId, params.url, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
      isConcurrencySafe: () => true,
      label: "Fetch web page",
      name: "web_fetch",
      parameters,
    };
    tools.push(webFetch);
  }
  if (options.queryGraph) {
    const queryGraphParameters = Type.Object({ query: Type.String({ minLength: 1 }) });
    const queryGraph: AgentTool<typeof queryGraphParameters> = {
      description: "Browse this session's memory-graph nodes (ResearchGoal/Task/ToolCall/Paper/Evidence/Claim/Code/Artifact/SourceFile) by keyword. Returns {hits, total, truncated}. Matching is term-OR: the query is split into words and a node matches if its text contains ANY word; nodes matching more words rank higher. Use it to see what has already been searched (Papers), produced (Artifacts/Evidence), or uploaded (SourceFile) in this session. This is an exploratory read, not an id lookup — to cite a node, use the id returned by declare_evidence/declare_artifact, or list_artifacts for an existing Artifact. Give concrete entity terms that appear in the graph (e.g. 'TP53 NSCLC'), not meta-words like 'paper' or 'evidence'.",
      execute: async (_toolCallId, params) => {
        const result = await options.queryGraph!(params.query);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
      isConcurrencySafe: () => true,
      label: "Query memory graph",
      name: "query_graph",
      parameters: queryGraphParameters,
    };
    tools.push(queryGraph);
  }
  if (options.declareEvidence) {
    const declareEvidenceParameters = Type.Object({
      content: Type.String({ minLength: 1 }),
      // Source routing: exactly one of source_paper_link / source_file_id.
      // source_paper_link for a Paper already in the graph; source_file_id for
      // an uploaded PDF (media_type=application/pdf). Non-PDF data files
      // (CSV/image/etc) cannot be Evidence sources — use declare_claim's
      // cites_source_file_aliases instead.
      source_paper_link: Type.Optional(Type.String({ minLength: 1 })),
      source_file_id: Type.Optional(Type.String({ minLength: 1 })),
      locator: Type.String({ minLength: 1 }),
      evidence_type: Type.String(),
      confidence: Type.String(),
      strength: Type.String(),
    });
    const declareEvidence: AgentTool<typeof declareEvidenceParameters> = {
      description: "Record a piece of Evidence extracted from a Paper OR an uploaded PDF SourceFile that already exists in this session's memory graph. Creates an Evidence node + an extracts edge from the source (Paper/PDF-SourceFile → Evidence). Pass source_paper_link for a Paper already in the graph, or source_file_id for an uploaded PDF (media_type=application/pdf) — exactly one. Non-PDF data files (CSV/image/etc) cannot be Evidence sources — use declare_claim's cites_source_file_aliases instead. Returns {status:'ok', evidence_id} or a structured error (source_paper_not_found / source_file_not_found / source_file_not_pdf / no_source / ambiguous_source). Use the returned evidence_id as the chip alias target in declare_claim's cites_evidence_aliases and write [evidenceN] in your report body.",
      execute: async (_toolCallId, params) => {
        const result = await options.declareEvidence!({
          content: params.content,
          ...(params.source_paper_link ? { sourcePaperLink: params.source_paper_link } : {}),
          ...(params.source_file_id ? { sourceFileId: params.source_file_id } : {}),
          locator: params.locator,
          evidenceType: params.evidence_type,
          confidence: params.confidence,
          strength: params.strength,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
      label: "Declare evidence",
      name: "declare_evidence",
      parameters: declareEvidenceParameters,
    };
    tools.push(declareEvidence);
  }
  if (options.declareClaim) {
    const declareClaimParameters = Type.Object({
      content: Type.String({ minLength: 1 }),
      claim_type: Type.String(),
      confidence: Type.String(),
      locator: Type.String(),
      cites_evidence_aliases: Type.Record(Type.String(), Type.String()),
      cites_artifact_aliases: Type.Record(Type.String(), Type.String()),
      // alias → file_id for an uploaded non-PDF data file (CSV/image/etc) that
      // directly supports the claim (SourceFile -[:supports]-> Claim). A PDF
      // must NOT go here — it goes via declare_evidence → cites_evidence_
      // aliases (the sidecar rejects a PDF with source_file_is_pdf).
      cites_source_file_aliases: Type.Optional(Type.Record(Type.String(), Type.String())),
      artifact_id: Type.Optional(Type.String({ minLength: 1 })),
    });
    const declareClaim: AgentTool<typeof declareClaimParameters> = {
      description: "Record a Claim (a cited assertion) and link it to its supporting nodes. Creates a Claim node + supports edges from the cited Evidence/Artifact/SourceFile (Evidence/Artifact/SourceFile → Claim). At least one citation target is required. A Claim is backed by Evidence/Artifact/SourceFile via supports — it does NOT reach a Paper directly: to cite a paper, call declare_evidence first and cite the returned evidence_id here. Uploaded non-PDF data files (CSV/image/etc) are cited directly via cites_source_file_aliases (alias format sourcefile+number, e.g. [sourcefile1]) — a PDF must NOT go this route; declare_evidence it first. Choose aliases of the form evidence+number for Evidence (e.g. [evidence1]) or artifact+number for Artifact (e.g. [artifact1]) or sourcefile+number for uploaded data files (e.g. [sourcefile1]) — no other format. Write each chosen alias token inline in the output body where the claim is asserted; a chip renders only when a [alias] token in the body matches this claim's chip_map. These aliases are platform provenance tags, not academic citations: when the report has a numbered reference list, also write a matching scholarly marker such as [1] next to the claim and map it to reference [1].",
      execute: async (_toolCallId, params) => {
        const result = await options.declareClaim!({
          content: params.content,
          claimType: params.claim_type,
          confidence: params.confidence,
          locator: params.locator,
          citesEvidenceAliases: params.cites_evidence_aliases,
          citesArtifactAliases: params.cites_artifact_aliases,
          ...(params.cites_source_file_aliases ? { citesSourceFileAliases: params.cites_source_file_aliases } : {}),
          ...(params.artifact_id ? { artifactId: params.artifact_id } : {}),
        });
        // Surface a reminder to write the alias tokens into the output body
        // now (with the allowed format) — a chip renders only when a [alias]
        // token in the body matches this claim's chip_map. On error, forward
        // the sidecar's actionable instruction so the LLM can self-correct.
        const instruction = result.status === "ok" && Object.keys(result.chipMap).length
          ? `Write these alias tokens inline in the output body now, where each claim is asserted: ${Object.keys(result.chipMap).map((alias) => `[${alias}]`).join(", ")}. Aliases must be evidence+number for evidence (e.g. [evidence1]) or artifact+number for artifacts (e.g. [artifact1]) or sourcefile+number for uploaded data files (e.g. [sourcefile1]) — no other format.`
          : result.status === "error" ? result.instruction : undefined;
        const text = JSON.stringify(instruction ? { ...result, instruction } : result);
        return { content: [{ type: "text", text }], details: result };
      },
      label: "Declare claim",
      name: "declare_claim",
      parameters: declareClaimParameters,
    };
    tools.push(declareClaim);
  }
  if (options.runSubagent) {
    const specialistSummary = summarizeSpecialistsForTaskTool(options.specialists);
    const specialistLiterals = options.specialists?.map((specialist) => Type.Literal(specialist.id)) ?? [];
    const specialistIdSchema = specialistSummary
      ? Type.Union(
        specialistLiterals as [typeof specialistLiterals[number], ...typeof specialistLiterals],
        {
          description: `Optional user specialist to apply to this subagent. Choose the id whose description best matches the requested delegated work. Available specialists: ${specialistSummary}`,
        },
      )
      : Type.String({
        description: "Optional user specialist id to apply to this subagent.",
        minLength: 1,
      });
    const briefParameters = Type.Object({
      collaborationRules: Type.Array(Type.String({ maxLength: 1_000, minLength: 1 }), { maxItems: 12, minItems: 1 }),
      constraints: Type.Array(Type.String({ maxLength: 1_000, minLength: 1 }), { maxItems: 20, minItems: 1 }),
      goal: Type.String({ maxLength: 2_000, minLength: 1 }),
      outputJsonSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      outputRequirements: Type.Array(Type.String({ maxLength: 1_000, minLength: 1 }), { maxItems: 20, minItems: 1 }),
      version: Type.Optional(Type.Integer({ maximum: 1000, minimum: 1 })),
    });
    const taskParameters = Type.Object({
      brief: Type.Optional(briefParameters),
      description: Type.String({ maxLength: 80, minLength: 1 }),
      inputPaths: Type.Optional(Type.Array(Type.String({ maxLength: 2_000, minLength: 1 }), { maxItems: 50 })),
      max_turns: Type.Optional(Type.Integer({
        default: DEFAULT_SUBAGENT_MAX_TURNS,
        description: "Optional model-turn budget for this subagent. Increase it for unusually deep delegated work.",
        maximum: MAX_SUBAGENT_MAX_TURNS,
        minimum: DEFAULT_SUBAGENT_MAX_TURNS,
      })),
      prompt: Type.String({ maxLength: 20_000, minLength: 1 }),
      specialistId: Type.Optional(specialistIdSchema),
      subagent_type: Type.Optional(Type.String({ maxLength: 80, minLength: 1 })),
      timeout_seconds: Type.Optional(Type.Integer({
        default: DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
        description: "Optional wall-clock runtime budget in seconds for this subagent. Increase it for long delegated work.",
        maximum: MAX_SUBAGENT_TIMEOUT_SECONDS,
        minimum: DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
      })),
      tools: Type.Optional(Type.Union([
        Type.Null(),
        Type.Array(Type.String({ minLength: 1 }), { maxItems: 32 }),
      ])),
    });
    const task: AgentTool<typeof taskParameters> = {
      description: [
        "Run one focused task in a subagent. Call this tool multiple times in the same turn when independent tasks should run concurrently. For unusually deep tasks, pass max_turns and timeout_seconds explicitly. Prefer passing brief for Brief v1: goal, constraints, outputRequirements, collaborationRules, optional outputJsonSchema, and version. When outputJsonSchema is present, instruct the subagent to finish with JSON matching that schema.",
        specialistSummary ? `Choose specialistId by semantic match against specialist descriptions. Set specialistId so the specialist's instructions, skills, and connectors are applied. Available specialists: ${specialistSummary}` : "",
      ].filter(Boolean).join(" "),
      execute: async (toolCallId, params, signal) => {
        const subagent = await options.runSubagent!({
          ...(params.brief ? { brief: params.brief } : {}),
          description: params.description,
          ...(params.inputPaths ? { inputPaths: params.inputPaths } : {}),
          ...(params.max_turns === undefined ? {} : { maxTurns: params.max_turns }),
          prompt: params.prompt,
          ...(params.specialistId ? { specialistId: params.specialistId } : {}),
          ...(params.subagent_type ? { subagentType: params.subagent_type } : {}),
          ...(params.timeout_seconds === undefined ? {} : { timeoutSeconds: params.timeout_seconds }),
          ...(params.tools === undefined ? {} : { tools: params.tools }),
        }, signal);
        const summary = summarizeSubagentResult(subagent);
        return { content: [{ type: "text", text: JSON.stringify(summary) }], details: { subagent, summary } };
      },
      isConcurrencySafe: () => true,
      label: "Run subagent",
      name: "task",
      parameters: taskParameters,
    };
    tools.push(task);
  }
  if (options.reviewCheckpoint) {
    const reviewCheckpointParameters = Type.Object({
      artifactVersionIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
      reason: Type.String({ maxLength: 1_000, minLength: 1 }),
    });
    const reviewCheckpoint: AgentTool<typeof reviewCheckpointParameters> = {
      description: "Run a fast read-only review of locked scientific Artifact versions. Omit artifactVersionIds to review Artifacts created by the current AgentRun. Narrative Artifacts are checked for citations and Evidence-linked numeric claims; structured JSON source/metadata Artifacts receive only JSON structure and Artifact provenance checks.",
      execute: async (toolCallId, params, signal) => {
        const result = await options.reviewCheckpoint!(params, signal, toolCallId);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
      isConcurrencySafe: () => true,
      label: "Review artifact checkpoint",
      name: "review_checkpoint",
      parameters: reviewCheckpointParameters,
    };
    tools.push(reviewCheckpoint);
  }
  if (options.proposeSkillLibraryUpdate) {
    const sourceRefParameters = Type.Object({
      id: Type.String({ minLength: 1 }),
      kind: Type.Union([
        Type.Literal("artifact"),
        Type.Literal("review-finding"),
        Type.Literal("run"),
        Type.Literal("session"),
        Type.Literal("tool-call"),
      ]),
    });
    const skillPackageParameters = Type.Object({
      files: Type.Array(Type.Object({
        content: Type.String({ minLength: 1 }),
        encoding: Type.Optional(Type.Union([Type.Literal("base64"), Type.Literal("utf8")])),
        path: Type.String({ minLength: 1 }),
      }), { minItems: 1, maxItems: 32 }),
    });
    const generatedSkillParameters = Type.Object({
      allowedTools: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      compatibility: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      description: Type.String({ minLength: 1, maxLength: 1024 }),
      instructions: Type.String({ minLength: 1 }),
      license: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      metadata: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.String({ minLength: 1, maxLength: 500 }))),
      name: Type.String({ minLength: 1, maxLength: 64 }),
      version: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    });
    const operationParameters = Type.Union([
      Type.Object({ package: skillPackageParameters, type: Type.Literal("upsert") }),
      Type.Object({ skill: generatedSkillParameters, type: Type.Literal("upsert_skill") }),
      Type.Object({ skillId: Type.String({ minLength: 1 }), type: Type.Literal("delete") }),
    ]);
    const proposeSkillLibraryUpdateParameters = Type.Object({
      baseVersionId: Type.Optional(Type.String({ minLength: 1 })),
      libraryId: Type.String({ minLength: 1 }),
      operations: Type.Array(operationParameters, { minItems: 1, maxItems: 16 }),
      rationale: Type.String({ minLength: 1, maxLength: 4_000 }),
      sourceRefs: Type.Optional(Type.Array(sourceRefParameters, { maxItems: 16 })),
    });
    const proposeSkillLibraryUpdate: AgentTool<typeof proposeSkillLibraryUpdateParameters> = {
      description: "Propose a self-evolution update to a writable Skill Library. Prefer operations with type `upsert_skill` and a structured `skill` object; the tool will generate a valid SKILL.md with YAML frontmatter. Use raw `upsert` packages only when extra resource files are needed. This only creates a pending proposal; when the user asks to publish accepted proposals, call `publish_skill_library_update` with the proposal ids.",
      execute: async (toolCallId, params, signal) => {
        const operations = params.operations.map((operation) => {
          if (operation.type !== "upsert_skill") return operation;
          return {
            package: {
              files: [{
                content: renderGeneratedSkillMarkdown(operation.skill),
                path: "SKILL.md",
              }],
            },
            type: "upsert" as const,
          };
        });
        const proposal = await options.proposeSkillLibraryUpdate!({
          author: { kind: "self-evolution", name: "Agent self-evolution proposal" },
          ...(params.baseVersionId ? { baseVersionId: params.baseVersionId } : {}),
          dryRun: true,
          libraryId: params.libraryId,
          operations,
          rationale: params.rationale,
          sourceRefs: params.sourceRefs ?? [],
        }, signal, toolCallId);
        return {
          content: [{ type: "text", text: JSON.stringify({
            conflicts: proposal.result.conflicts,
            diagnostics: proposal.result.diagnostics,
            diff: proposal.result.diff,
            id: proposal.id,
            libraryId: proposal.libraryId,
            nextTool: proposal.result.conflicts.length ? undefined : "publish_skill_library_update",
            status: proposal.status,
          }, null, 2) }],
          details: proposal,
        };
      },
      label: "Propose skill library update",
      name: "propose_skill_library_update",
      parameters: proposeSkillLibraryUpdateParameters,
    };
    tools.push(proposeSkillLibraryUpdate);
  }
  if (options.publishSkillLibraryUpdate) {
    const publishSkillLibraryUpdateParameters = Type.Object({
      proposalIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 50 }),
    });
    const publishSkillLibraryUpdate: AgentTool<typeof publishSkillLibraryUpdateParameters> = {
      description: "Publish one or more pending Skill Library self-evolution proposals after user permission is granted. Multiple proposals must belong to the same writable library and are merged into one new library version.",
      execute: async (toolCallId, params, signal) => {
        const result = await options.publishSkillLibraryUpdate!({ proposalIds: params.proposalIds }, signal, toolCallId);
        return {
          content: [{ type: "text", text: JSON.stringify({
            conflicts: result.result.conflicts,
            diagnostics: result.result.diagnostics,
            diff: result.result.diff,
            proposalIds: result.proposals.map((proposal) => proposal.id),
            publishedVersionId: result.result.version?.id,
          }, null, 2) }],
          details: result,
        };
      },
      label: "Publish skill library update",
      name: "publish_skill_library_update",
      parameters: publishSkillLibraryUpdateParameters,
    };
    tools.push(publishSkillLibraryUpdate);
  }
  if (options.traceProvenance) {
    const traceProvenanceParameters = Type.Object({
      node_id: Type.String({ minLength: 1 }),
      target_label: Type.Optional(Type.String({ minLength: 1 })),
      max_hops: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
    });
    const traceProvenance: AgentTool<typeof traceProvenanceParameters> = {
      description: "Trace the provenance chain from a node (usually an artifact_id) up to its ResearchGoal (or a target label) and return whether the chain is intact. Returns {startNode, chain, broken, truncated, reason}. broken=false means the artifact is traceable to its origin; broken=true means the chain is severed or the graph is unavailable — flag for manual verification. RESTRICTED USE: call this ONLY when performing a reviewer-specialist authenticity check on a specific artifact, to decide whether it can be traced back to its ResearchGoal. Do NOT call it for general exploration, to answer questions, to browse the graph, or to look up node ids — use query_graph for id lookup and the subgraph view for browsing. It is exclusively an authenticity-verification tool, never a general-purpose graph traversal. Only invoke it with an artifact_id (or claim_id) you already have from a run's produced-artifacts line or a prior query_graph result.",
      execute: async (toolCallId, params, signal) => {
        const result = await options.traceProvenance!({
          nodeId: params.node_id,
          ...(params.target_label ? { targetLabel: params.target_label } : {}),
          ...(params.max_hops ? { maxHops: params.max_hops } : {}),
        }, signal, toolCallId);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
      label: "Trace provenance",
      name: "trace_provenance",
      parameters: traceProvenanceParameters,
    };
    tools.push(traceProvenance);
  }
  if (options.executeShell) {
    const shellParameters = Type.Object({
      background: Type.Optional(Type.Boolean({ description: "Return after acceptance without waiting for completion." })),
      wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000, description: "Foreground wait budget (default 10000 ms), not a process timeout." })),
      arguments: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 32 })),
      command: Type.Optional(Type.String({ maxLength: 20_000, minLength: 1 })),
      environment_id: Type.Optional(Type.String({ minLength: 1 })),
      cwd: Type.Optional(Type.String({ maxLength: 1_000 })),
      scriptPath: Type.Optional(Type.String({ maxLength: 1_000, minLength: 1 })),
      ...machineParameter,
    });
    const runShell: AgentTool<typeof shellParameters> = {
      description: "Run a command (including python -m, Python files, or Rscript) in a fresh Runner sandbox Shell. Choose runner_id and environment_id from the catalogs; the environment's latest state is used and mounted read-only. cwd is relative to this Agent's workspace. Provide exactly one of command or scriptPath; scripts may also come from the read-only $SCIENCEDISCOVERY_SKILLS_DIR mount. cd/export and interpreter variables do not persist between calls. Install/update/remove dependencies with environment management tools, not Shell. Network and filesystem access follow the authorized sandbox policy. Large output is bounded; use read_tool_output for retained output."
        + (options.shellExecutions ? " Foreground execution waits up to wait_ms (default 10000); background=true returns after acceptance. A wait deadline does not stop the command. Retain the returned Execution ID and use execution_status/logs/cancel; do not resubmit a running or unknown command." : ""),
      execute: async (toolCallId, params, signal) => {
        if (Boolean(params.command) === Boolean(params.scriptPath)) {
          throw new Error("Provide exactly one of command or scriptPath");
        }
        let code = params.command?.trim() ?? "";
        if (params.scriptPath) {
          const script = await resolveSandboxScriptPath(
            workspaceRoot,
            options.readOnlyWorkspaceRoot,
            skillPackagesRoot,
            params.scriptPath,
          );
          const scriptWord = script.environmentVariable
            ? `"\${${script.environmentVariable}}"/${shellQuote(script.path)}`
            : shellQuote(script.path);
          code = ["/usr/bin/bash", scriptWord, ...(params.arguments ?? []).map(shellQuote)].join(" ");
        }
        if (options.shellExecutions) {
          let execution = await options.shellExecutions.start(code, {
            environmentId: params.environment_id, cwd: params.cwd,
          }, signal, toolCallId, params.runner_id);
          if (!params.background) execution = await options.shellExecutions.wait(execution.id, params.wait_ms ?? 10_000, signal);
          const pending = execution.state === "queued" || execution.state === "running";
          return {
            isError: ["failed", "cancelled", "unknown"].includes(execution.state),
            content: [{ type: "text", text: JSON.stringify({
              ...execution,
              ...(pending ? { instruction: "Execution is still running or queued. The wait ended, not the command. Use execution_status, execution_logs or execution_cancel; do not resubmit it." } : {}),
            }) }],
            details: execution,
          };
        }
        if (params.background || params.wait_ms !== undefined) throw new Error("Managed Shell Execution is unavailable on this runtime");
        const result = await options.executeShell!(code, "ephemeral", signal, toolCallId, params.runner_id, {
          environmentId: params.environment_id, cwd: params.cwd,
        });
        return {
          isError: result.exitCode !== 0,
          content: [{ type: "text", text: [
            result.stdout ? `stdout:\n${result.stdout}` : "stdout: (empty)",
            result.stderr ? `stderr:\n${result.stderr}` : "stderr: (empty)",
            `created files: ${result.createdFiles.join(", ") || "none"}`,
            `kernel mode: ${result.kernelMode}`,
            ...(result.memoryStateLost ? [`persistent shell state lost: ${result.memoryStateLost}`] : []),
          ].join("\n") }],
          details: result,
        };
      },
      label: "Run shell",
      name: "run_shell",
      parameters: shellParameters,
    };
    tools.push(runShell);
  }
  if (options.timers) {
    const createParameters = Type.Object({
      after_ms: Type.Optional(Type.Integer({ minimum: 1 })), at: Type.Optional(Type.String()),
      message: Type.String({ minLength: 1, maxLength: 4000 }), execution_id: Type.Optional(Type.String({ minLength: 1 })),
    });
    const create: AgentTool<typeof createParameters> = {
      name: "timer_create", label: "Create timer", parameters: createParameters,
      description: "Create a one-time reminder: exactly one of after_ms or at (ISO timestamp with timezone). It posts a notice, never executes a command or takes a Workspace write lock. Optional execution_id cancels the reminder when that execution finishes. Stopping/archiving cancels pending timers. No recurring timers.",
      execute: async (_id, params) => {
        const value = await options.timers!.create({ afterMs: params.after_ms, at: params.at, message: params.message, executionId: params.execution_id });
        return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
      },
    };
    const list: AgentTool = { name: "timer_list", label: "List timers", parameters: Type.Object({}),
      description: "List this Agent's one-time timers and their pending/fired/cancelled state.",
      execute: async () => { const value = options.timers!.list(); return { content: [{ type: "text", text: JSON.stringify(value) }], details: value }; } };
    const cancelParameters = Type.Object({ timer_id: Type.String({ minLength: 1 }) });
    const cancel: AgentTool<typeof cancelParameters> = { name: "timer_cancel", label: "Cancel timer", parameters: cancelParameters,
      description: "Cancel this Agent's pending reminder; does not cancel its associated execution.",
      execute: async (_id, params) => { const value = options.timers!.cancel(params.timer_id); return { content: [{ type: "text", text: JSON.stringify(value) }], details: value }; } };
    tools.push(create, list, cancel);
  }
  if (options.shellExecutions) {
    const manager = options.shellExecutions;
    const statusParameters = Type.Object({
      execution_id: Type.Optional(Type.String({ minLength: 1 })),
      wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 })),
    });
    const statusTool: AgentTool<typeof statusParameters> = {
      name: "execution_status", label: "Execution status",
      description: "List this Agent's executions, or inspect one by execution_id. Optional wait_ms waits without cancelling the command. No Shell is started and no Workspace write lock is taken. Unknown means inspect before retrying, never automatic replay.",
      parameters: statusParameters,
      execute: async (_id, params, signal) => {
        if (params.wait_ms !== undefined && !params.execution_id) throw new Error("wait_ms requires execution_id");
        const value = params.execution_id
          ? await manager.wait(params.execution_id, params.wait_ms ?? 0, signal)
          : manager.list();
        return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
      },
    };
    tools.push(statusTool);
    const logsParameters = Type.Object({ execution_id: Type.String({ minLength: 1 }), cursor: Type.Optional(Type.Integer({ minimum: 0 })) });
    const logsTool: AgentTool<typeof logsParameters> = {
      name: "execution_logs", label: "Execution logs",
      description: "Read retained stdout/stderr incrementally without a Shell or Workspace write lock. Pass nextCursor to continue; retentionTruncated means older output exceeded the retained budget.",
      parameters: logsParameters,
      execute: async (_id, params) => {
        const value = await manager.logs(params.execution_id, params.cursor);
        return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
      },
    };
    tools.push(logsTool);
    const cancelParameters = Type.Object({ execution_id: Type.String({ minLength: 1 }) });
    const cancelTool: AgentTool<typeof cancelParameters> = {
      name: "execution_cancel", label: "Cancel execution",
      description: "Explicitly request cancellation of this Agent's execution. Query status until termination and version/provenance finalization; this call does not imply the process already stopped.",
      parameters: cancelParameters,
      execute: async (_id, params) => {
        const value = await manager.cancel(params.execution_id);
        return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
      },
    };
    tools.push(cancelTool);
  }
  if (options.environments || options.remoteRunners?.length) {

    const environmentListParameters = Type.Object({ ...machineParameter });
    const environmentList: AgentTool<typeof environmentListParameters> = {
      description: "List shared managed environments on the selected Runner. Choose an environment ID to execute its latest state with run_shell; revisions are audit-only, not execution choices. Use environment_setup to inspect unavailable setup or retry after resolving its cause.",
      execute: async (_toolCallId, _params, signal) => {
        const environments = options.environmentManagement
          ? await options.environmentManagement.list(signal, _params.runner_id)
          : options.environments!;
        return {
          content: [{ type: "text", text: JSON.stringify(environments, null, 2) }],
          details: { environments },
        };
      },
      isConcurrencySafe: () => true,
      label: "List scientific environments",
      name: ENVIRONMENT_TOOL_NAMES.list,
      parameters: environmentListParameters,
    };
    tools.push(environmentList);

    if (options.environmentManagement) {
      if (options.environmentManagement.setup) {
        const setupParameters = Type.Object({
          ...machineParameter,
          retry: Type.Optional(Type.Boolean({ description: "False/omitted reads setup progress and errors. True explicitly starts or retries managed Python base setup; package downloads may take time." })),
        });
        tools.push({
          description: "Read scientific environment setup status on the selected Runner, including micromamba/Conda failure details and recovery actions, or explicitly retry setup. No workspace files are deleted.",
          execute: async (_toolCallId, params, signal) => {
            const setup = await options.environmentManagement!.setup!(params.retry === true, signal, params.runner_id);
            return { content: [{ type: "text", text: JSON.stringify(setup, null, 2) }], details: { setup } };
          },
          label: "Scientific environment setup",
          name: "environment_setup",
          parameters: setupParameters,
        } satisfies AgentTool<typeof setupParameters>);
      }
      const createParameters = Type.Object({
        ...machineParameter,
        baseEnvironmentId: Type.Optional(Type.String({ minLength: 1 })),
        language: Type.Union([Type.Literal("python"), Type.Literal("r")]),
        name: Type.String({ maxLength: 80, minLength: 1 }),
      });
      const createEnvironment: AgentTool<typeof createParameters> = {
        description: "Create a named environment on the selected Runner by cloning its matching read-only base or an explicitly selected base environment. Environment IDs and revisions belong to that Runner.",
        execute: async (_toolCallId, params, signal) => {
          const { runner_id, ...input } = params;
          const environment = await options.environmentManagement!.create(input, signal, runner_id);
          return {
            content: [{ type: "text", text: JSON.stringify(environment, null, 2) }],
            details: { environment },
          };
        },
        label: "Create scientific environment",
        name: ENVIRONMENT_TOOL_NAMES.create,
        parameters: createParameters,
      };
      tools.push(createEnvironment);

      const deleteParameters = Type.Object({ ...machineParameter, environmentId: Type.String({ minLength: 1 }) });
      const deleteEnvironment: AgentTool<typeof deleteParameters> = {
        description: "Delete a named environment. Read-only base environments cannot be deleted.",
        execute: async (_toolCallId, params, signal) => {
          await options.environmentManagement!.delete(params.environmentId, signal, params.runner_id);
          const result = { deleted: params.environmentId };
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
        label: "Delete scientific environment",
        name: ENVIRONMENT_TOOL_NAMES.delete,
        parameters: deleteParameters,
      };
      tools.push(deleteEnvironment);

      const installParameters = Type.Object({
        ...machineParameter,
        channels: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
          description: "Conda channels only; every channel must be allowed by system policy. Omit for pip.",
          maxItems: 16,
        })),
        environmentId: Type.String({ minLength: 1 }),
        indexUrl: Type.Optional(Type.String({
          description: "HTTPS pip index URL for this installation (equivalent to pip --index-url). Valid only with manager=pip and overrides the global pip source.",
          maxLength: 2_048,
          minLength: 1,
        })),
        manager: Type.Optional(Type.Union([Type.Literal("conda"), Type.Literal("pip")], {
          description: "Defaults to conda. pip is available only for Python environments.",
        })),
        packages: Type.Array(Type.String({ maxLength: 512, minLength: 1 }), {
          description: "Conda specs (for example numpy=2.0), pip PyPI specs (for example mindspore==2.7.0), or with manager=pip a current-workspace relative .whl path.",
          maxItems: 128,
          minItems: 1,
        }),
      });
      const installEnvironment: AgentTool<typeof installParameters> = {
        description: "Install packages on the selected Runner: conda specs or, in Python environments, pip PyPI specs/current-workspace relative .whl files. Remote wheels must first be explicitly pushed to that Runner's workspace. For pip, indexUrl overrides the global pip source. Wheels are retained by SHA-256 for revision audit. Success creates an immutable revision; base environments are read-only.",
        execute: async (_toolCallId, params, signal) => {
          const revision = await options.environmentManagement!.install(params.environmentId, {
            ...(params.channels ? { channels: params.channels } : {}),
            ...(params.indexUrl ? { indexUrl: params.indexUrl } : {}),
            manager: params.manager ?? "conda",
            packages: params.packages,
          }, signal, params.runner_id);
          return {
            content: [{ type: "text", text: JSON.stringify(revision, null, 2) }],
            details: { revision },
          };
        },
        label: "Install environment packages",
        name: ENVIRONMENT_TOOL_NAMES.install,
        parameters: installParameters,
      };
      tools.push(installEnvironment);

      const uninstallParameters = Type.Object({
        ...machineParameter,
        environmentId: Type.String({ minLength: 1 }),
        packages: Type.Array(Type.String({ maxLength: 160, minLength: 1 }), { maxItems: 128, minItems: 1 }),
      });
      const uninstallEnvironment: AgentTool<typeof uninstallParameters> = {
        description: "Remove conda package specifications from a named environment. Success creates a new immutable revision; base environments are read-only.",
        execute: async (_toolCallId, params, signal) => {
          const revision = await options.environmentManagement!.uninstall(params.environmentId, { packages: params.packages }, signal, params.runner_id);
          return {
            content: [{ type: "text", text: JSON.stringify(revision, null, 2) }],
            details: { revision },
          };
        },
        label: "Uninstall environment packages",
        name: ENVIRONMENT_TOOL_NAMES.uninstall,
        parameters: uninstallParameters,
      };
      tools.push(uninstallEnvironment);
    }
  }
  const selectedSkillsForDiscovery = options.skills ?? [];
  if (selectedSkillsForDiscovery.length) {
    const skillLiterals = selectedSkillsForDiscovery.map((skill) => Type.Literal(skill.id));
    const skillIdSchema = Type.Union(skillLiterals as [typeof skillLiterals[number], ...typeof skillLiterals]);
    const selectedSkills = new Map(selectedSkillsForDiscovery.map((skill) => [skill.id, skill]));
    const readSkillParameters = Type.Object({
      skillId: skillIdSchema,
    });
    const readSkill: AgentTool<typeof readSkillParameters> = {
      description: "Load the full frozen SKILL.md instructions for an explicitly selected skill revision. Call this only after the task appears to match the skill name or description.",
      execute: async (_toolCallId, params) => {
        const skill = selectedSkills.get(params.skillId);
        if (!skill) throw new Error(`Skill ${params.skillId} is not selected for this run`);
        loadedSkillIds.add(skill.id);
        const resources = skill.resources.length
          ? `\n\n${skill.packagePath
            ? `Complete frozen package: ${skill.packagePath}\nAvailable resources (read referenced text or execute scripts directly from this read-only package):`
            : "Available resources (use read_skill_resource for referenced text):"}\n${skill.resources.map((resource) => `- ${resource.path} (${resource.kind}, ${resource.size} bytes)`).join("\n")}`
          : "";
        return {
          content: [{ type: "text", text: [
            `Selected skill ${skill.id}@${skill.version} (revision ${skill.revision})`,
            `Description: ${skill.description}`,
            "",
            skill.content,
            resources,
          ].join("\n") }],
          details: {
            description: skill.description,
            hash: skill.hash,
            id: skill.id,
            ...(skill.packagePath ? { packagePath: skill.packagePath } : {}),
            resources: skill.resources,
            revision: skill.revision,
            version: skill.version,
          },
        };
      },
      isConcurrencySafe: () => true,
      label: "Read skill",
      name: "read_skill",
      parameters: readSkillParameters,
    };
    tools.push(readSkill);
  }
  const skillsWithResources = selectedSkillsForDiscovery.filter((skill) => skill.resources.length);
  if (skillsWithResources.length) {
    const skillLiterals = skillsWithResources.map((skill) => Type.Literal(skill.id));
    const skillResourceParameters = Type.Object({
      path: Type.String({ minLength: 1 }),
      skillId: Type.Union(skillLiterals as [typeof skillLiterals[number], ...typeof skillLiterals]),
    });
    const skillsWithResourceIds = new Map(skillsWithResources.map((skill) => [skill.id, skill]));
    const readSkillResource: AgentTool<typeof skillResourceParameters> = {
      description: "Read a bounded UTF-8 resource from an explicitly selected skill revision. Files are returned as data and are never executed or installed.",
      execute: async (_toolCallId, params) => {
        const skill = skillsWithResourceIds.get(params.skillId);
        if (!skill) {
          // Two different situations, and telling them apart matters: a skill
          // whose only file is SKILL.md is selected and working, it simply has
          // nothing else to read. Reporting that as "not selected" reads as
          // "this skill is unavailable", and a caller that believes it goes on
          // to doubt everything the skill just told it.
          const selected = selectedSkillsForDiscovery.some((entry) => entry.id === params.skillId);
          throw new Error(selected
            ? `Skill ${params.skillId} has no supporting resources; its SKILL.md is the whole skill`
            : `Skill ${params.skillId} is not selected for this run`);
        }
        const result = await skill.readResource(params.path);
        return {
          content: [{ type: "text", text: result.content }],
          details: result,
        };
      },
      isConcurrencySafe: () => true,
      label: "Read skill resource",
      name: "read_skill_resource",
      parameters: skillResourceParameters,
    };
    tools.push(readSkillResource);
  }
  if (options.createSkill && selectedSkillsForDiscovery.some((skill) => skill.id === "skill-creator")) {
    const createSkillParameters = Type.Object({
      allowedTools: Type.Optional(Type.String({ maxLength: 2_000, minLength: 1 })),
      compatibility: Type.Optional(Type.String({ maxLength: 500, minLength: 1 })),
      description: Type.String({ maxLength: 1_024, minLength: 1 }),
      instructions: Type.String({ maxLength: 524_288, minLength: 1 }),
      license: Type.Optional(Type.String({ maxLength: 500, minLength: 1 })),
      name: Type.String({ maxLength: 64, minLength: 1, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
      resources: Type.Optional(Type.Array(Type.Object({
        content: Type.String({ maxLength: 1_000_000, minLength: 1 }),
        path: Type.String({ maxLength: 240, minLength: 1 }),
      }), { maxItems: 50 })),
      version: Type.Optional(Type.String({ maxLength: 100, minLength: 1 })),
    });
    const createSkill: AgentTool<typeof createSkillParameters> = {
      description: "Create a reviewable Agent Skill proposal from an explicit user request. First load skill-creator with read_skill and follow it. Revisions or alternative versions of one logical Skill must reuse the exact same name so they join one version history. The draft remains inactive until the user edits and confirms it; never call this merely because a workflow seems reusable.",
      execute: async (_toolCallId, params, signal) => {
        if (!loadedSkillIds.has("skill-creator")) {
          throw new Error("Load skill-creator with read_skill before creating a Skill");
        }
        const created = await options.createSkill!({
          ...(params.allowedTools ? { allowedTools: params.allowedTools } : {}),
          ...(params.compatibility ? { compatibility: params.compatibility } : {}),
          description: params.description,
          instructions: params.instructions,
          ...(params.license ? { license: params.license } : {}),
          ...(params.version ? { metadata: { version: params.version } } : {}),
          name: params.name,
          ...(params.resources ? { resources: params.resources } : {}),
        }, signal);
        return {
          content: [{
            type: "text",
            text: `${JSON.stringify(created, null, 2)}\n\nThe Skill is a pending draft and is not active yet. Ask the user to open Settings > Skills, review the files and diff, then confirm or discard it.`,
          }],
          details: created,
        };
      },
      label: "Create Skill draft",
      name: "create_skill",
      parameters: createSkillParameters,
    };
    tools.push(createSkill);
  }
  for (const mcpTool of options.mcpTools ?? []) {
    tools.push({
      deferred: true,
      description: mcpTool.description,
      execute: async (toolCallId, params, signal) => {
        const result = await mcpTool.execute(toolCallId, params as JsonValue, signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
      label: mcpTool.displayName,
      mcp: { sourceId: mcpTool.sourceId, toolId: mcpTool.toolId },
      name: mcpTool.name,
      parameters: mcpTool.inputSchema as TSchema,
      routing: mcpTool.routing,
    });
  }
  if (options.artifactDownload) {
    const artifactDownloadParameters = Type.Object({
      candidateId: Type.String({ minLength: 1 }),
      destinationPath: Type.Optional(Type.String({ minLength: 1 })),
      mcpInvocationId: Type.String({ minLength: 1 }),
    });
    const artifactDownload: AgentTool<typeof artifactDownloadParameters> = {
      description: "Download one ArtifactCandidate returned by a previous MCP tool call into the governed Session workspace. This call waits for permission and download completion. It does not extract or read PDF contents.",
      execute: async (_toolCallId, params, signal) => {
        const result = await options.artifactDownload!(params, signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
      label: "Download artifact",
      name: "artifact_download",
      parameters: artifactDownloadParameters,
    };
    tools.push(artifactDownload);
  }
  if (options.paperExtractPdf) {
    const extractPdfParameters = Type.Object({
      artifactJobId: Type.String({ minLength: 1 }),
    });
    const extractPdf: AgentTool<typeof extractPdfParameters> = {
      description: "Extract text, tables, and page metadata from a completed PDF artifact download. Call this only after artifact_download has returned a completed artifactJobId.",
      execute: async (_toolCallId, params, signal) => {
        const result = await options.paperExtractPdf!(params, signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
      label: "Extract PDF",
      name: "paper_extract_pdf",
      parameters: extractPdfParameters,
    };
    tools.push(extractPdf);
  }
  return filterTools(tools, options.toolPolicy);
}

export function resolveWorkspaceFile(workspaceRoot: string, path: string): string {
  return assertWorkspacePath(workspaceRoot, path);
}

export function normalizeWorkspaceRelativePath(workspaceRoot: string, path: string): string {
  const root = resolve(workspaceRoot);
  return relative(root, assertWorkspacePath(root, path)).split(sep).join("/");
}

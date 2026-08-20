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

import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AgentTool } from "@science-agent/tools";
import type {
  ArtifactDownloadResult,
  ArtifactReadResult,
  ConnectorId,
  CreateEnvironmentRequest,
  CreateNpuJobRequest,
  CreateRemoteJobRequest,
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
  PythonExecutionResult,
  RemoteHostTarget,
  RemoteJob,
  ReviewCheckpointRequest,
  ReviewCheckpointResult,
  ScientificArtifact,
  ScientificArtifactVersion,
  ScientificExecutionResult,
  ScientificLanguage,
  SessionPlan,
  SkillResource,
  SkillResourceContent,
  ShellExecutionResult,
  UninstallEnvironmentRequest,
} from "@science-agent/schema";
import { Type, type TSchema } from "typebox";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
  GENERAL_PURPOSE_SUBAGENT,
  MAX_SUBAGENT_MAX_TURNS,
  MAX_SUBAGENT_TIMEOUT_SECONDS,
} from "@science-agent/orchestration";
import { ENVIRONMENT_TOOL_NAMES } from "./environment-tool-names.js";

export interface WorkspaceFileInfo {
  modifiedAt: string;
  path: string;
  size: number;
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

const MAX_FILE_BYTES = 1_000_000;
const MAX_DECLARE_ARTIFACT_PATHS = 50;
const MAX_SKILL_SEARCH_RESULTS = 5;
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
  declareArtifact?: (input: {
    description?: string;
    name?: string;
    path: string;
  }) => Promise<{ artifact: ScientificArtifact; version: ScientificArtifactVersion; instruction?: string }>;
  enabledConnectorIds: ConnectorId[];
  executePython: (code: string, signal?: AbortSignal) => Promise<PythonExecutionResult>;
  executeShell?: (code: string, kernelMode: KernelMode, signal?: AbortSignal) => Promise<ShellExecutionResult>;
  executeScientific?: (
    language: ScientificLanguage,
    code: string,
    environmentRevisionId: string | undefined,
    kernelMode: KernelMode,
    signal?: AbortSignal,
  ) => Promise<ScientificExecutionResult>;
  environments?: Environment[];
  environmentManagement?: {
    create: (input: CreateEnvironmentRequest, signal?: AbortSignal) => Promise<Environment>;
    delete: (environmentId: string, signal?: AbortSignal) => Promise<void>;
    install: (environmentId: string, input: InstallEnvironmentRequest, signal?: AbortSignal) => Promise<EnvironmentRevision>;
    list: (signal?: AbortSignal) => Promise<Environment[]>;
    uninstall: (environmentId: string, input: UninstallEnvironmentRequest, signal?: AbortSignal) => Promise<EnvironmentRevision>;
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
  npuBroker?: {
    cancel: (jobId: string, signal?: AbortSignal) => Promise<NpuJob>;
    get: (jobId: string, signal?: AbortSignal) => Promise<NpuJob>;
    listWorkloads: (signal?: AbortSignal) => Promise<NpuWorkloadDescriptor[]>;
    logs: (jobId: string, signal?: AbortSignal) => Promise<NpuJobLogs>;
    result: (jobId: string, signal?: AbortSignal) => Promise<NpuJobResult>;
    submit: (
      input: Omit<CreateNpuJobRequest, "sessionId" | "workspaceRoot">,
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
  remoteHosts?: RemoteHostTarget[];
  proposeRemoteJob?: (input: CreateRemoteJobRequest) => Promise<RemoteJob>;
  proposePlan?: (
    input: { caveats?: string[]; feasibilityConfidence: "high" | "low" | "medium"; scope: string; steps: string[] },
    signal?: AbortSignal,
  ) => Promise<SessionPlan>;
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
  readArtifact?: (input: { artifactId?: string; name?: string; version?: number }) => Promise<ArtifactReadResult>;
  reviewCheckpoint?: (
    input: ReviewCheckpointRequest,
    signal?: AbortSignal,
    toolCallId?: string,
  ) => Promise<ReviewCheckpointResult>;
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

function normalizeMountedReadPath(requestedPath: string): {
  path: string;
  root: "parent" | "workspace";
} {
  const path = requestedPath.trim();
  if (path === "/parent_workspace") return { path: ".", root: "parent" };
  if (path.startsWith("/parent_workspace/")) return { path: path.slice("/parent_workspace/".length), root: "parent" };
  if (path === "/workspace") return { path: ".", root: "workspace" };
  if (path.startsWith("/workspace/")) return { path: path.slice("/workspace/".length), root: "workspace" };
  return { path, root: "workspace" };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function compileSkillSearchRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

function searchSkills<T extends { description: string; id: string }>(skills: readonly T[], query: string): T[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("select:")) {
    const wanted = new Set(trimmed.slice("select:".length).split(",").map((name) => name.trim()).filter(Boolean));
    return skills.filter((skill) => wanted.has(skill.id));
  }
  if (trimmed.startsWith("+")) {
    const [required = "", ...rest] = trimmed.slice(1).split(/\s+/);
    if (!required) return [];
    const candidates = skills.filter((skill) => skill.id.toLowerCase().includes(required.toLowerCase()));
    if (rest.length) {
      const regex = compileSkillSearchRegex(rest.join(" "));
      candidates.sort((left, right) => (
        (right.id.match(regex)?.length ?? 0) + (right.description.match(regex)?.length ?? 0)
        - (left.id.match(regex)?.length ?? 0) - (left.description.match(regex)?.length ?? 0)
      ));
    }
    return candidates.slice(0, MAX_SKILL_SEARCH_RESULTS);
  }
  const regex = compileSkillSearchRegex(trimmed);
  return skills
    .map((skill) => {
      const nameMatch = regex.test(skill.id);
      const descriptionMatch = regex.test(skill.description);
      return { score: nameMatch ? 2 : descriptionMatch ? 1 : 0, skill };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((item) => item.skill)
    .slice(0, MAX_SKILL_SEARCH_RESULTS);
}

function renderSkillMetadata(skill: NonNullable<WorkspaceToolOptions["skills"]>[number]): string {
  const resources = skill.resources.length
    ? skill.resources.map((resource) => `  - ${resource.path} (${resource.kind}, ${resource.size} bytes)`).join("\n")
    : "  (none)";
  return [
    `## Skill: ${skill.id}`,
    `- Description: ${skill.description}`,
    `- Version: ${skill.version}`,
    `- Revision: ${skill.revision}`,
    `- Package hash: ${skill.hash}`,
    "- Supporting resources:",
    resources,
    `- Load instructions: call read_skill with skillId="${skill.id}"`,
  ].join("\n");
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

export async function scanWorkspace(workspaceRoot: string): Promise<WorkspaceFileInfo[]> {
  await mkdir(workspaceRoot, { recursive: true });
  const files: WorkspaceFileInfo[] = [];

  async function visit(directory: string): Promise<void> {
    if (files.length >= 500) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= 500) break;
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
  return files;
}

export function createWorkspaceTools(workspaceRoot: string, options: WorkspaceToolOptions): AgentTool[] {
  const emptyParameters = Type.Object({});
  const pathParameters = Type.Object({ path: Type.String({ minLength: 1 }) });
  const readOnlyWorkspaceRoot = options.readOnlyWorkspaceRoot
    && resolve(options.readOnlyWorkspaceRoot) !== resolve(workspaceRoot)
    ? options.readOnlyWorkspaceRoot
    : undefined;

  const pythonParameters = Type.Object({
    code: Type.String({ minLength: 1 }),
    environmentRevisionId: Type.Optional(Type.String({ minLength: 1 })),
    kernelMode: Type.Optional(Type.Union([Type.Literal("ephemeral"), Type.Literal("persistent")])),
  });
  const listFiles: AgentTool<typeof emptyParameters> = {
    description: "List files in the current session workspace",
    execute: async () => {
      const files = await scanWorkspace(workspaceRoot);
      const readOnlyFiles = readOnlyWorkspaceRoot ? await scanWorkspace(readOnlyWorkspaceRoot) : [];
      if (readOnlyWorkspaceRoot) {
        const text = [
          files.length ? `Writable workspace:\n${files.map((file) => file.path).join("\n")}` : "Writable workspace is empty",
          readOnlyFiles.length ? `Read-only parent workspace:\n${readOnlyFiles.map((file) => file.path).join("\n")}` : "Read-only parent workspace is empty",
        ].join("\n\n");
        return {
          content: [{ type: "text", text }],
          details: { files, readOnlyFiles },
        };
      }
      return {
        content: [{ type: "text", text: files.length ? files.map((file) => file.path).join("\n") : "Workspace is empty" }],
        details: { files },
      };
    },
    label: "List workspace files",
    name: "list_files",
    parameters: emptyParameters,
  };

  const readWorkspaceFile: AgentTool<typeof pathParameters> = {
    description: "Read a UTF-8 text file from the current session workspace",
    execute: async (_toolCallId, params) => {
      const requested = normalizeMountedReadPath(params.path);
      const roots = requested.root === "parent"
        ? readOnlyWorkspaceRoot ? [readOnlyWorkspaceRoot] : []
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
        throw new Error("Read-only parent workspace is unavailable");
      }
      if (metadata.size > MAX_FILE_BYTES) throw new Error("File exceeds the 1 MB M0 read limit");
      const content = await readFile(path, "utf8");
      return { content: [{ type: "text", text: content }], details: { path: requested.path } };
    },
    label: "Read workspace file",
    name: "read_file",
    parameters: pathParameters,
  };

  const artifactTools: AgentTool[] = [];
  if (options.listArtifacts) {
    artifactTools.push({
      description: "List user-visible artifacts for the current Project across all Sessions, including origin and latest version metadata.",
      execute: async () => {
        const artifacts = await options.listArtifacts!();
        return { content: [{ type: "text", text: JSON.stringify(artifacts) }], details: { artifacts } };
      },
      label: "List project artifacts",
      name: "list_artifacts",
      parameters: emptyParameters,
    });
  }
  if (options.readArtifact) {
    const parameters = Type.Object({
      artifact_id: Type.Optional(Type.String({ minLength: 1 })),
      name: Type.Optional(Type.String({ minLength: 1 })),
      version: Type.Optional(Type.Integer({ minimum: 1 })),
    });
    const readArtifact: AgentTool<typeof parameters> = {
      description: "Read a Project artifact by artifact_id or name, optionally selecting a version. Text is UTF-8; binary content is base64. At least one identifier is required.",
      execute: async (_toolCallId, params) => {
        if (!params.artifact_id && !params.name) throw new Error("artifact_id or name is required");
        const result = await options.readArtifact!({
          ...(params.artifact_id ? { artifactId: params.artifact_id } : {}),
          ...(params.name ? { name: params.name } : {}),
          ...(params.version ? { version: params.version } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
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

  const runPythonTool: AgentTool<typeof pythonParameters> = {
    description: "Run Python in the current session workspace. Optionally select an Environment Revision and persistent kernel; ephemeral is the default. Save useful outputs as workspace files.",
    execute: async (_toolCallId, params, signal) => {
      const result = options.executeScientific
        ? await options.executeScientific(
          "python",
          params.code,
          params.environmentRevisionId,
          params.kernelMode ?? "ephemeral",
          signal,
        )
        : await options.executePython(params.code, signal);
      if (result.exitCode !== 0) {
        throw new Error(`Python exited with ${result.exitCode}: ${result.stderr || result.stdout}`);
      }
      const summary = [
        result.stdout ? `stdout:\n${result.stdout}` : "stdout: (empty)",
        result.stderr ? `stderr:\n${result.stderr}` : "stderr: (empty)",
        `created files: ${result.createdFiles.join(", ") || "none"}`,
      ].join("\n");
      return { content: [{ type: "text", text: summary }], details: result };
    },
    label: "Run Python",
    name: "run_python",
    parameters: pythonParameters,
  };

  const tools: AgentTool[] = [listFiles, readWorkspaceFile, ...artifactTools, runPythonTool];
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
      environment_revision_id: Type.Optional(Type.String({
        description: "ScienceDiscovery scientific environment revision for workloads that require managed Python. Omit to use the Session's selected revision.",
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
        "For a workload with requiresEnvironmentRevision=true, verify a ScienceDiscovery managed environment first and pass its revision as environment_revision_id; omitting it uses the Session-selected revision.",
        "Use status/logs/result/cancel with job_id after submission.",
        "When operation=result returns job.createdFiles, those workspace files are automatically declared as Project artifacts when artifact declaration is available; otherwise call declare_artifact on those exact paths.",
        "Do not use run_shell to access /home, source host env.sh, write host_launch_request.json, or expect NPU devices inside bwrap.",
      ].join(" "),
      execute: async (_toolCallId, params, signal) => {
        const broker = options.npuBroker!;
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
          const environmentRevisionId = params.environment_revision_id?.trim();
          const job = await broker.submit({
            ...(environmentRevisionId ? { environmentRevisionId } : {}),
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
      label: "Fetch web page",
      name: "web_fetch",
      parameters,
    };
    tools.push(webFetch);
  }
  if (options.proposePlan) {
    const planParameters = Type.Object({
      caveats: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 10 })),
      feasibilityConfidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
      scope: Type.String({ maxLength: 2_000, minLength: 1 }),
      steps: Type.Array(Type.String({ maxLength: 1_000, minLength: 1 }), { maxItems: 20, minItems: 1 }),
    });
    const proposePlan: AgentTool<typeof planParameters> = {
      description: "Record a multi-phase plan with explicit scope and feasibility confidence. Plans are progress records and do not block subsequent execution.",
      execute: async (_toolCallId, params, signal) => {
        const plan = await options.proposePlan!(params, signal);
        return { content: [{ type: "text", text: JSON.stringify(plan) }], details: plan };
      },
      label: "Propose plan",
      name: "propose_plan",
      parameters: planParameters,
    };
    tools.push(proposePlan);
  }
  if (options.queryGraph) {
    const queryGraphParameters = Type.Object({ query: Type.String({ minLength: 1 }) });
    const queryGraph: AgentTool<typeof queryGraphParameters> = {
      description: "Browse this session's memory-graph nodes (ResearchGoal/SubTask/Paper/Evidence/Claim/Code/Artifact) by keyword. Returns {hits, total, truncated}. Matching is term-OR: the query is split into words and a node matches if its text contains ANY word; nodes matching more words rank higher. Use it to see what has already been searched (Papers) or produced (Artifacts/Evidence) in this session. This is an exploratory read, not an id lookup — to cite a node, use the id returned by declare_evidence/declare_artifact, or list_artifacts for an existing Artifact. Give concrete entity terms that appear in the graph (e.g. 'TP53 NSCLC'), not meta-words like 'paper' or 'evidence'.",
      execute: async (_toolCallId, params) => {
        const result = await options.queryGraph!(params.query);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
      label: "Query memory graph",
      name: "query_graph",
      parameters: queryGraphParameters,
    };
    tools.push(queryGraph);
  }
  if (options.declareEvidence) {
    const declareEvidenceParameters = Type.Object({
      content: Type.String({ minLength: 1 }),
      source_paper_link: Type.String({ minLength: 1 }),
      locator: Type.String({ minLength: 1 }),
      evidence_type: Type.String(),
      confidence: Type.String(),
      strength: Type.String(),
    });
    const declareEvidence: AgentTool<typeof declareEvidenceParameters> = {
      description: "Record a piece of Evidence extracted from a Paper that already exists in this session's memory graph. Creates an Evidence node + an extracted_from edge to the source Paper. Returns {status:'ok', evidence_id} or a structured error (source_paper_not_found when the Paper link is unknown). Use the returned evidence_id as the chip alias target in declare_claim's cites_evidence_aliases and write [evidenceN] in your report body.",
      execute: async (_toolCallId, params) => {
        const result = await options.declareEvidence!({
          content: params.content,
          sourcePaperLink: params.source_paper_link,
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
      artifact_id: Type.Optional(Type.String({ minLength: 1 })),
    });
    const declareClaim: AgentTool<typeof declareClaimParameters> = {
      description: "Record a Claim (a cited assertion) and link it to its supporting nodes. Creates a Claim node + cites edges to the cited Evidence/Artifact. At least one citation target is required. A Claim cites Evidence/Artifact — it does NOT cite a Paper directly: to cite a paper, call declare_evidence first and cite the returned evidence_id here. Choose aliases of the form evidence+number for Evidence (e.g. [evidence1]) or artifact+number for Artifact (e.g. [artifact1]) — no other format. Write each chosen alias token inline in the output body where the claim is asserted; a chip renders only when a [alias] token in the body matches this claim's chip_map.",
      execute: async (_toolCallId, params) => {
        const result = await options.declareClaim!({
          content: params.content,
          claimType: params.claim_type,
          confidence: params.confidence,
          locator: params.locator,
          citesEvidenceAliases: params.cites_evidence_aliases,
          citesArtifactAliases: params.cites_artifact_aliases,
          ...(params.artifact_id ? { artifactId: params.artifact_id } : {}),
        });
        // Surface a reminder to write the alias tokens into the output body
        // now (with the allowed format) — a chip renders only when a [alias]
        // token in the body matches this claim's chip_map. On error, forward
        // the sidecar's actionable instruction so the LLM can self-correct.
        const instruction = result.status === "ok" && Object.keys(result.chipMap).length
          ? `Write these alias tokens inline in the output body now, where each claim is asserted: ${Object.keys(result.chipMap).map((alias) => `[${alias}]`).join(", ")}. Aliases must be evidence+number for evidence (e.g. [evidence1]) or artifact+number for artifacts (e.g. [artifact1]) — no other format.`
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
      execute: async (_toolCallId, params, signal) => {
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
      label: "Review artifact checkpoint",
      name: "review_checkpoint",
      parameters: reviewCheckpointParameters,
    };
    tools.push(reviewCheckpoint);
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
  const readyRemoteHosts = (options.remoteHosts ?? []).filter((host) => host.status === "ready");
  if (options.proposeRemoteJob && readyRemoteHosts.length) {
    const hostLiterals = readyRemoteHosts.map((host) => Type.Literal(host.id));
    const remoteJobParameters = Type.Object({
      command: Type.String({ maxLength: 50_000, minLength: 1 }),
      hostId: Type.Union(hostLiterals as [typeof hostLiterals[number], ...typeof hostLiterals]),
      inputPaths: Type.Optional(Type.Array(Type.String({ maxLength: 2_000, minLength: 1 }), { maxItems: 50 })),
      mode: Type.Union([Type.Literal("ssh"), Type.Literal("slurm")]),
      outputs: Type.Optional(Type.Array(Type.Object({
        disposition: Type.Union([Type.Literal("pull"), Type.Literal("remote")]),
        path: Type.String({ maxLength: 2_000, minLength: 1 }),
      }), { maxItems: 20 })),
      remoteWorkingDirectory: Type.String({ maxLength: 2_000, minLength: 1 }),
      resources: Type.Object({
        cpus: Type.Integer({ maximum: 1_024, minimum: 1 }),
        gpus: Type.Integer({ maximum: 64, minimum: 0 }),
        memoryMb: Type.Integer({ maximum: 16 * 1024 * 1024, minimum: 64 }),
        partition: Type.Optional(Type.String({ maxLength: 80, minLength: 1 })),
        walltimeMinutes: Type.Integer({ maximum: 7 * 24 * 60, minimum: 1 }),
      }),
    });
    const proposeRemoteJob: AgentTool<typeof remoteJobParameters> = {
      description: `${options.approvalMode === "always_allow" ? "Create and immediately submit" : "Create an independent approval card for"} an SSH or SLURM job. Remote paths are used in place; mark only small results as pull and large or sensitive outputs as remote. Available targets: ${readyRemoteHosts.map((host) => `${host.id} (${host.alias}, SLURM=${host.capabilities?.slurm ?? false})`).join("; ")}`,
      execute: async (_toolCallId, params) => {
        const job = await options.proposeRemoteJob!(params);
        return { content: [{ type: "text", text: JSON.stringify(job) }], details: job };
      },
      label: "Propose remote job",
      name: "propose_remote_job",
      parameters: remoteJobParameters,
    };
    tools.push(proposeRemoteJob);
  }
  if (options.executeShell) {
    const shellParameters = Type.Object({
      arguments: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 32 })),
      command: Type.Optional(Type.String({ maxLength: 20_000, minLength: 1 })),
      kernelMode: Type.Optional(Type.Union([Type.Literal("ephemeral"), Type.Literal("persistent")])),
      scriptPath: Type.Optional(Type.String({ maxLength: 1_000, minLength: 1 })),
    });
    const runShell: AgentTool<typeof shellParameters> = {
      description: "Run a bounded shell command or an existing shell script from the authorized Session workspace. Provide exactly one of command or scriptPath; scriptPath is executed without rewriting it. By default the Session's persistent shell session is used, so cd/export/source carry over to later run_shell calls and whitelisted variables also reach run_python/run_r; pass kernelMode=ephemeral for a one-off clean shell. Network is denied and host paths outside authorized mounts are unavailable.",
      execute: async (_toolCallId, params, signal) => {
        if (Boolean(params.command) === Boolean(params.scriptPath)) {
          throw new Error("Provide exactly one of command or scriptPath");
        }
        let code = params.command?.trim() ?? "";
        if (params.scriptPath) {
          const resolvedPath = assertWorkspacePath(workspaceRoot, params.scriptPath);
          const metadata = await stat(resolvedPath);
          if (!metadata.isFile()) throw new Error("scriptPath must reference a workspace file");
          const normalizedPath = relative(resolve(workspaceRoot), resolvedPath).split(sep).join("/");
          code = ["/usr/bin/bash", shellQuote(normalizedPath), ...(params.arguments ?? []).map(shellQuote)].join(" ");
        }
        const result = await options.executeShell!(code, params.kernelMode ?? "persistent", signal);
        if (result.exitCode !== 0) throw new Error(`Shell exited with ${result.exitCode}: ${result.stderr || result.stdout}`);
        return {
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
  if (options.executeScientific && options.environments) {
    const rParameters = Type.Object({
      code: Type.String({ minLength: 1 }),
      environmentRevisionId: Type.Optional(Type.String({ minLength: 1 })),
      kernelMode: Type.Optional(Type.Union([Type.Literal("ephemeral"), Type.Literal("persistent")])),
    });
    const runR: AgentTool<typeof rParameters> = {
      description: "Run R in the current session workspace using a managed R Environment Revision. Prefer R for R-native statistical or Bioconductor workflows.",
      execute: async (_toolCallId, params, signal) => {
        const result = await options.executeScientific!(
          "r",
          params.code,
          params.environmentRevisionId,
          params.kernelMode ?? "ephemeral",
          signal,
        );
        if (result.exitCode !== 0) throw new Error(`R exited with ${result.exitCode}: ${result.stderr || result.stdout}`);
        return {
          content: [{ type: "text", text: [
            result.stdout ? `stdout:\n${result.stdout}` : "stdout: (empty)",
            result.stderr ? `stderr:\n${result.stderr}` : "stderr: (empty)",
            `created files: ${result.createdFiles.join(", ") || "none"}`,
            `environment revision: ${result.environmentRevisionId}`,
            `kernel mode: ${result.kernelMode}`,
          ].join("\n") }],
          details: result,
        };
      },
      label: "Run R",
      name: "run_r",
      parameters: rParameters,
    };
    tools.push(runR);

    const environmentList: AgentTool<typeof emptyParameters> = {
      description: "List the shared read-only base and named scientific environments with their current immutable revision IDs.",
      execute: async (_toolCallId, _params, signal) => {
        const environments = options.environmentManagement
          ? await options.environmentManagement.list(signal)
          : options.environments!;
        return {
          content: [{ type: "text", text: JSON.stringify(environments, null, 2) }],
          details: { environments },
        };
      },
      label: "List scientific environments",
      name: ENVIRONMENT_TOOL_NAMES.list,
      parameters: emptyParameters,
    };
    tools.push(environmentList);

    if (options.environmentManagement) {
      const createParameters = Type.Object({
        baseEnvironmentId: Type.Optional(Type.String({ minLength: 1 })),
        language: Type.Union([Type.Literal("python"), Type.Literal("r")]),
        name: Type.String({ maxLength: 80, minLength: 1 }),
      });
      const createEnvironment: AgentTool<typeof createParameters> = {
        description: "Create a globally shared named environment by cloning the matching read-only base or an explicitly selected base environment.",
        execute: async (_toolCallId, params, signal) => {
          const environment = await options.environmentManagement!.create(params, signal);
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

      const deleteParameters = Type.Object({ environmentId: Type.String({ minLength: 1 }) });
      const deleteEnvironment: AgentTool<typeof deleteParameters> = {
        description: "Delete a named environment. Read-only base environments cannot be deleted.",
        execute: async (_toolCallId, params, signal) => {
          await options.environmentManagement!.delete(params.environmentId, signal);
          const result = { deleted: params.environmentId };
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
        label: "Delete scientific environment",
        name: ENVIRONMENT_TOOL_NAMES.delete,
        parameters: deleteParameters,
      };
      tools.push(deleteEnvironment);

      const installParameters = Type.Object({
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
        description: "Install conda specs or, in Python environments, pip PyPI specs/current-workspace relative .whl files. For pip, indexUrl safely provides a one-time HTTPS package index that overrides the global pip source. Local wheels are retained by SHA-256 for revision audit. Success creates a new immutable revision; base environments are read-only.",
        execute: async (_toolCallId, params, signal) => {
          const revision = await options.environmentManagement!.install(params.environmentId, {
            ...(params.channels ? { channels: params.channels } : {}),
            ...(params.indexUrl ? { indexUrl: params.indexUrl } : {}),
            manager: params.manager ?? "conda",
            packages: params.packages,
          }, signal);
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
        environmentId: Type.String({ minLength: 1 }),
        packages: Type.Array(Type.String({ maxLength: 160, minLength: 1 }), { maxItems: 128, minItems: 1 }),
      });
      const uninstallEnvironment: AgentTool<typeof uninstallParameters> = {
        description: "Remove conda package specifications from a named environment. Success creates a new immutable revision; base environments are read-only.",
        execute: async (_toolCallId, params, signal) => {
          const revision = await options.environmentManagement!.uninstall(params.environmentId, { packages: params.packages }, signal);
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
    const describeSkillParameters = Type.Object({
      query: Type.String({
        description: "Skill name or keyword query. Use select:skill-a,skill-b for exact names.",
        minLength: 1,
      }),
    });
    const selectedSkills = new Map(selectedSkillsForDiscovery.map((skill) => [skill.id, skill]));
    const describeSkill: AgentTool<typeof describeSkillParameters> = {
      description: "Search selected skill metadata by name or description before deciding which frozen skill instructions to load. This returns metadata only, not SKILL.md instructions.",
      execute: async (_toolCallId, params) => {
        const matched = searchSkills(selectedSkillsForDiscovery, params.query);
        const text = matched.length
          ? matched.map(renderSkillMetadata).join("\n\n")
          : `No selected skills matched: ${params.query}`;
        return { content: [{ type: "text", text }], details: { matched: matched.map(({ content: _content, readResource: _readResource, ...skill }) => skill), query: params.query } };
      },
      label: "Describe skill",
      name: "describe_skill",
      parameters: describeSkillParameters,
    };
    const readSkillParameters = Type.Object({
      skillId: skillIdSchema,
    });
    const readSkill: AgentTool<typeof readSkillParameters> = {
      description: "Load the full frozen SKILL.md instructions for an explicitly selected skill revision. Call this only after the task appears to match the skill name or description.",
      execute: async (_toolCallId, params) => {
        const skill = selectedSkills.get(params.skillId);
        if (!skill) throw new Error(`Skill ${params.skillId} is not selected for this run`);
        const resources = skill.resources.length
          ? `\n\nAvailable read-only supporting resources (use read_skill_resource only as needed):\n${skill.resources.map((resource) => `- ${resource.path} (${resource.kind}, ${resource.size} bytes)`).join("\n")}`
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
            resources: skill.resources,
            revision: skill.revision,
            version: skill.version,
          },
        };
      },
      label: "Read skill",
      name: "read_skill",
      parameters: readSkillParameters,
    };
    tools.push(describeSkill, readSkill);
  }
  const skillsWithResources = selectedSkillsForDiscovery.filter((skill) => skill.resources.length);
  if (skillsWithResources.length) {
    const skillLiterals = skillsWithResources.map((skill) => Type.Literal(skill.id));
    const skillResourceParameters = Type.Object({
      path: Type.String({ minLength: 1 }),
      skillId: Type.Union(skillLiterals as [typeof skillLiterals[number], ...typeof skillLiterals]),
    });
    const selectedSkills = new Map(skillsWithResources.map((skill) => [skill.id, skill]));
    const readSkillResource: AgentTool<typeof skillResourceParameters> = {
      description: "Read a bounded UTF-8 resource from an explicitly selected skill revision. Files are returned as data and are never executed or installed.",
      execute: async (_toolCallId, params) => {
        const skill = selectedSkills.get(params.skillId);
        if (!skill) throw new Error(`Skill ${params.skillId} is not selected for this run`);
        const result = await skill.readResource(params.path);
        return {
          content: [{ type: "text", text: result.content }],
          details: result,
        };
      },
      label: "Read skill resource",
      name: "read_skill_resource",
      parameters: skillResourceParameters,
    };
    tools.push(readSkillResource);
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

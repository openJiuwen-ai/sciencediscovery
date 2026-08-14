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

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type {
  CreateNpuJobRequest,
  NpuBrokerCapability,
  NpuJob,
  NpuJobLogs,
  NpuWorkloadDescriptor,
} from "@science-agent/schema";

import { appendBounded, DEFAULT_MAX_OUTPUT_BYTES } from "./executor.js";

export interface NpuBrokerConfig {
  dataDir: string;
  enabled: boolean;
  maxOutputBytes?: number;
  protenixScriptPath?: string;
  pythonPath?: string;
  resolveEnvironmentPython?: (revisionId: string) => string;
  resolveEnvironmentPythonPath?: (revisionId: string) => string;
  smokeScriptPath?: string;
  workloadConfigPath?: string;
}

interface PersistedNpuCatalog {
  jobs: NpuJob[];
}

interface RunningProcess {
  child: ChildProcessWithoutNullStreams;
  requestedCancellation: boolean;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDirectory, "../../..");
const ARTIFACT_MANIFEST_NAME = "artifact_manifest.txt";
export const DEFAULT_NPU_WORKLOAD_CONFIG_PATH = resolve(
  repositoryRoot,
  "services/runner/workloads/npu-workloads.default.json",
);

interface NpuWorkloadCommandTemplate {
  args?: string[];
  program: string;
}

interface ConfiguredNpuWorkload extends NpuWorkloadDescriptor {
  command: NpuWorkloadCommandTemplate;
  rejectAf3Intent?: boolean;
}

interface NpuWorkloadRegistryFile {
  workloads?: ConfiguredNpuWorkload[];
}

const AF3_INTENT_KEYS = new Set([
  "af3_dir",
  "af3_model_dir",
  "af3_db_dir",
  "model_dir",
  "db_dir",
  "use_af3",
]);
const AF3_INTENT_TEXT_KEYS = new Set([
  "backend",
  "model_backend",
  "pipeline",
  "pipeline_backend",
  "predictor",
  "structure_model",
  "structure_predictor",
  "workload",
  "workload_id",
  "workloadid",
]);

const SECRET_NAME_PATTERN = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)/iu;
const ALLOWED_EXACT_ENV = new Set([
  "ASCEND_HOME_PATH",
  "ASCEND_OPP_PATH",
  "ASCEND_AICPU_PATH",
  "ASCEND_TOOLKIT_HOME",
  "ASCEND_GLOBAL_LOG_LEVEL",
  "ASCEND_SLOG_PRINT_TO_STDOUT",
  "ASCEND_RT_VISIBLE_DEVICES",
  "CANN_PATH",
  "CANN_HOME",
  "DEVICE_ID",
  "HCCL_CONNECT_TIMEOUT",
  "HCCL_WHITELIST_DISABLE",
  "HMMER_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LD_LIBRARY_PATH",
  "MINDSPORE_HOME",
  "MS_COMPILER_CACHE_PATH",
  "MS_DEV_RUNTIME_CONF",
  "MS_ROLE",
  "PATH",
  "PYTHONPATH",
  "RANK_ID",
  "RANK_SIZE",
]);

const ALLOWED_ENV_PREFIXES = [
  "ASCEND_",
  "ANTIBODY_",
  "CANN_",
  "HCCL_",
  "HMMER_",
  "MINDSCIENCE_",
  "MINDSPORE_",
  "MS_",
  "NPU_",
  "RANK_",
];


export class HostNpuJobBroker {
  private readonly catalogPath: string;
  private readonly maxOutputBytes: number;
  private readonly running = new Map<string, RunningProcess>();
  private readonly workloads: ConfiguredNpuWorkload[];
  private jobs = new Map<string, NpuJob>();
  private queueTail = Promise.resolve();

  constructor(private readonly config: NpuBrokerConfig) {
    this.catalogPath = resolve(config.dataDir, "npu-jobs", "jobs.json");
    this.maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.workloads = this.loadWorkloadRegistry(config.workloadConfigPath);
    this.loadCatalog();
    this.interruptActiveJobsFromPreviousProcess();
  }

  capability(): NpuBrokerCapability {
    return {
      enabled: this.config.enabled,
      queueConcurrency: 1,
      workloads: this.config.enabled ? this.workloads.map((workload) => this.describeWorkload(workload)) : [],
    };
  }

  listWorkloads(): NpuWorkloadDescriptor[] {
    return this.capability().workloads;
  }

  listJobs(sessionId?: string, options: { includeLogs?: boolean } = {}): NpuJob[] {
    return [...this.jobs.values()]
      .filter((job) => sessionId === undefined || job.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((job) => this.cloneJob(job, options));
  }

  listJobSummaries(sessionId?: string): NpuJob[] {
    return [...this.jobs.values()]
      .filter((job) => sessionId === undefined || job.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((job) => this.cloneJob(job, { includeLogs: false }));
  }

  getJob(jobId: string, sessionId?: string): NpuJob | undefined {
    const job = this.jobs.get(jobId);
    if (job && sessionId !== undefined) this.assertJobSession(job, sessionId);
    return job ? this.cloneJob(job) : undefined;
  }

  async submit(input: CreateNpuJobRequest): Promise<NpuJob> {
    this.assertEnabled();
    const workload = this.workload(input.workloadId);
    const sessionId = this.nonEmpty(input.sessionId, "sessionId");
    const environmentRevisionId = input.environmentRevisionId?.trim() || "";
    this.validateWorkloadEnvironment(workload, environmentRevisionId);
    const workspaceRoot = this.realWorkspaceRoot(input.workspaceRoot);
    const now = new Date().toISOString();
    const job: NpuJob = {
      createdAt: now,
      ...(environmentRevisionId ? { environmentRevisionId } : {}),
      id: input.jobId?.trim() || randomUUID(),
      inputs: input.inputs ?? {},
      logs: { stderr: "", stdout: "", truncated: false },
      sessionId,
      state: "queued",
      updatedAt: now,
      workloadId: workload.id,
      workspaceRoot,
    };
    if (this.jobs.has(job.id)) throw new Error(`NPU job already exists: ${job.id}`);
    this.validateWorkloadIntent(job, workload);
    this.jobs.set(job.id, job);
    this.persistCatalog();
    this.queueTail = this.queueTail.then(() => this.run(job.id), () => this.run(job.id));
    return this.cloneJob(job);
  }

  async cancel(jobId: string, sessionId?: string): Promise<NpuJob> {
    const job = this.mutableJob(jobId);
    if (sessionId !== undefined) this.assertJobSession(job, sessionId);
    if (job.state === "queued") {
      this.finish(job, "cancelled");
      return this.cloneJob(job);
    }
    if (job.state === "running") {
      const running = this.running.get(job.id);
      if (running) {
        running.requestedCancellation = true;
        this.signalRunningProcess(running, "SIGTERM");
        setTimeout(() => {
          if (running.child.exitCode === null && running.child.signalCode === null) {
            this.signalRunningProcess(running, "SIGKILL");
          }
        }, 2_000).unref();
      }
      return this.cloneJob(job);
    }
    return this.cloneJob(job);
  }

  logs(jobId: string, sessionId?: string): NpuJobLogs {
    const job = this.mutableJob(jobId);
    if (sessionId !== undefined) this.assertJobSession(job, sessionId);
    return { ...job.logs };
  }

  result(jobId: string, sessionId?: string): NpuJob {
    const job = this.mutableJob(jobId);
    if (sessionId !== undefined) this.assertJobSession(job, sessionId);
    if (!["succeeded", "failed", "cancelled", "interrupted"].includes(job.state)) {
      throw new Error(`NPU job ${jobId} is not terminal`);
    }
    const previousCreatedFiles = (job.createdFiles ?? []).join("\0");
    this.refreshCreatedFiles(job);
    if ((job.createdFiles ?? []).join("\0") !== previousCreatedFiles) this.persistCatalog();
    return this.cloneJob(job);
  }

  private async run(jobId: string): Promise<void> {
    const job = this.mutableJob(jobId);
    if (job.state !== "queued") return;
    job.startedAt = new Date().toISOString();
    job.state = "running";
    job.updatedAt = job.startedAt;
    this.persistCatalog();
    try {
      const plan = this.plan(job);
      const result = await this.spawnWorkload(job, plan.command, plan.args);
      if (result.cancelled) {
        this.finish(job, "cancelled", undefined, result.exitCode);
      } else if (result.exitCode === 0) {
        this.finish(job, "succeeded", undefined, result.exitCode);
      } else {
        this.finish(job, "failed", `NPU workload exited with code ${result.exitCode}`, result.exitCode);
      }
    } catch (error) {
      this.finish(job, "failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.running.delete(job.id);
    }
  }

  private plan(job: NpuJob): { args: string[]; command: string } {
    const workload = this.workload(job.workloadId);
    return {
      args: (workload.command.args ?? []).map((argument, index) => this.resolveCommandTemplate(
        argument,
        job,
        `${workload.id}.command.args[${index}]`,
      )),
      command: this.resolveCommandTemplate(workload.command.program, job, `${workload.id}.command.program`),
    };
  }

  private spawnWorkload(job: NpuJob, command: string, args: string[]): Promise<{ cancelled: boolean; exitCode: number | null }> {
    return new Promise((resolveSpawn, reject) => {
      const child = spawn(command, args, {
        cwd: job.workspaceRoot,
        detached: process.platform !== "win32",
        env: this.brokerEnvironment(job),
        shell: false,
        windowsHide: true,
      });
      const running: RunningProcess = { child, requestedCancellation: false };
      this.running.set(job.id, running);

      child.stdout.on("data", (chunk: Buffer) => this.appendJobOutput(job, "stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => this.appendJobOutput(job, "stderr", chunk));
      child.once("error", reject);
      child.once("close", (code) => resolveSpawn({
        cancelled: running.requestedCancellation,
        exitCode: code,
      }));
    });
  }

  private signalRunningProcess(running: RunningProcess, signal: NodeJS.Signals): void {
    const pid = running.child.pid;
    if (process.platform !== "win32" && pid) {
      try {
        process.kill(-pid, signal);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return;
      }
    }
    running.child.kill(signal);
  }

  private appendJobOutput(job: NpuJob, stream: "stderr" | "stdout", chunk: Buffer): void {
    const other = stream === "stdout" ? job.logs.stderr : job.logs.stdout;
    const otherStreamBytes = Buffer.byteLength(other);
    const appended = appendBounded(job.logs[stream], chunk, this.maxOutputBytes, otherStreamBytes);
    job.logs[stream] = appended.text;
    job.logs.truncated ||= appended.truncated;
    job.updatedAt = new Date().toISOString();
    this.persistCatalog();
  }

  private brokerEnvironment(job: NpuJob): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (SECRET_NAME_PATTERN.test(name)) continue;
      if (ALLOWED_EXACT_ENV.has(name) || ALLOWED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        env[name] = value;
      }
    }
    const revisionId = job.environmentRevisionId?.trim();
    if (revisionId) {
      const resolver = this.config.resolveEnvironmentPythonPath;
      if (!resolver) throw new Error("Managed scientific environment Python paths are unavailable to the NPU Broker");
      const managedPythonPath = realpathSync(resolver(revisionId));
      const hostPythonPaths = (env.PYTHONPATH ?? "")
        .split(delimiter)
        .map((path) => path.trim())
        .filter((path) => path && path !== managedPythonPath);
      env.PYTHONPATH = [managedPythonPath, ...hostPythonPaths].join(delimiter);
    }
    const homePath = resolve(job.workspaceRoot, ".npu-home");
    mkdirSync(homePath, { recursive: true });
    env.HOME = homePath;
    env.ANTIBODY_ALLOW_HOST_NPU_PYTHON = "1";
    env.SCIENCE_AGENT_NPU_BROKER = "1";
    env.SCIENCE_AGENT_NPU_BROKER_MODE = "1";
    env.SCIENCE_AGENT_NPU_WORKSPACE = job.workspaceRoot;
    return env;
  }

  private workspaceInputPath(job: NpuJob, field: string): string {
    const raw = job.inputs[field];
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error(`${job.workloadId} requires inputs.${field}`);
    }
    if (resolve(raw) === raw) {
      throw new Error(`${field} must be a workspace-relative path`);
    }
    const candidate = resolve(job.workspaceRoot, raw);
    const real = realpathSync(candidate);
    if (!this.isInside(real, job.workspaceRoot)) {
      throw new Error(`${field} must resolve inside the NPU job workspace`);
    }
    return real;
  }

  private validateWorkloadIntent(job: NpuJob, workload: ConfiguredNpuWorkload): void {
    if (!workload.rejectAf3Intent) return;
    const configPath = this.workspaceInputPath(job, "configPath");
    let config: unknown;
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      return;
    }
    if (workload.rejectAf3Intent && this.looksLikeAf3Config(config)) {
      throw new Error(
        "Configuration appears to target AlphaFold3; the built-in NPU Broker allowlist only exposes antibody.protenix.v1",
      );
    }
  }

  private looksLikeAf3Config(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.replace(/-/g, "_").toLowerCase();
      if (AF3_INTENT_KEYS.has(normalizedKey)) return true;
      if (
        AF3_INTENT_TEXT_KEYS.has(normalizedKey)
        && typeof child === "string"
        && (child.toLowerCase().includes("af3") || child.toLowerCase().includes("alphafold"))
      ) {
        return true;
      }
      if (this.looksLikeAf3Config(child)) return true;
    }
    return false;
  }

  private realWorkspaceRoot(path: string): string {
    const real = realpathSync(this.nonEmpty(path, "workspaceRoot"));
    const projectsRoot = realpathSync(resolve(this.config.dataDir, "projects"));
    if (!this.isInside(real, projectsRoot)) {
      throw new Error("NPU workspaceRoot must be inside the configured data/projects directory");
    }
    return real;
  }

  private isInside(candidate: string, root: string): boolean {
    const resolvedRelative = relative(root, candidate);
    return resolvedRelative === "" || (!resolvedRelative.startsWith("..") && !isAbsolute(resolvedRelative));
  }

  private workload(workloadId: string): ConfiguredNpuWorkload {
    const id = this.nonEmpty(workloadId, "workloadId");
    const workload = this.workloads.find((candidate) => candidate.id === id);
    if (!workload) throw new Error(`Unknown NPU workload: ${id}`);
    return workload;
  }

  private describeWorkload(workload: ConfiguredNpuWorkload): NpuWorkloadDescriptor {
    return {
      description: workload.description,
      id: workload.id,
      label: workload.label,
      phase: workload.phase,
      ...(workload.requiresEnvironmentRevision ? { requiresEnvironmentRevision: true } : {}),
      ...(workload.requiredInputs ? { requiredInputs: [...workload.requiredInputs] } : {}),
    };
  }

  private validateWorkloadEnvironment(workload: ConfiguredNpuWorkload, environmentRevisionId: string): void {
    if (!workload.requiresEnvironmentRevision) return;
    if (!environmentRevisionId) throw new Error("environmentRevisionId is required for this NPU workload");
    const resolver = this.config.resolveEnvironmentPython;
    if (!resolver) throw new Error("Managed scientific environments are unavailable to the NPU Broker");
    realpathSync(resolver(environmentRevisionId));
    const pythonPathResolver = this.config.resolveEnvironmentPythonPath;
    if (!pythonPathResolver) throw new Error("Managed scientific environment Python paths are unavailable to the NPU Broker");
    realpathSync(pythonPathResolver(environmentRevisionId));
  }

  private resolveCommandTemplate(template: string, job: NpuJob, source: string): string {
    const resolved = template.replace(/\$\{([^}]+)\}/gu, (_match, expression: string) =>
      this.resolveTemplateExpression(expression.trim(), job, source));
    if (!resolved.trim()) throw new Error(`NPU workload command template resolved to an empty value: ${source}`);
    return resolved;
  }

  private resolveTemplateExpression(expression: string, job: NpuJob, source: string): string {
    if (expression === "python") return this.config.pythonPath?.trim() || "python3";
    if (expression === "managedPython") {
      const revisionId = this.nonEmpty(job.environmentRevisionId, "environmentRevisionId");
      const resolver = this.config.resolveEnvironmentPython;
      if (!resolver) throw new Error("Managed scientific environments are unavailable to the NPU Broker");
      return realpathSync(resolver(revisionId));
    }
    if (expression === "workspaceRoot") return job.workspaceRoot;
    if (expression.startsWith("input:")) return this.workspaceInputPath(job, this.nonEmpty(expression.slice("input:".length), source));
    if (expression.startsWith("repo:")) return this.repoPath(expression.slice("repo:".length), source);
    if (expression.startsWith("env:")) {
      const envExpression = expression.slice("env:".length);
      const fallbackIndex = envExpression.indexOf(":-");
      const name = fallbackIndex >= 0 ? envExpression.slice(0, fallbackIndex) : envExpression;
      const value = this.configuredEnv(this.nonEmpty(name, source));
      if (value) return value;
      if (fallbackIndex >= 0) return this.resolveTemplateExpression(envExpression.slice(fallbackIndex + 2), job, source);
      throw new Error(`Environment variable ${name} is required by NPU workload command template: ${source}`);
    }
    throw new Error(`Unsupported NPU workload command template expression: ${expression}`);
  }

  private repoPath(path: string, source: string): string {
    const relativePath = this.nonEmpty(path, source);
    if (isAbsolute(relativePath)) throw new Error(`repo: paths must be repository-relative in NPU workload config: ${source}`);
    const real = realpathSync(resolve(repositoryRoot, relativePath));
    if (!this.isInside(real, repositoryRoot)) {
      throw new Error(`repo: path must resolve inside the repository in NPU workload config: ${source}`);
    }
    return real;
  }

  private configuredEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (value) return value;
    if (name === "SCIENCE_AGENT_NPU_SMOKE_SCRIPT") return this.config.smokeScriptPath?.trim() || "";
    if (name === "SCIENCE_AGENT_NPU_PROTENIX_SCRIPT") return this.config.protenixScriptPath?.trim() || "";
    return "";
  }

  private loadWorkloadRegistry(configPath = DEFAULT_NPU_WORKLOAD_CONFIG_PATH): ConfiguredNpuWorkload[] {
    const registry = JSON.parse(readFileSync(configPath, "utf8")) as NpuWorkloadRegistryFile;
    if (!Array.isArray(registry.workloads)) throw new Error(`NPU workload config must contain a workloads array: ${configPath}`);
    const seen = new Set<string>();
    return registry.workloads.map((raw, index) => {
      const workload = this.normalizeConfiguredWorkload(raw, `${configPath}:workloads[${index}]`);
      if (seen.has(workload.id)) throw new Error(`Duplicate NPU workload id in config: ${workload.id}`);
      seen.add(workload.id);
      return workload;
    });
  }

  private normalizeConfiguredWorkload(raw: ConfiguredNpuWorkload, source: string): ConfiguredNpuWorkload {
    if (!raw || typeof raw !== "object") throw new Error(`Invalid NPU workload entry: ${source}`);
    const id = this.nonEmpty(raw.id, `${source}.id`);
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) throw new Error(`Invalid NPU workload id: ${id}`);
    const command = this.normalizeCommandTemplate(raw.command, `${source}.command`);
    const inferredInputs = this.inferRequiredInputs(command);
    const requiresEnvironmentRevision = this.requiresEnvironmentRevision(command);
    const requiredInputs = raw.requiredInputs ? [...raw.requiredInputs] : inferredInputs;
    for (const field of requiredInputs) {
      if (field !== "configPath") throw new Error(`Unsupported required input for ${id}: ${field}`);
    }
    return {
      description: this.nonEmpty(raw.description, `${source}.description`),
      id,
      label: this.nonEmpty(raw.label, `${source}.label`),
      phase: raw.phase === "project" ? "project" : "builtin",
      ...(requiresEnvironmentRevision ? { requiresEnvironmentRevision: true } : {}),
      requiredInputs,
      command,
      ...(raw.rejectAf3Intent ? { rejectAf3Intent: true } : {}),
    };
  }

  private normalizeCommandTemplate(raw: NpuWorkloadCommandTemplate, source: string): NpuWorkloadCommandTemplate {
    if (!raw || typeof raw !== "object") throw new Error(`NPU workload config requires command object: ${source}`);
    const program = this.nonEmpty(raw.program, `${source}.program`);
    const args = raw.args ?? [];
    if (!Array.isArray(args)) throw new Error(`NPU workload command args must be an array: ${source}.args`);
    return {
      args: args.map((argument, index) => this.nonEmpty(argument, `${source}.args[${index}]`)),
      program,
    };
  }

  private inferRequiredInputs(command: NpuWorkloadCommandTemplate): string[] {
    const fields = new Set<string>();
    for (const template of [command.program, ...(command.args ?? [])]) {
      for (const match of template.matchAll(/\$\{input:([^}]+)\}/gu)) {
        fields.add(match[1]!.trim());
      }
    }
    return [...fields].sort();
  }

  private requiresEnvironmentRevision(command: NpuWorkloadCommandTemplate): boolean {
    return [command.program, ...(command.args ?? [])]
      .some((template) => /\$\{\s*managedPython\s*\}/u.test(template));
  }

  private finish(job: NpuJob, state: NpuJob["state"], error?: string, exitCode?: number | null): void {
    const now = new Date().toISOString();
    job.error = error;
    job.exitCode = exitCode ?? undefined;
    job.finishedAt = now;
    this.refreshCreatedFiles(job);
    job.state = state;
    job.updatedAt = now;
    this.persistCatalog();
  }

  private interruptActiveJobsFromPreviousProcess(): void {
    let changed = false;
    for (const job of this.jobs.values()) {
      if (job.state === "queued" || job.state === "running") {
        this.finish(job, "interrupted", "Runner restarted before the NPU job completed");
        changed = true;
      }
    }
    if (changed) this.persistCatalog();
  }

  private mutableJob(jobId: string): NpuJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown NPU job: ${jobId}`);
    return job;
  }

  private assertJobSession(job: NpuJob, sessionId: string): void {
    const expected = this.nonEmpty(sessionId, "sessionId");
    if (job.sessionId !== expected) throw new Error("NPU job not found in this Session");
  }

  private cloneJob(job: NpuJob, options: { includeLogs?: boolean } = {}): NpuJob {
    return {
      ...job,
      ...(job.createdFiles ? { createdFiles: [...job.createdFiles] } : {}),
      inputs: { ...job.inputs },
      logs: options.includeLogs === false ? { stderr: "", stdout: "", truncated: job.logs.truncated } : { ...job.logs },
      ...(options.includeLogs === false ? { workspaceRoot: "" } : {}),
    };
  }

  private refreshCreatedFiles(job: NpuJob): void {
    const createdFiles: string[] = [];
    const seen = new Set<string>();
    for (const manifestPath of this.artifactManifestPaths(job)) {
      if (!existsSync(manifestPath)) continue;
      const manifestRoot = dirname(manifestPath);
      for (const rawLine of readFileSync(manifestPath, "utf8").split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const candidate = isAbsolute(line) ? line : resolve(manifestRoot, line);
        let realCandidate: string;
        try {
          realCandidate = realpathSync(candidate);
        } catch {
          continue;
        }
        if (!this.isInside(realCandidate, job.workspaceRoot)) continue;
        const workspaceRelativePath = relative(job.workspaceRoot, realCandidate).split(/[\\/]/u).join("/");
        if (!workspaceRelativePath || seen.has(workspaceRelativePath)) continue;
        seen.add(workspaceRelativePath);
        createdFiles.push(workspaceRelativePath);
      }
    }
    job.createdFiles = createdFiles;
  }

  private artifactManifestPaths(job: NpuJob): string[] {
    const manifests = [resolve(job.workspaceRoot, ARTIFACT_MANIFEST_NAME)];
    const configPath = job.inputs.configPath;
    if (typeof configPath === "string" && configPath.trim() && resolve(configPath) !== configPath) {
      manifests.push(resolve(job.workspaceRoot, dirname(configPath), ARTIFACT_MANIFEST_NAME));
    }
    return [...new Set(manifests)];
  }

  private nonEmpty(value: unknown, name: string): string {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) throw new Error(`${name} is required`);
    return trimmed;
  }

  private assertEnabled(): void {
    if (!this.config.enabled) throw new Error("NPU Broker is disabled");
  }

  private loadCatalog(): void {
    if (!existsSync(this.catalogPath)) return;
    try {
      const catalog = JSON.parse(readFileSync(this.catalogPath, "utf8")) as PersistedNpuCatalog;
      this.jobs = new Map((catalog.jobs ?? []).map((job) => [job.id, job]));
    } catch {
      this.jobs = new Map();
    }
  }

  private persistCatalog(): void {
    mkdirSync(dirname(this.catalogPath), { recursive: true });
    const temporaryPath = `${this.catalogPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ jobs: this.listJobs(undefined, { includeLogs: true }) } satisfies PersistedNpuCatalog, null, 2)}\n`);
    renameSync(temporaryPath, this.catalogPath);
  }
}

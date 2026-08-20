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

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { resolveWorkspaceFile } from "@sciencediscovery/workspace";
import { CasStore } from "@sciencediscovery/cas";
import type {
  ArtifactDerivation,
  ArtifactOrigin,
  ArtifactOriginMeta,
  CasObjectRef,
  ComposerReference,
  KernelMode,
  PermissionEpoch,
  PythonExecutionResult,
  ScientificLanguage,
  ScientificArtifact,
  ScientificArtifactKind,
  ScientificArtifactVersion,
  ShellExecutionResult,
} from "@sciencediscovery/schema";
import {
  SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
  classifyScientificArtifact,
  epochSandboxNetworkAccess,
} from "@sciencediscovery/schema";

import { RunnerClient } from "./runner-client.js";
import { SessionStore } from "./store.js";
import type { MemoryGraphSink, ObserveExecutionPayload } from "./memory-graph.js";
import {
  DEFAULT_ENVIRONMENT_PACKAGE_SPEC,
  DEFAULT_ENVIRONMENT_PACKAGE_SPEC_HASH,
  DEFAULT_ENVIRONMENT_REVISION_ID,
  DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC,
  DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC_HASH,
} from "./environment.js";

/**
 * An in-flight Runner execution only ends early because the surrounding agent
 * run was aborted (user Stop, run timeout) or because the Runner itself broke.
 * Recording the aborted case as `cancelled` keeps a stopped run distinguishable
 * from a genuine execution failure in the provenance record.
 */
function interruptedExecutionStatus(signal: AbortSignal | undefined): "cancelled" | "failed" {
  return signal?.aborted ? "cancelled" : "failed";
}

export interface RecordExecutionOptions {
  agentId: string;
  artifactPathPrefix?: string;
  code: string;
  environmentRevisionId?: string;
  executionTimeoutMs?: number;
  kernelIdleTimeoutMs?: number;
  kernelMode?: KernelMode;
  language?: ScientificLanguage;
  maxOutputBytes?: number;
  maxWorkspaceBytes?: number;
  permissionEpoch: PermissionEpoch;
  readOnlyWorkspaceRoot?: string;
  runnerClient: RunnerClient;
  sessionId: string;
  signal?: AbortSignal;
  turnId: string;
  workspaceRoot: string;
}

export type RecordShellExecutionOptions = Omit<RecordExecutionOptions, "environmentRevisionId" | "language">;

export class ProvenanceRecorder {
  readonly cas: CasStore;
  private readonly memoryGraphSink: MemoryGraphSink | null;

  constructor(
    dataDir: string,
    private readonly store: SessionStore,
    memoryGraphSink?: MemoryGraphSink,
  ) {
    this.cas = new CasStore(dataDir);
    this.memoryGraphSink = memoryGraphSink ?? null;
  }

  /**
   * CAS-persist the effective env of an execution as canonical JSON (sorted
   * keys) so identical environments dedupe and different ones are hash-distinct.
   */
  private async putEnvSnapshot(environmentVariables: Record<string, string>): Promise<CasObjectRef> {
    const canonical = Object.fromEntries(
      Object.entries(environmentVariables).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    );
    return await this.cas.put(JSON.stringify(canonical));
  }

  async executePython(options: RecordExecutionOptions): Promise<PythonExecutionResult> {
    return await this.executeScientific({ ...options, language: "python" });
  }

  private artifactKind(path: string): ScientificArtifactKind {
    return classifyScientificArtifact(path) ?? "other";
  }

  private artifactMediaType(path: string): string {
    return ({
      ".cif": "chemical/x-cif",
      ".csv": "text/csv",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".feather": "application/vnd.apache.arrow.file",
      ".htm": "text/html",
      ".html": "text/html",
      ".ipynb": "application/x-ipynb+json",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".json": "application/json",
      ".md": "text/markdown",
      ".markdown": "text/markdown",
      ".mmcif": "chemical/x-mmcif",
      ".mol2": "chemical/x-mol2",
      ".parquet": "application/vnd.apache.parquet",
      ".pdb": "chemical/x-pdb",
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".sdf": "chemical/x-mdl-sdfile",
      ".svg": "image/svg+xml",
      ".tex": "application/x-tex",
      ".tsv": "text/tab-separated-values",
      ".webp": "image/webp",
      ".xyz": "chemical/x-xyz",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    } as Record<string, string>)[extname(path).toLocaleLowerCase()] ?? "application/octet-stream";
  }

  async registerWorkspaceArtifact(options: {
    description?: string;
    executionRunIds?: string[];
    inputArtifactVersionIds?: string[];
    kind?: ScientificArtifactKind;
    logicalName?: string;
    origin?: ArtifactOrigin;
    originMeta?: ArtifactOriginMeta;
    path: string;
    references?: ComposerReference[];
    sessionId: string;
    sourcePath?: string;
    title?: string;
    turnId?: string;
    workspaceRoot: string;
  }): Promise<{ artifact: ScientificArtifact; version: ScientificArtifactVersion }> {
    const kind = options.kind ?? this.artifactKind(options.path);
    const content = await this.cas.put(await readFile(resolveWorkspaceFile(options.workspaceRoot, options.path)));
    return await this.store.createArtifactVersion({
      content,
      ...(options.description ? { description: options.description } : {}),
      executionRunIds: options.executionRunIds,
      inputArtifactVersionIds: options.inputArtifactVersionIds,
      kind,
      logicalName: options.logicalName ?? options.path,
      mediaType: this.artifactMediaType(options.path),
      origin: options.origin ?? "user_upload",
      ...(options.originMeta ? { originMeta: options.originMeta } : {}),
      ...(options.references?.length ? { references: options.references } : {}),
      sessionId: options.sessionId,
      sourcePath: options.sourcePath ?? options.path,
      ...(options.title ? { title: options.title } : {}),
      turnId: options.turnId,
    });
  }

  async declareWorkspaceArtifact(options: {
    description?: string;
    name: string;
    path: string;
    /**
     * Chip-reference + claim-id accumulator from the calling run scope. Drains
     * the entries tagged with this version's ``turnId`` when a report Artifact
     * version is persisted, so chips survive reloads and claim ids link to the
     * report via ``stated_in`` edges. Passed per-call by the run (``runs/index.ts``)
     * rather than held as a singleton instance field so concurrent runs in one
     * process never overwrite each other's accumulator.
     */
    referencesProvider?: (turnId?: string) => { references: ComposerReference[]; claimIds: string[] };
    sessionId: string;
    sourcePath: string;
    turnId?: string;
    workspaceRoot: string;
  }): Promise<{ artifact: ScientificArtifact; version: ScientificArtifactVersion; instruction?: string }> {
    const derivations = await this.store.listArtifactDerivations(options.sessionId);
    const derivation = derivations
      .filter((item) => item.path === options.sourcePath)
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    const executionId = derivation?.executionRunIds.at(-1);
    const run = executionId
      ? (await this.store.listExecutionRuns(options.sessionId)).find((item) => item.id === executionId)
      : undefined;
    const code = run ? (await this.cas.read(run.code.hash)).toString("utf8") : "";
    const inputs = this.inferredArtifactInputs(options.sessionId, options.name, code, run?.id);
    const kind = this.artifactKind(options.path);
    const isReportKind = kind === "markdown" || kind === "latex" || kind === "report";
    // Register FIRST, drain AFTER. registerWorkspaceArtifact reads the file
    // (ENOENT if the LLM declared a path that doesn't exist yet) and throws
    // before any version lands. If we drained the chip/claim buffer before
    // register — as we used to — that throw swallows the buffer: the LLM
    // retries declare_artifact with the right path, the version lands, but
    // references=[] so every [alias] chip in the report degrades to plain
    // text with no error. Draining post-register keeps the buffer intact
    // across a failed declaration; only a successful report version pulls
    // chips onto itself. Drain is scoped by turnId so a report in one
    // execution context (leader run vs. report-writer subagent) drains only
    // the chip references that context's declare_claim calls pushed.
    const { artifact, version } = await this.registerWorkspaceArtifact({
      ...(options.description ? { description: options.description } : {}),
      ...(run ? { executionRunIds: [run.id] } : {}),
      inputArtifactVersionIds: inputs.versionIds,
      kind,
      logicalName: options.name,
      origin: "llm_declared",
      originMeta: { declaredPath: options.sourcePath },
      path: options.path,
      sessionId: options.sessionId,
      sourcePath: options.sourcePath,
      turnId: options.turnId,
      workspaceRoot: options.workspaceRoot,
    });
    const drained = isReportKind && options.referencesProvider
      ? options.referencesProvider(options.turnId)
      : { references: [] as ComposerReference[], claimIds: [] as string[] };
    if (drained.references.length) {
      // Write chips onto the persisted version (updateArtifactVersionReferences
      // finds the catalog record by id and persists immediately) AND mirror them
      // onto the cloned snapshot we return + emit via artifact.upserted, so live
      // consumers see the references without re-reading the store.
      this.store.updateArtifactVersionReferences(options.sessionId, version.id, drained.references);
      version.references = structuredClone(drained.references);
    }
    if (drained.claimIds.length && this.memoryGraphSink) {
      this.memoryGraphSink.linkClaimsToReport(artifact.id, version.version, drained.claimIds, options.sessionId);
    }
    if (run && this.memoryGraphSink) {
      const environment = run.environmentRevisionId
        ? this.store.listEnvironmentRevisions().find((item) => item.id === run.environmentRevisionId)
        : undefined;
      this.memoryGraphSink.observeExecution({
        codeHash: run.code.hash,
        envHash: environment?.snapshot.hash ?? null,
        executionId: run.id,
        exitCode: run.exitCode,
        finishedAt: run.finishedAt,
        language: run.language,
        producedArtifacts: [{
          artifactId: artifact.id,
          contentHash: version.content.hash,
          inputArtifactVersions: inputs.compositeKeys,
          logicalName: artifact.name,
          mediaType: version.mediaType,
          path: version.sourcePath ?? artifact.name,
          projectId: artifact.projectId,
          turnId: version.turnId,
          version: version.version,
        }],
        sessionId: options.sessionId,
        startedAt: run.startedAt,
        status: run.status,
        stderrHash: run.stderr.hash,
        stdoutHash: run.stdout.hash,
        taskType: "auto_inferred_from_execution",
        tool: run.tool,
        turnId: run.turnId,
      });
    }
    return { artifact, version };
  }

  /** Infer the artifact inputs a piece of code read by scanning the code text
   * for other artifacts' logical names. Returns BOTH the SessionStore UUIDs
   * (for ``inputArtifactVersionIds``, the persisted provenance contract) and
   * the graph composite-key pairs ``{artifactId, version}`` (for the ``input``
   * edge payload) in one pass — the version object is already in hand from
   * ``listArtifactVersions(...).at(-1)``, so deriving the composite key adds
   * zero store reads (docs/memory-graph-derived-from-impl.md §10.2). The
   * composite-key form never touches the ``inputArtifactVersionIds`` field,
   * keeping the UUID contract intact for the legacy endpoint fallback,
   * reviewer-specialist, and annotation paths. */
  private inferredArtifactInputs(
    sessionId: string,
    outputPath: string,
    code: string,
    producingExecutionId?: string,
  ): { versionIds: string[]; compositeKeys: Array<{ artifactId: string; version: number }> } {
    const versionIds: string[] = [];
    const compositeKeys: Array<{ artifactId: string; version: number }> = [];
    for (const artifact of this.store.listArtifacts(sessionId)) {
      if (artifact.logicalName === outputPath || !code.includes(artifact.logicalName)) continue;
      const version = this.store.listArtifactVersions(sessionId, artifact.id).at(-1);
      if (!version) continue;
      // Multiple declared files can come from one execution. A sibling output
      // is not an input merely because the write path appears in the code.
      if (producingExecutionId && version.executionRunIds.includes(producingExecutionId)) continue;
      versionIds.push(version.id);
      compositeKeys.push({ artifactId: artifact.id, version: version.version });
    }
    return { versionIds, compositeKeys };
  }

  private async recordGeneratedFiles(options: {
    artifactPathPrefix?: string;
    code: string;
    executionId: string;
    finishedAt: string;
    paths: string[];
    sessionId: string;
    turnId: string;
    workspaceRoot: string;
  }): Promise<void> {
    const derivations: ArtifactDerivation[] = [];
    for (const path of options.paths) {
      const logicalPath = options.artifactPathPrefix ? `${options.artifactPathPrefix}/${path}` : path;
      const content = await this.cas.put(await readFile(resolveWorkspaceFile(options.workspaceRoot, path)));
      derivations.push({
        content,
        createdAt: options.finishedAt,
        executionRunIds: [options.executionId],
        id: randomUUID(),
        path: logicalPath,
        sessionId: options.sessionId,
        sourceType: "generated",
        turnId: options.turnId,
      });
    }
    if (derivations.length) await this.store.appendArtifactDerivations(options.sessionId, derivations);
  }

  /** Fire-and-forget mirror of one execution to the memory graph. Never throws. */
  private observeExecution(payload: Omit<ObserveExecutionPayload, "taskType"> & { taskType?: string }): void {
    this.memoryGraphSink?.observeExecution({
      taskType: "code_execution",
      ...payload,
    } as ObserveExecutionPayload);
  }

  async executeShell(options: RecordShellExecutionOptions): Promise<ShellExecutionResult> {
    const executionId = randomUUID();
    const shellSpec = await this.cas.put(DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC);
    if (shellSpec.hash !== DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC_HASH) {
      throw new Error("Shell environment package spec hash is inconsistent");
    }
    const code = await this.cas.put(options.code);
    let result: ShellExecutionResult;
    try {
      result = await options.runnerClient.executeShell({
        agentId: options.agentId,
        code: options.code,
        ...(options.executionTimeoutMs !== undefined ? { executionTimeoutMs: options.executionTimeoutMs } : {}),
        ...(options.kernelIdleTimeoutMs !== undefined ? { kernelIdleTimeoutMs: options.kernelIdleTimeoutMs } : {}),
        ...(options.kernelMode !== undefined ? { kernelMode: options.kernelMode } : {}),
        ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
        ...(options.maxWorkspaceBytes !== undefined ? { maxWorkspaceBytes: options.maxWorkspaceBytes } : {}),
        executionId,
        permissionEpoch: options.permissionEpoch,
        ...(options.readOnlyWorkspaceRoot ? { readOnlyWorkspaceRoot: options.readOnlyWorkspaceRoot } : {}),
        workspaceRoot: options.workspaceRoot,
      }, options.signal);
    } catch (error) {
      const timestamp = new Date().toISOString();
      await this.store.appendExecutionRun({
        cgroupMode: "unavailable",
        code,
        createdFiles: [],
        environmentRevisionId: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
        envSnapshot: null,
        exitCode: null,
        finishedAt: timestamp,
        id: executionId,
        kernelId: `ephemeral:${executionId}`,
        kernelMode: options.kernelMode ?? "ephemeral",
        language: "shell",
        modifiedFiles: [],
        networkAccessRevision: epochSandboxNetworkAccess(options.permissionEpoch).revision,
        networkPolicy: options.permissionEpoch.networkPolicy,
        permissionEpochId: options.permissionEpoch.id,
        runnerVersion: "unavailable",
        sandbox: "bubblewrap",
        sessionId: options.sessionId,
        startedAt: timestamp,
        status: interruptedExecutionStatus(options.signal),
        stderr: await this.cas.put(error instanceof Error ? error.message : "Runner shell execution failed"),
        stdout: await this.cas.put(""),
        tool: "run_shell",
        toolVersion: "1.1.0",
        turnId: options.turnId,
        workingDirectory: "unavailable",
      });
      throw error;
    }

    const stdout = await this.cas.put(result.stdout);
    const stderr = await this.cas.put(result.stderr);
    await this.store.appendExecutionRun({
      cgroupMode: result.cgroupMode,
      code,
      createdFiles: result.createdFiles,
      environmentRevisionId: result.environmentRevisionId,
      envSnapshot: await this.putEnvSnapshot(result.environmentVariables),
      exitCode: result.exitCode,
      finishedAt: result.finishedAt,
      id: executionId,
      kernelId: result.kernelId,
      kernelMode: result.kernelMode,
      language: "shell",
      modifiedFiles: result.modifiedFiles,
      ...(result.networkAccessRevision ? { networkAccessRevision: result.networkAccessRevision } : {}),
      networkPolicy: result.networkPolicy,
      permissionEpochId: options.permissionEpoch.id,
      runnerVersion: result.runnerVersion,
      sandbox: result.sandbox,
      sessionId: options.sessionId,
      startedAt: result.startedAt,
      status: result.exitCode === 0 ? "succeeded" : "failed",
      stderr,
      stdout,
      tool: "run_shell",
      toolVersion: "1.1.0",
      turnId: options.turnId,
      workingDirectory: result.workingDirectory,
    });

    const paths = [...new Set([...result.createdFiles, ...result.modifiedFiles])];
    await this.recordGeneratedFiles({
      artifactPathPrefix: options.artifactPathPrefix,
      code: options.code,
      executionId,
      finishedAt: result.finishedAt,
      paths,
      sessionId: options.sessionId,
      turnId: options.turnId,
      workspaceRoot: options.workspaceRoot,
    });
    this.observeExecution({
      executionId,
      sessionId: options.sessionId,
      turnId: options.turnId,
      tool: "run_shell",
      language: null,
      codeHash: code.hash,
      exitCode: result.exitCode,
      status: result.exitCode === 0 ? "succeeded" : "failed",
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      producedArtifacts: [],
      stdoutHash: stdout.hash,
      stderrHash: stderr.hash,
      envHash: null,
    });
    return result;
  }

  async executeScientific(options: RecordExecutionOptions): Promise<PythonExecutionResult> {
    const executionId = randomUUID();
    const language = options.language ?? "python";
    const kernelMode = options.kernelMode ?? "ephemeral";
    if (!options.environmentRevisionId && language === "python") {
      const packageSpec = await this.cas.put(DEFAULT_ENVIRONMENT_PACKAGE_SPEC);
      if (packageSpec.hash !== DEFAULT_ENVIRONMENT_PACKAGE_SPEC_HASH) {
        throw new Error("Environment package spec hash is inconsistent");
      }
    }
    const code = await this.cas.put(options.code);
    let result: PythonExecutionResult;

    try {
      result = await options.runnerClient.execute({
        agentId: options.agentId,
        code: options.code,
        environmentRevisionId: options.environmentRevisionId,
        ...(options.executionTimeoutMs !== undefined ? { executionTimeoutMs: options.executionTimeoutMs } : {}),
        executionId,
        ...(options.kernelIdleTimeoutMs !== undefined ? { kernelIdleTimeoutMs: options.kernelIdleTimeoutMs } : {}),
        ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
        ...(options.maxWorkspaceBytes !== undefined ? { maxWorkspaceBytes: options.maxWorkspaceBytes } : {}),
        kernelMode,
        language,
        permissionEpoch: options.permissionEpoch,
        ...(options.readOnlyWorkspaceRoot ? { readOnlyWorkspaceRoot: options.readOnlyWorkspaceRoot } : {}),
        workspaceRoot: options.workspaceRoot,
      }, options.signal);
    } catch (error) {
      const timestamp = new Date().toISOString();
      const stdout = await this.cas.put("");
      const stderr = await this.cas.put(error instanceof Error ? error.message : "Runner execution failed");
      await this.store.appendExecutionRun({
        cgroupMode: "unavailable",
        code,
        createdFiles: [],
        environmentRevisionId: options.environmentRevisionId ?? options.permissionEpoch.environmentRevisionId,
        envSnapshot: null,
        exitCode: null,
        finishedAt: timestamp,
        id: executionId,
        kernelId: `ephemeral:${executionId}`,
        kernelMode,
        language,
        modifiedFiles: [],
        networkAccessRevision: epochSandboxNetworkAccess(options.permissionEpoch).revision,
        networkPolicy: options.permissionEpoch.networkPolicy,
        permissionEpochId: options.permissionEpoch.id,
        runnerVersion: "unavailable",
        sandbox: "bubblewrap",
        sessionId: options.sessionId,
        startedAt: timestamp,
        status: interruptedExecutionStatus(options.signal),
        stderr,
        stdout,
        tool: language === "python" ? "run_python" : "run_r",
        toolVersion: "2.1.0",
        turnId: options.turnId,
        workingDirectory: "unavailable",
      });
      throw error;
    }

    const stdout = await this.cas.put(result.stdout);
    const stderr = await this.cas.put(result.stderr);
    let environmentSyncError: Error | undefined;
    try {
      if (result.environmentRevisionId !== DEFAULT_ENVIRONMENT_REVISION_ID) {
        const [environments, revisions] = await Promise.all([
          options.runnerClient.listEnvironments(),
          options.runnerClient.listEnvironmentRevisions(),
        ]);
        const revision = revisions.find((candidate) => candidate.id === result.environmentRevisionId);
        if (!revision) throw new Error(`Runner omitted Environment Revision ${result.environmentRevisionId} from its catalog`);
        const snapshot = await options.runnerClient.environmentSnapshot(revision.id);
        const reference = await this.cas.put(snapshot);
        if (reference.hash !== revision.snapshot.hash || reference.size !== revision.snapshot.size) {
          throw new Error(`Environment Revision snapshot mismatch: ${revision.id}`);
        }
        await this.store.replaceScientificEnvironmentCatalog(environments, revisions);
      }
    } catch (error) {
      environmentSyncError = error instanceof Error ? error : new Error("Environment Revision sync failed");
    }
    await this.store.appendExecutionRun({
      cgroupMode: result.cgroupMode,
      code,
      createdFiles: result.createdFiles,
      environmentRevisionId: result.environmentRevisionId,
      envSnapshot: await this.putEnvSnapshot(result.environmentVariables),
      exitCode: result.exitCode,
      finishedAt: result.finishedAt,
      id: executionId,
      kernelId: result.kernelId,
      kernelMode: result.kernelMode,
      language: result.language,
      modifiedFiles: result.modifiedFiles,
      ...(result.networkAccessRevision ? { networkAccessRevision: result.networkAccessRevision } : {}),
      networkPolicy: result.networkPolicy,
      permissionEpochId: options.permissionEpoch.id,
      runnerVersion: result.runnerVersion,
      sandbox: result.sandbox,
      sessionId: options.sessionId,
      startedAt: result.startedAt,
      status: result.exitCode === 0 ? "succeeded" : "failed",
      stderr,
      stdout,
      tool: result.language === "python" ? "run_python" : "run_r",
      toolVersion: "2.1.0",
      turnId: options.turnId,
      workingDirectory: result.workingDirectory,
    });

    const paths = [...new Set([...result.createdFiles, ...result.modifiedFiles])];
    await this.recordGeneratedFiles({
      artifactPathPrefix: options.artifactPathPrefix,
      code: options.code,
      executionId,
      finishedAt: result.finishedAt,
      paths,
      sessionId: options.sessionId,
      turnId: options.turnId,
      workspaceRoot: options.workspaceRoot,
    });
    // env snapshot hash for the provenance mirror: the revision's snapshot.hash
    // (already CAS-verified equal during sync above). Read from the store's
    // environment catalog by revision id so a sync failure (environmentSyncError)
    // doesn't block the mirror — the catalog still holds the revision snapshot.
    const envRevision = result.environmentRevisionId
      ? this.store.listEnvironmentRevisions().find((candidate) => candidate.id === result.environmentRevisionId)
      : undefined;
    this.observeExecution({
      executionId,
      sessionId: options.sessionId,
      turnId: options.turnId,
      tool: result.language === "python" ? "run_python" : "run_r",
      language: result.language,
      codeHash: code.hash,
      exitCode: result.exitCode,
      status: result.exitCode === 0 ? "succeeded" : "failed",
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      producedArtifacts: [],
      stdoutHash: stdout.hash,
      stderrHash: stderr.hash,
      envHash: envRevision?.snapshot.hash ?? null,
    });
    if (environmentSyncError) throw environmentSyncError;
    return result;
  }
}

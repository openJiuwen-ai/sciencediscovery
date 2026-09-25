// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { recordingStage, type RecordingIdentity } from "../agent-run/recording-wait.js";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RefStore, committedWorkspaceSnapshot, StepCommitCoordinator, VersionStore,
  type AgentStateRef, type TrajectoryStep,
} from "@sciencediscovery/cas";
import type { RuntimeMessage, RuntimeToolCall, RunEvent, TurnLifecycle } from "@sciencediscovery/runtime-core";
import type { StateCheckpoint, StateView, StateProvider } from "@sciencediscovery/context";
import type { AgentEventEvidence, RunStreamEvent } from "@sciencediscovery/schema";

export interface AgentVersioningOptions {
  agentId: string;
  trajectoryId: string;
  requestExecutionId: string;
  /** Authority adapter, not a reconstruction from truncated model messages. */
  readAuthorities?: () => Promise<unknown>;
  /** The host's existing persisted Run stream, not a second trajectory log. */
  recordEvent?: (event: RunStreamEvent) => Promise<void>;
}

export interface AgentManifest {
  harness: AgentStateRef;
  behavior: unknown;
}

export interface AgentRevision {
  agentId: string;
  trajectoryId: string;
  requestExecutionId: string;
  manifest: AgentStateRef;
  parentRevision: AgentStateRef | null;
}

export interface ModelContextSnapshot<I = unknown> {
  boundary: "ProviderModelClient.invoke";
  input: I;
}

export interface ContextAssemblyRecord {
  capturedAt?: string;
  checkpoint?: StateCheckpoint;
  turn: number;
  manifest: AgentStateRef;
  state: AgentStateRef;
  modelContext: AgentStateRef;
  trace: unknown;
}

export interface AgentStateSnapshot {
  checkpoint?: StateCheckpoint;
  agentId: string;
  trajectoryId: string;
  turn: number;
  phase: "before" | "after";
  manifest: AgentStateRef;
  agentRevision: AgentStateRef;
  predecessor: AgentStateRef | null;
  workspace: AgentStateRef;
  transcript: RuntimeMessage[];
  history: RuntimeMessage[];
  runtime: unknown;
  authorities: unknown;
  observations: AgentStateRef[];
  forkFidelity: { component: string; fidelity: "restorable" | "reference-only" | "external-side-effect"; detail: string }[];
}

/** Convert optional object fields to their existing JSON wire semantics before strict JCS. */
export function jsonValue<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

let buildDescriptor: Promise<AgentStateRef["digest"]> | undefined;
export function harnessBuildDigest(): Promise<AgentStateRef["digest"]> {
  buildDescriptor ??= (async () => {
    const hash = createHash("sha256");
    const walk = async (root: string, dir: string): Promise<void> => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) await walk(root, path);
        else if (entry.isFile() && /\.(js|ts)$/.test(entry.name) && !/\.(test|d)\.(js|ts)$/.test(entry.name)) {
          hash.update(relative(root, path)); hash.update("\0"); hash.update(await readFile(path)); hash.update("\0");
        }
      }
    };
    const packages = ["runtime-core", "context", "model", "tools", "workspace", "plan", "evolve", "orchestration",
      "plugin-sdk", "skill", "mcp", "scheduler", "mcp-sources"];
    for (const name of packages) {
      const root = dirname(fileURLToPath(import.meta.resolve(`@sciencediscovery/${name}`)));
      hash.update(name); await walk(root, root);
    }
    const api = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    hash.update("api"); await walk(api, api);
    return `sha256:${hash.digest("hex")}`;
  })();
  return buildDescriptor;
}

export function agentHeadName(agentId: string): string { return `agents/${encodeURIComponent(agentId)}/head`; }

export class AgentStateAssembler {
  constructor(private readonly store: VersionStore, private readonly workspaceRoot: string,
    private readonly readRuntime: () => unknown, private readonly readAuthorities: () => Promise<unknown>,
    private readonly identity: RecordingIdentity = {}) {
    const rel = relative(resolve(workspaceRoot), resolve(store.dataDir, "versioning"));
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) {
      throw new Error("Version store must be outside the Agent workspace");
    }
  }

  captureWorkspace(): Promise<AgentStateRef> {
    return recordingStage("workspace_snapshot", this.identity, () => committedWorkspaceSnapshot(this.store, this.workspaceRoot));
  }

  async assemble(input: Omit<AgentStateSnapshot, "workspace" | "runtime" | "authorities" | "forkFidelity">, view?: StateView): Promise<AgentStateRef> {
    const authorities = view ? view.read("authorities") : await recordingStage("authority_capture", this.identity, () => this.readAuthorities());
    const workspace = view ? view.read<AgentStateRef>("workspace") : await this.captureWorkspace();
    return this.store.putRecord("AgentStateSnapshot", jsonValue({
      ...input, workspace, runtime: view ? view.read("runtime") : this.readRuntime(), authorities,
      ...(view ? { checkpoint: view.checkpoint } : {}),
      forkFidelity: [
        { component: "agent-state-and-workspace", fidelity: "restorable", detail: "Captured logical state and Linux file tree; no restore API in this phase" },
        { component: "kernel-environment-memory-graph", fidelity: "reference-only", detail: "External authority identifiers are captured; process heaps and graph databases are not snapshotted" },
        { component: "external-effects", fidelity: "external-side-effect", detail: "Network calls, remote jobs and external writes cannot be rolled back" },
      ],
    }));
  }
}

export class AgentVersionRecorder<M extends RuntimeMessage, I, U> implements TurnLifecycle<M, I, U> {
  readonly store: VersionStore;
  private refs!: RefStore;
  private coordinator!: StepCommitCoordinator;
  private manifest!: AgentStateRef;
  private revision!: AgentStateRef;
  private head: AgentStateRef | null = null;
  private before!: AgentStateRef;
  private modelContext!: AgentStateRef;
  private modelAction?: AgentStateRef;
  private context!: AgentStateRef;
  private activeContext?: AgentStateRef;
  private transcript: M[] = [];
  private observations: AgentStateRef[] = [];
  private turnObservations: { sequence: number; ref: AgentStateRef }[] = [];
  private children: AgentStateRef[] = [];
  private assemblyTrace: unknown = null;
  private currentTurn = 0;
  private responseId?: string;
  private pending = Promise.resolve();
  private readonly assembler: AgentStateAssembler;
  private inputView?: StateView;

  constructor(dataDir: string, workspaceRoot: string, readonly options: AgentVersioningOptions, readRuntime: () => unknown) {
    this.store = new VersionStore(dataDir);
    this.assembler = new AgentStateAssembler(this.store, workspaceRoot, readRuntime, options.readAuthorities ?? (async () => ({})), { agentId: options.agentId, trajectoryId: options.trajectoryId });
  }

  async initialize(behavior: unknown, history: M[]): Promise<void> {
    this.refs = await RefStore.open(this.store);
    this.coordinator = new StepCommitCoordinator(this.store, this.refs, agentHeadName(this.options.agentId));
    this.head = this.refs.head(this.coordinator.name);
    this.transcript = structuredClone(history);
    const harness = await this.store.putRecord("HarnessBuild", { digest: await harnessBuildDigest(), runtime: process.version });
    this.manifest = await this.store.putRecord("AgentManifest", jsonValue({ harness, behavior } satisfies AgentManifest));
    const previous = this.head ? (await this.store.readRecord<TrajectoryStep>(this.head, "TrajectoryStep")).value : null;
    this.revision = await this.store.putRecord("AgentRevision", {
      agentId: this.options.agentId, trajectoryId: this.options.trajectoryId,
      requestExecutionId: this.options.requestExecutionId,
      manifest: this.manifest, parentRevision: previous?.revision ?? null,
    } satisfies AgentRevision);
    const initialState = await this.state(0, "before", history);
    const start = await this.store.putRecord("TrajectoryStart", { revision: this.revision, initialState });
    await this.refs.commit(this.store, `trajectories/${encodeURIComponent(this.options.trajectoryId)}/start`, null, start);
    await this.refs.commit(this.store, `agents/${encodeURIComponent(this.options.agentId)}/trajectories/${encodeURIComponent(this.options.trajectoryId)}`, null, start);
  }

  async beforeTurn({ turn, history }: Parameters<TurnLifecycle<M, I, U>["beforeTurn"]>[0]): Promise<void> {
    this.turnObservations = [];
    this.currentTurn = turn;
    this.activeContext = undefined;
    this.responseId = undefined;
    this.children = [];
    this.assemblyTrace = null;
    this.before = await this.state(turn, "before", history);
  }

  trace(record: unknown): void { this.assemblyTrace = jsonValue(record); }

  workspaceStateProvider(): StateProvider {
    return {
      id: "workspace",
      capture: async (signal) => {
        signal.throwIfAborted();
        const value = await this.assembler.captureWorkspace();
        return { id: "workspace", schemaVersion: 1, revision: value.digest, value, fidelity: "captured" };
      },
    };
  }

  async captureInputState(view: StateView, turn: number, history: M[]): Promise<void> {
    this.inputView = view;
    this.before = await this.state(turn, "before", history, view);
  }

  async afterAssembly({ turn, assembly }: Parameters<TurnLifecycle<M, I, U>["afterAssembly"]>[0]): Promise<void> {
    // The new response ID is allocated by the loop after assembly, including retries.
    this.responseId = undefined;
    this.modelContext = await this.store.putRecord("ModelContextSnapshot", jsonValue({
      boundary: "ProviderModelClient.invoke", input: assembly.modelInput,
    } satisfies ModelContextSnapshot<I>));
    this.modelAction = undefined;
    this.context = await this.store.putRecord("ContextAssemblyRecord", jsonValue({
      turn, manifest: this.manifest, state: this.before, modelContext: this.modelContext, trace: this.assemblyTrace,
      ...(this.inputView ? { checkpoint: this.inputView.checkpoint } : {}),
    } satisfies ContextAssemblyRecord));
    // Root the exact input before invoking the model, including attempts that later fail or cancel.
    // This is an audit root, not a completed Step and never advances the Agent head.
    // Input-overflow recovery assembles again within the same turn. History
    // keeps both attempts while the live audit ref tracks the latest input.
    const name = `attempts/${encodeURIComponent(this.options.trajectoryId)}/${turn}`;
    await recordingStage("context_ref_commit", { agentId: this.options.agentId, trajectoryId: this.options.trajectoryId, turn },
      () => this.refs.commit(this.store, name, this.refs.head(name), this.context));
    this.activeContext = this.context;
    await this.record("context.captured", undefined, this.before);
  }

  async recordObservation(input: { call: RuntimeToolCall; content: string; details?: unknown; isError: boolean; sequence: number }): Promise<void> {
    const content = await this.store.put("agent-state", input.content, "text/plain;charset=utf-8");
    const ref = await this.store.putRecord("ToolObservation", jsonValue({ ...input, content }));
    this.turnObservations.push({ sequence: input.sequence, ref });
  }

  event(event: RunEvent<U>): AgentEventEvidence {
    if (event.type === "turn_start") this.currentTurn = event.turn;
    if (event.type === "response_start") this.responseId = event.responseId;
    if (event.type === "context_recovery") {
      void this.record("context_recovery", jsonValue(event));
    }
    return this.evidence();
  }

  async modelCompleted(result: unknown): Promise<void> {
    await this.pending;
    // Persist the authoritative action once, before tools run (including failures).
    // Both the Run event and the committed Step reference this same object.
    this.modelAction = await this.store.putRecord("ModelAction", jsonValue({ modelContext: this.modelContext, result }));
    await this.record("model.completed", undefined, undefined, this.evidence(), this.modelAction);
  }

  childCompleted(agentId: string): void {
    const child = this.refs.head(agentHeadName(agentId));
    if (child) this.children.push(child);
  }

  async afterTurn({ turn, history, modelTurn, results }: Parameters<TurnLifecycle<M, I, U>["afterTurn"]>[0]): Promise<void> {
    this.transcript.push(structuredClone(modelTurn.assistantMessage), ...results.map((result) => structuredClone(result.message)));
    const raw = this.turnObservations.sort((a, b) => a.sequence - b.sequence).map((item) => item.ref);
    this.observations.push(...raw);
    const actions: AgentStateRef[] = [this.modelAction ?? await this.store.putRecord("ModelAction", jsonValue({ modelContext: this.modelContext, result: modelTurn }))];
    for (const [index, call] of modelTurn.toolCalls.entries()) {
      actions.push(await this.store.putRecord("ToolAction", jsonValue({ call, result: results[index], observation: raw[index] ?? null })));
    }
    const eventSegments: TrajectoryStep["eventSegments"] = [];
    const after = await this.state(turn, "after", history);
    this.head = await recordingStage("step_commit", { agentId: this.options.agentId, trajectoryId: this.options.trajectoryId, turn }, () => this.coordinator.commit({
      agentId: this.options.agentId, trajectoryId: this.options.trajectoryId, turn,
      parent: this.head, revision: this.revision, before: this.before, after,
      context: this.context, modelContext: this.modelContext, actions, childTrajectories: this.children, eventSegments,
    }));
    await this.record("state.committed", undefined, after);
  }

  private evidence(): AgentEventEvidence {
    return { agentId: this.options.agentId, agentRunId: this.options.trajectoryId,
      requestExecutionId: this.options.requestExecutionId, recordedAt: new Date().toISOString(), turn: this.currentTurn,
      ...(this.responseId ? { responseId: this.responseId } : {}),
      ...(this.activeContext ? { contextRef: this.activeContext, stateRef: this.before } : {}) };
  }

  private record(name: Extract<RunStreamEvent, { type: "agent.record" }>["name"], payload?: unknown,
    stateRef?: AgentStateRef, evidence = this.evidence(), existingPayload?: AgentStateRef): Promise<void> {
    if (!this.options.recordEvent) return Promise.resolve();
    const value = structuredClone(payload);
    this.pending = this.pending.then(async () => {
      const payloadRef = existingPayload ?? (value === undefined ? undefined : await this.store.putRecord("AgentEventPayload", value));
      await this.options.recordEvent!({ type: "agent.record", name, evidence: { ...evidence, ...(stateRef ? { stateRef } : {}) },
        ...(payloadRef ? { payloadRef } : {}) });
    });
    // Synchronous loop notifications are drained at the next awaited boundary.
    void this.pending.catch(() => undefined);
    return this.pending;
  }

  /** Drain supplemental records even after failure, without advancing the Agent head. */
  async flushEvents(): Promise<void> {
    await this.pending;
  }

  close(): void { this.refs?.close(); }

  private state(turn: number, phase: "before" | "after", history: M[], view?: StateView): Promise<AgentStateRef> {
    return this.assembler.assemble({
      agentId: this.options.agentId, trajectoryId: this.options.trajectoryId, turn, phase,
      manifest: this.manifest, predecessor: this.head, transcript: this.transcript,
      agentRevision: this.revision,
      history, observations: this.observations,
    }, view);
  }
}

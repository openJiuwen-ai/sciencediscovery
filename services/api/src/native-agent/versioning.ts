// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RefStore, committedWorkspaceSnapshot, StepCommitCoordinator, VersionStore,
  type AgentStateRef, type TrajectoryStep,
} from "@sciencediscovery/cas";
import type { RuntimeMessage, RuntimeToolCall, RunEvent, TurnLifecycle } from "@sciencediscovery/runtime-core";

export interface AgentVersioningOptions {
  agentId: string;
  trajectoryId: string;
  requestExecutionId: string;
  /** Authority adapter, not a reconstruction from truncated model messages. */
  readAuthorities?: () => Promise<unknown>;
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
  turn: number;
  manifest: AgentStateRef;
  state: AgentStateRef;
  modelContext: AgentStateRef;
  trace: unknown;
}

export interface AgentStateSnapshot {
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
    const packages = ["runtime-core", "context", "model", "tools", "workspace", "plan", "evolve", "orchestration"];
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
    private readonly readRuntime: () => unknown, private readonly readAuthorities: () => Promise<unknown>) {
    const rel = relative(resolve(workspaceRoot), resolve(store.dataDir, "versioning"));
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) {
      throw new Error("Version store must be outside the Agent workspace");
    }
  }

  async assemble(input: Omit<AgentStateSnapshot, "workspace" | "runtime" | "authorities" | "forkFidelity">): Promise<AgentStateRef> {
    const authorities = await this.readAuthorities();
    const workspace = await committedWorkspaceSnapshot(this.store, this.workspaceRoot);
    return this.store.putRecord("AgentStateSnapshot", jsonValue({
      ...input, workspace, runtime: this.readRuntime(), authorities,
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
  private context!: AgentStateRef;
  private transcript: M[] = [];
  private observations: AgentStateRef[] = [];
  private turnObservations: { sequence: number; ref: AgentStateRef }[] = [];
  private events = new Map<string, unknown[]>();
  private offsets = new Map<string, number>();
  private children: AgentStateRef[] = [];
  private assemblyTrace: unknown = null;
  private readonly assembler: AgentStateAssembler;

  constructor(dataDir: string, workspaceRoot: string, readonly options: AgentVersioningOptions, readRuntime: () => unknown) {
    this.store = new VersionStore(dataDir);
    this.assembler = new AgentStateAssembler(this.store, workspaceRoot, readRuntime, options.readAuthorities ?? (async () => ({})));
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
  }

  async beforeTurn({ turn, history }: Parameters<TurnLifecycle<M, I, U>["beforeTurn"]>[0]): Promise<void> {
    this.turnObservations = [];
    this.events.clear();
    this.children = [];
    this.assemblyTrace = null;
    this.before = await this.state(turn, "before", history);
  }

  trace(record: unknown): void { this.assemblyTrace = jsonValue(record); }

  async afterAssembly({ turn, assembly }: Parameters<TurnLifecycle<M, I, U>["afterAssembly"]>[0]): Promise<void> {
    this.modelContext = await this.store.putRecord("ModelContextSnapshot", jsonValue({
      boundary: "ProviderModelClient.invoke", input: assembly.modelInput,
    } satisfies ModelContextSnapshot<I>));
    this.context = await this.store.putRecord("ContextAssemblyRecord", jsonValue({
      turn, manifest: this.manifest, state: this.before, modelContext: this.modelContext, trace: this.assemblyTrace,
    } satisfies ContextAssemblyRecord));
    // Root the exact input before invoking the model, including attempts that later fail or cancel.
    // This is an audit root, not a completed Step and never advances the Agent head.
    // Input-overflow recovery assembles again within the same turn. History
    // keeps both attempts while the live audit ref tracks the latest input.
    const name = `attempts/${encodeURIComponent(this.options.trajectoryId)}/${turn}`;
    await this.refs.commit(this.store, name, this.refs.head(name), this.context);
  }

  async recordObservation(input: { call: RuntimeToolCall; content: string; details?: unknown; isError: boolean; sequence: number }): Promise<void> {
    const content = await this.store.put("agent-state", input.content, "text/plain;charset=utf-8");
    const ref = await this.store.putRecord("ToolObservation", jsonValue({ ...input, content }));
    this.turnObservations.push({ sequence: input.sequence, ref });
  }

  event(event: RunEvent<U>): void {
    const stream = event.type === "tool_execution_start" || event.type === "tool_execution_end"
      ? `tool:${event.call.id}` : this.options.agentId;
    const values = this.events.get(stream) ?? [];
    values.push(jsonValue(event)); this.events.set(stream, values);
  }

  childCompleted(agentId: string): void {
    const child = this.refs.head(agentHeadName(agentId));
    if (child) this.children.push(child);
  }

  async afterTurn({ turn, history, modelTurn, results }: Parameters<TurnLifecycle<M, I, U>["afterTurn"]>[0]): Promise<void> {
    this.transcript.push(structuredClone(modelTurn.assistantMessage), ...results.map((result) => structuredClone(result.message)));
    const raw = this.turnObservations.sort((a, b) => a.sequence - b.sequence).map((item) => item.ref);
    this.observations.push(...raw);
    const actions: AgentStateRef[] = [await this.store.putRecord("ModelAction", jsonValue({ modelContext: this.modelContext, result: modelTurn }))];
    for (const [index, call] of modelTurn.toolCalls.entries()) {
      actions.push(await this.store.putRecord("ToolAction", jsonValue({ call, result: results[index], observation: raw[index] ?? null })));
    }
    const eventSegments: TrajectoryStep["eventSegments"] = [];
    for (const [stream, events] of this.events) {
      const start = this.offsets.get(stream) ?? 0;
      const end = start + events.length;
      eventSegments.push({ stream, start, end, events: await this.store.putRecord("EventSegment", { stream, events }) });
      this.offsets.set(stream, end);
    }
    const after = await this.state(turn, "after", history);
    this.head = await this.coordinator.commit({
      agentId: this.options.agentId, trajectoryId: this.options.trajectoryId, turn,
      parent: this.head, revision: this.revision, before: this.before, after,
      context: this.context, modelContext: this.modelContext, actions, childTrajectories: this.children, eventSegments,
    });
  }

  close(): void { this.refs?.close(); }

  private state(turn: number, phase: "before" | "after", history: M[]): Promise<AgentStateRef> {
    return this.assembler.assemble({
      agentId: this.options.agentId, trajectoryId: this.options.trajectoryId, turn, phase,
      manifest: this.manifest, predecessor: this.head, transcript: this.transcript,
      agentRevision: this.revision,
      history, observations: this.observations,
    });
  }
}

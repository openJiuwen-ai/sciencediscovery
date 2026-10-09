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

import { recordingStage } from "./recording-wait.js";
import { createHash } from "node:crypto";

import { canonicalState, captureStateView, type StateProvider, type StateView } from "@sciencediscovery/context";
import type { ModelTurn } from "@sciencediscovery/model";
import type { AgentEventEvidence } from "@sciencediscovery/schema";

import type { NativeAgentOptions } from "../native-agent/index.js";
import { AgentVersionRecorder, jsonValue } from "../native-agent/versioning.js";

/** What the model was given for one call: the system prompt, the conversation and the tools, as sent. */
export interface ModelCallInput {
  history: unknown[];
  systemPrompt: string;
  tools: unknown[];
}

/**
 * The assembly record for one call, in the shape the trajectory viewer reads.
 *
 * The built-in loop's dynamic assembler reports the system prompt as the ordered sections it
 * admitted, each with the component that contributed it, which is how the viewer can say where
 * every part of the prompt came from. JiuwenSwarm owns its own loop and hands over the prompt it
 * assembled whole, with no section boundaries to report — but the source is not therefore unknown:
 * it is JiuwenSwarm, and the prompt recorded here is exactly the one that was sent. Reporting that
 * as the one section it is tells the reader the truth; leaving the trace out made the viewer label
 * the block "origin unavailable", which is a stronger claim than the backend's actual limitation.
 */
function assemblyTrace(input: ModelCallInput): Record<string, unknown> {
  const section = { id: "jiuwenswarm-system", slot: "system", contributorId: "jiuwenswarm", content: input.systemPrompt };
  return {
    admitted: { sections: [section] },
    renderedContext: { sectionIds: [section.id] },
    // Not "dynamic" (this process assembled nothing) and not "legacy": an external executor did.
    selectedPath: "external",
  };
}

/** One component of a state checkpoint, identified and hashed the way the built-in loop does its own. */
export function stateProvider(id: string, read: () => unknown | Promise<unknown>,
  fidelity: "captured" | "reference-only" = "captured"): StateProvider {
  return {
    id,
    capture: async () => {
      const value = jsonValue(await read());
      return { id, schemaVersion: 1, revision: createHash("sha256").update(canonicalState(value)).digest("hex"), value, fidelity };
    },
  };
}

/**
 * The run's trajectory, recorded as the built-in loop records it, for the JiuwenSwarm executor.
 *
 * JiuwenSwarm owns the loop, but every model call passes through the run's model gateway and every tool result
 * through this process, so the same `AgentVersionRecorder` records each turn: the exact model input before the
 * call, the model's answer after it, the tool observations, and the step once the next call (or the end of the
 * run) shows the turn is over. Events are tagged with the recorder's evidence, which is how the trajectory view
 * ties them to the model input they belong to.
 */
export class JiuwenSwarmTrajectory {
  private readonly recorder?: AgentVersionRecorder<never, ModelCallInput, unknown>;
  /**
   * `modelRequest` increments before it records, so this starts one below the first turn number.
   * The built-in loop counts `for (let turn = 0; …)`, and the trajectory's own readers rely on that
   * number meaning the same thing under either executor — an export marks where a Run began by its
   * turn-0 records, which numbering from 1 left with no turn 0 at all.
   */
  private turn = -1;
  private sequence = 0;
  private pending?: { history: unknown[]; modelTurn: ModelTurn; turn: number };
  private readonly results = new Map<string, { content: string; details?: unknown; isError: boolean }>();
  private queue = Promise.resolve();
  private readonly readRuntime: () => unknown;
  private readonly readAuthorities: () => Promise<unknown>;
  private readonly trajectoryId: string;
  private readonly sessionId: string;
  private stateCapture?: { providers: readonly StateProvider[]; scope: string; signal: AbortSignal };

  constructor(options: NativeAgentOptions, readRuntime: () => unknown = () => ({ executor: "jiuwenswarm" })) {
    this.sessionId = options.sessionId;
    this.readRuntime = readRuntime;
    // The same fallback the recorder's own assembler uses, so a view reports what a viewless
    // capture would have read.
    this.readAuthorities = options.versioning?.readAuthorities ?? (async () => ({}));
    this.trajectoryId = options.versioning?.trajectoryId ?? "";
    if (options.versioning) {
      this.recorder = new AgentVersionRecorder(options.config.dataDir, options.workspaceRoot, options.versioning, readRuntime);
    }
  }

  /**
   * The component states this run's turns are recorded against.
   *
   * A state snapshot carries a `checkpoint` — the component ids, revisions and fidelity the trajectory
   * viewer lists under "Component states" — only when the state was assembled through a `StateView`.
   * The built-in loop builds that view inside its context assembler; JiuwenSwarm owns the loop, so
   * nothing on this path ever built one and every snapshot went out without a checkpoint at all. The
   * components are in this process regardless (the same tool registry, the same durable context, the
   * same workspace), so they are captured here instead.
   *
   * What this checkpoint claims is narrower than the built-in loop's, and deliberately so: there it
   * records the state the turn was *assembled from*, while here it records the state read at the call
   * — JiuwenSwarm assembled the prompt itself, out of process. `tools` is ScienceDiscovery's registry,
   * which is what the bridge exposes and what every tool result came back through; JiuwenSwarm's own
   * native tools do not pass through it and are not in it.
   */
  useStateProviders(input: { providers: readonly StateProvider[]; scope: string; signal: AbortSignal }): void {
    if (!this.recorder) return;
    this.stateCapture = {
      providers: [
        ...input.providers,
        this.recorder.workspaceStateProvider(),
        stateProvider("runtime", () => this.readRuntime()),
        stateProvider("authorities", () => this.readAuthorities(), "reference-only"),
      ],
      scope: input.scope,
      signal: input.signal,
    };
  }

  /**
   * Recording must not end a run that is otherwise fine. Without a view the snapshot is exactly what
   * it was before any of this existed, minus the checkpoint, and the reason is logged rather than lost.
   */
  private async captureState(turn: number): Promise<StateView | undefined> {
    const capture = this.stateCapture;
    if (!capture) return undefined;
    try {
      return await captureStateView({ id: `${this.trajectoryId}:${turn}`, providers: capture.providers, scope: capture.scope, signal: capture.signal });
    } catch (error) {
      console.warn(`[jiuwenswarm-trajectory] state capture for turn ${turn} failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  get enabled(): boolean {
    return Boolean(this.recorder);
  }

  async start(behavior: unknown): Promise<void> {
    await this.recorder?.initialize(behavior, []);
  }

  /** Serialized: JiuwenSwarm can overlap requests (a title while the turn runs); the recorder takes one at a time. */
  private stage<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return recordingStage(name, { sessionId: this.sessionId, trajectoryId: this.trajectoryId, turn: this.turn },
      operation, this.stateCapture?.signal);
  }

  private run(name: string, step: () => Promise<void>): Promise<void> {
    const ready = this.stage(`${name}.queue`, () => this.queue.catch(() => undefined));
    this.queue = ready.then(step, step);
    return this.queue;
  }

  /** A model call is about to be made: the turn before it is over, and this one begins with its exact input. */
  modelRequest(input: ModelCallInput): Promise<void> {
    if (!this.recorder) return Promise.resolve();
    return this.run("model_request", async () => {
      await this.stage("commit_pending", () => this.commitPending());
      this.turn += 1;
      const history = input.history as never[];
      await this.stage("before_turn", () => this.recorder!.beforeTurn({ turn: this.turn, history }));
      // Same order as the built-in loop: the turn opens, then its context assembler captures the
      // input state and hands the view to the recorder, which is what puts a checkpoint in the
      // snapshot `beforeTurn` just took without one.
      const view = await this.stage("capture_state", () => this.captureState(this.turn));
      if (view) await this.stage("capture_input_state", () => this.recorder!.captureInputState(view, this.turn, history));
      // The trace is a separate entry point, not part of the assembly argument: `afterAssembly`
      // reads only `modelInput` and folds in whatever `trace()` last recorded. The built-in loop
      // calls them in this order too (its assembler's onTrace runs before the turn is assembled).
      this.recorder!.trace(assemblyTrace(input));
      await this.stage("after_assembly", () => this.recorder!.afterAssembly({ turn: this.turn, assembly: { history, modelInput: input } }));
    });
  }

  /** The model answered the current call. */
  modelCompleted(turn: ModelTurn, history: unknown[]): Promise<void> {
    if (!this.recorder) return Promise.resolve();
    return this.run("model_completed", async () => {
      await this.stage("model_completed", () => this.recorder!.modelCompleted(turn));
      this.pending = { history: [...history, turn.assistantMessage], modelTurn: turn, turn: this.turn };
    });
  }

  /** A tool finished (one of ours, through the bridge, or one of JiuwenSwarm's own). */
  async observe(input: { call: { args: unknown; id: string; name: string }; content: string; details?: unknown; isError: boolean }): Promise<void> {
    if (!this.recorder) return;
    this.results.set(input.call.id, { content: input.content, isError: input.isError, ...(input.details !== undefined ? { details: input.details } : {}) });
    await this.recorder.recordObservation({ ...input, call: input.call as never, sequence: this.sequence++ });
  }

  /** The evidence an event carries: which run, turn, response and model input it belongs to. */
  evidence(event: { type: string; responseId?: unknown; turn?: unknown }): AgentEventEvidence | undefined {
    if (!this.recorder) return undefined;
    // The turn is not decoration on a `turn_start`: the recorder assigns it to `currentTurn` and
    // stamps everything recorded afterwards with it. This executor's `turn_start` carries no turn
    // (the built-in runtime's does), so forwarding the event as it arrived set `currentTurn` to
    // undefined and every later record — the turn's own model.completed included — went out with no
    // turn at all. The authoritative number is this class's own counter, the one `beforeTurn` and
    // `afterAssembly` already use, so send that rather than trusting whatever the event carried.
    const runEvent = event.type === "response_start"
      ? { type: "response_start", responseId: String(event.responseId), turn: this.turn }
      : { type: event.type, turn: this.turn };
    return this.recorder.event(runEvent as never);
  }

  /** The run ended: commit the last turn and let the records reach the run's stream. */
  finish(): Promise<void> {
    if (!this.recorder) return Promise.resolve();
    return this.run("finish", async () => {
      try {
        await this.stage("finish.commit_pending", () => this.commitPending());
        await this.stage("finish.flush_events", () => this.recorder!.flushEvents());
      } finally {
        this.recorder!.close();
      }
    });
  }

  private async commitPending(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    const results = pending.modelTurn.toolCalls.map((call) => {
      const result = this.results.get(call.id) ?? { content: "", isError: true };
      return {
        content: result.content, isError: result.isError, ...(result.details !== undefined ? { details: result.details } : {}),
        message: { role: "tool", tool_call_id: call.id, content: result.content },
      };
    });
    await this.recorder!.afterTurn({
      turn: pending.turn, history: pending.history as never[], modelTurn: pending.modelTurn as never, results: results as never,
    });
  }
}

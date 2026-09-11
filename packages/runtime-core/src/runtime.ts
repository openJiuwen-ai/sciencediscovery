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

/**
 * Provider- and domain-neutral Agent Loop.
 *
 * The core owns only universal orchestration invariants. Prompt construction,
 * context compaction, tool governance, permissions, provenance, MCP routing,
 * and provider protocols are supplied through ports by the composition root.
 */

import {
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  resolveMaxParallelToolCalls,
  scheduleToolCalls,
  type ToolExecutionMode,
} from "./tool-scheduler.js";

export type RuntimeMessage = Record<string, unknown> & { role?: string };

export interface RuntimeToolCall {
  args: Record<string, unknown>;
  argsParseError?: string;
  id: string;
  name: string;
}

export interface ContextAssembly<TMessage extends RuntimeMessage, TModelInput> {
  /** The authoritative history after context policies such as compaction. */
  history: TMessage[];
  /** Opaque, provider-adapter-specific input passed to ModelClient. */
  modelInput: TModelInput;
}

export interface ContextAssembler<TMessage extends RuntimeMessage, TModelInput> {
  assemble(input: {
    history: readonly TMessage[];
    /** Present only for the single forced rebuild after provider overflow. */
    recovery?: { attempt: 1; reason: "model-input-overflow" };
    signal: AbortSignal;
    turn: number;
    onProgress: () => void;
  }): Promise<ContextAssembly<TMessage, TModelInput>>;
}

export interface ModelClientObserver {
  onProgress(): void;
  onTextDelta(delta: string): void;
  onThinkingDelta(delta: string): void;
}

export interface ModelTurn<TMessage extends RuntimeMessage, TUsage> {
  assistantMessage: TMessage;
  toolCalls: RuntimeToolCall[];
  usage?: TUsage;
  /** The provider cut this turn at `max_tokens`. Carried so a run that ends
   *  with neither text nor a tool call can say why instead of looking idle. */
  truncated?: boolean;
}

export interface ModelClient<TMessage extends RuntimeMessage, TModelInput, TUsage> {
  /** Provider adapter owns recognition of its wire-level overflow errors. */
  isInputTooLargeError?(error: unknown): boolean;
  invoke(
    input: TModelInput,
    signal: AbortSignal,
    observer: ModelClientObserver,
  ): Promise<ModelTurn<TMessage, TUsage>>;
}

export interface ToolDispatchResult<TMessage extends RuntimeMessage> {
  /** Domain/UI-facing tool result payload. */
  content: string;
  isError: boolean;
  /** Canonical message appended to the model history. */
  message: TMessage;
}

export interface ToolDispatcher<TMessage extends RuntimeMessage> {
  /** Fail-closed scheduling classification; only an explicit parallel result overlaps. */
  executionMode?(call: RuntimeToolCall): ToolExecutionMode;
  execute(call: RuntimeToolCall, signal: AbortSignal): Promise<ToolDispatchResult<TMessage>>;
}

export type AgentLoopPhase =
  | "idle"
  | "assembling_context"
  | "calling_model"
  | "executing_tools"
  | "waiting_external"
  | "completed"
  | "cancelled"
  | "failed";

export interface AgentLoopState<TMessage extends RuntimeMessage> {
  history: TMessage[];
  phase: AgentLoopPhase;
  turn: number;
}

export interface RunTransition {
  phase: AgentLoopPhase;
  turn: number;
}

const TERMINAL_PHASES: ReadonlySet<AgentLoopPhase> = new Set(["completed", "cancelled", "failed"]);
const phaseSet = (...phases: AgentLoopPhase[]): ReadonlySet<AgentLoopPhase> => new Set(phases);
const NEXT_PHASES: Readonly<Record<AgentLoopPhase, ReadonlySet<AgentLoopPhase>>> = Object.freeze({
  idle: phaseSet("assembling_context", "cancelled", "failed"),
  assembling_context: phaseSet("calling_model", "waiting_external", "cancelled", "failed"),
  calling_model: phaseSet("assembling_context", "executing_tools", "waiting_external", "completed", "cancelled", "failed"),
  executing_tools: phaseSet("assembling_context", "waiting_external", "completed", "cancelled", "failed"),
  waiting_external: phaseSet("assembling_context", "calling_model", "executing_tools", "cancelled", "failed"),
  completed: phaseSet(),
  cancelled: phaseSet(),
  failed: phaseSet(),
});

/** Pure transition reducer used by the loop and independently testable. */
export function reduceRunState<TMessage extends RuntimeMessage>(
  state: AgentLoopState<TMessage>,
  transition: RunTransition,
): AgentLoopState<TMessage> {
  if (state.phase === transition.phase && state.turn === transition.turn) return state;
  if (!NEXT_PHASES[state.phase].has(transition.phase)) {
    throw new Error(`Invalid AgentLoop transition: ${state.phase} -> ${transition.phase}`);
  }
  return { ...state, phase: transition.phase, turn: transition.turn };
}

export type RunEvent<TUsage> =
  | { state: AgentLoopPhase; turn: number; type: "state_changed" }
  | { type: "turn_start"; turn: number }
  | { delta: string; kind: "text" | "thinking"; type: "model_delta" }
  | { call: RuntimeToolCall; type: "tool_execution_start" }
  | { call: RuntimeToolCall; content: string; isError: boolean; type: "tool_execution_end" }
  | { attempt: 1; reason: "model-input-overflow"; turn: number; type: "context_recovery" }
  | { action: "continue" | "denied" | "finish"; turn: number; type: "finish_gate" }
  | { kick: number; turn: number; type: "stall_kick" }
  | { type: "completed"; truncated?: boolean; usage?: TUsage };

export type RunEventSink<TUsage> = (event: RunEvent<TUsage>) => void;

export interface ExternalWaitHandle {
  readonly id: string;
  release(): void;
}

type ExternalWaitListener = (activeCount: number) => void;

/**
 * Run-scoped coordination for permission prompts and other external waits.
 * Every handle is independent and idempotent; one approval can never release
 * or reject another pending action.
 */
export class ExternalWaitController {
  private readonly active = new Set<string>();
  private readonly listeners = new Set<ExternalWaitListener>();
  private nextId = 0;

  get activeCount(): number {
    return this.active.size;
  }

  begin(label = "external"): ExternalWaitHandle {
    const id = `${label}:${this.nextId += 1}`;
    this.active.add(id);
    this.notify();
    let released = false;
    return Object.freeze({
      id,
      release: () => {
        if (released) return;
        released = true;
        this.active.delete(id);
        this.notify();
      },
    });
  }

  subscribe(listener: ExternalWaitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.active.size);
  }
}

/**
 * Finish-gate verdict. The model produced a turn with no tool calls — the
 * loop is about to complete. "finish" (or an undefined return) completes the
 * run; "continue" injects `message` into the canonical history and takes one
 * more model turn, consuming from the same maxModelTurns budget.
 */
export type FinishGateDecision<TMessage extends RuntimeMessage> =
  | { action: "finish" }
  | { action: "continue"; message: TMessage };

/**
 * Hard bound on finish-gate continuations per run, independent of the
 * policy's own bookkeeping: a stuck or buggy gate can never loop forever.
 * Three exactly fits the stage chain (skill audit → termination
 * intervention → grounding enforcement); anything more is churn.
 */
export const MAX_FINISH_GATE_CONTINUATIONS = 3;

/** Awaited durable boundary, unlike best-effort event observers. Failures stop the run. */
export interface TurnLifecycle<TMessage extends RuntimeMessage, TModelInput, TUsage> {
  beforeTurn(input: { turn: number; history: TMessage[] }): Promise<void>;
  afterAssembly(input: { turn: number; assembly: ContextAssembly<TMessage, TModelInput> }): Promise<void>;
  afterTurn(input: { turn: number; history: TMessage[]; modelTurn: ModelTurn<TMessage, TUsage>; results: ToolDispatchResult<TMessage>[] }): Promise<void>;
  /**
   * Optional finish gate, invoked when the model answered without tool calls,
   * AFTER afterTurn has durably recorded the turn. Returning "continue"
   * appends the message (typically a verification directive) and runs another
   * turn; the loop caps continuations at MAX_FINISH_GATE_CONTINUATIONS and
   * never exceeds maxModelTurns.
   */
  beforeFinish?(input: { turn: number; history: TMessage[]; modelTurn: ModelTurn<TMessage, TUsage> }): Promise<FinishGateDecision<TMessage> | undefined>;
}

export interface AgentLoopOptions<TMessage extends RuntimeMessage, TModelInput, TUsage> {
  contextAssembler: ContextAssembler<TMessage, TModelInput>;
  eventSink?: RunEventSink<TUsage>;
  maxModelTurns: number;
  maxParallelToolCalls?: number;
  modelClient: ModelClient<TMessage, TModelInput, TUsage>;
  /**
   * Stall guard (phase V, V2-C6 — SA stall-guard.ts adapted): when no
   * progress event arrives for idleMs during a model call, the in-flight
   * attempt is aborted and the loop injects a kick message and retries (up
   * to maxKicks; the last stall fails the run with a stall error). Only
   * the attempt is killed — the run's history and budget survive, and
   * there is deliberately no total-duration cap. Stalls inside tool
   * batches fall back to the composition's outer idle watchdog.
   */
  stallGuard?: {
    createKickMessage: (kick: number, maxKicks: number) => TMessage;
    idleMs: number;
    maxKicks: number;
  };
  toolDispatcher: ToolDispatcher<TMessage>;
  waitController?: ExternalWaitController;
  turnLifecycle?: TurnLifecycle<TMessage, TModelInput, TUsage>;
}

export interface AgentLoopResult<TMessage extends RuntimeMessage, TUsage> {
  history: TMessage[];
  turns: number;
  usage?: TUsage;
}

export class AgentLoop<TMessage extends RuntimeMessage, TModelInput, TUsage> {
  private state: AgentLoopState<TMessage> = { history: [], phase: "idle", turn: 0 };
  private readonly options: Readonly<AgentLoopOptions<TMessage, TModelInput, TUsage>>;
  private activePhase: AgentLoopPhase = "idle";

  constructor(options: AgentLoopOptions<TMessage, TModelInput, TUsage>) {
    if (!Number.isInteger(options.maxModelTurns) || options.maxModelTurns <= 0) {
      throw new Error("maxModelTurns must be a positive integer");
    }
    const maxParallelToolCalls = resolveMaxParallelToolCalls(options.maxParallelToolCalls);
    // Copy and freeze the run registry. Mutating caller-owned composition
    // objects after construction cannot alter an in-flight run.
    this.options = Object.freeze({ ...options, maxParallelToolCalls });
  }

  snapshot(): AgentLoopState<TMessage> {
    return structuredClone(this.state);
  }

  async run(history: readonly TMessage[], signal: AbortSignal, onProgress: () => void): Promise<AgentLoopResult<TMessage, TUsage>> {
    if (this.state.phase !== "idle") throw new Error("AgentLoop instances execute exactly once");
    this.state = { history: structuredClone([...history]), phase: "idle", turn: 0 };
    let usage: TUsage | undefined;
    let finishGateContinuations = 0;
    const unsubscribeWait = this.options.waitController?.subscribe((activeCount) => {
      if (this.isTerminal(this.state.phase)) return;
      if (activeCount > 0 && this.state.phase !== "waiting_external") {
        this.transition("waiting_external", this.state.turn, false);
      } else if (activeCount === 0 && this.state.phase === "waiting_external") {
        this.transition(this.activePhase, this.state.turn, false);
      }
    });
    try {
      // Stall guard state (V2-C6): a per-attempt abort controller chained to
      // the run signal, plus the idle timer reset by every progress signal.
      const stall = this.options.stallGuard;
      let stallKicks = 0;
      let attemptAbort: AbortController | undefined;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const clearStallTimer = () => {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = undefined; }
      };
      const armStallTimer = () => {
        if (!stall || stall.idleMs <= 0 || signal.aborted) return;
        clearStallTimer();
        stallTimer = setTimeout(() => attemptAbort?.abort(new Error("stall-kick")), stall.idleMs);
      };
      const attemptSignal = (): AbortSignal => {
        attemptAbort = new AbortController();
        if (signal.aborted) attemptAbort.abort(signal.reason);
        else {
          const forward = () => attemptAbort!.abort(signal.reason);
          signal.addEventListener("abort", forward, { once: true });
          // Listener hygiene: drop the forwarder when the attempt settles.
          attemptAbort.signal.addEventListener("abort", () => signal.removeEventListener("abort", forward), { once: true });
        }
        return attemptAbort.signal;
      };
      const stallKicked = (error: unknown): boolean => {
        // Only the attempt's own abort counts — an outer abort is the run ending.
        if (!stall || signal.aborted || !attemptAbort?.signal.aborted) return false;
        if (stallKicks >= stall.maxKicks) {
          // Kicks exhausted: fail with a diagnosable stall error, not the
          // transport's generic abort (review P3).
          throw new Error(`Agent run stalled: no progress after ${stall.maxKicks} stall-guard kicks (${stall.idleMs} ms each)`);
        }
        stallKicks += 1;
        this.state.history.push(structuredClone(stall.createKickMessage(stallKicks, stall.maxKicks)));
        this.emit({ kick: stallKicks, turn: this.state.turn, type: "stall_kick" });
        // The kick IS progress for the outer idle watchdog — otherwise it
        // would kill the retried run on the original stall's clock.
        onProgress();
        return true;
      };
      for (let turn = 0; turn < this.options.maxModelTurns; turn += 1) {
        this.raiseForAbort(signal);
        if (this.options.turnLifecycle) await this.options.turnLifecycle.beforeTurn({ turn, history: structuredClone(this.state.history) });
        this.raiseForAbort(signal);
        this.transition("assembling_context", turn);
        let assembly = await this.options.contextAssembler.assemble({
          history: this.state.history,
          signal,
          turn,
          onProgress,
        });
        this.raiseForAbort(signal);
        this.state.history = [...assembly.history];
        if (this.options.turnLifecycle) await this.options.turnLifecycle.afterAssembly({ turn, assembly: structuredClone(assembly) });
        this.raiseForAbort(signal);

        this.transition("calling_model", turn);
        this.emit({ type: "turn_start", turn });
        const observer: ModelClientObserver = {
          onProgress: () => { armStallTimer(); onProgress(); },
          onTextDelta: (delta) => { armStallTimer(); this.emit({ type: "model_delta", kind: "text", delta }); },
          onThinkingDelta: (delta) => { armStallTimer(); this.emit({ type: "model_delta", kind: "thinking", delta }); },
        };
        let modelTurn: ModelTurn<TMessage, TUsage>;
        const invokeOnce = async (modelInput: TModelInput): Promise<ModelTurn<TMessage, TUsage>> => {
          armStallTimer();
          try {
            return await this.options.modelClient.invoke(modelInput, attemptSignal(), observer);
          } finally {
            clearStallTimer();
          }
        };
        try {
          modelTurn = await invokeOnce(assembly.modelInput);
        } catch (error) {
          if (stallKicked(error)) continue;
          if (!this.options.modelClient.isInputTooLargeError?.(error) || signal.aborted) throw error;
          this.transition("assembling_context", turn);
          this.emit({ type: "context_recovery", attempt: 1, reason: "model-input-overflow", turn });
          assembly = await this.options.contextAssembler.assemble({
            history: this.state.history,
            recovery: { attempt: 1, reason: "model-input-overflow" },
            signal,
            turn,
            onProgress,
          });
          this.state.history = [...assembly.history];
          if (this.options.turnLifecycle) await this.options.turnLifecycle.afterAssembly({ turn, assembly: structuredClone(assembly) });
          this.raiseForAbort(signal);
          this.transition("calling_model", turn);
          try {
            modelTurn = await invokeOnce(assembly.modelInput);
          } catch (error) {
            if (stallKicked(error)) continue;
            throw error;
          }
        }
        this.raiseForAbort(signal);
        onProgress();
        if (modelTurn.usage !== undefined) usage = modelTurn.usage;
        this.state.history.push(modelTurn.assistantMessage);
        if (modelTurn.toolCalls.length === 0) {
          if (this.options.turnLifecycle) await this.options.turnLifecycle.afterTurn({ turn, history: structuredClone(this.state.history), modelTurn, results: [] });
          this.raiseForAbort(signal);
          const decision = this.options.turnLifecycle?.beforeFinish
            ? await this.options.turnLifecycle.beforeFinish({ turn, history: structuredClone(this.state.history), modelTurn })
            : undefined;
          if (decision?.action === "continue"
            && finishGateContinuations < MAX_FINISH_GATE_CONTINUATIONS
            && turn + 1 < this.options.maxModelTurns
          ) {
            finishGateContinuations += 1;
            this.state.history.push(structuredClone(decision.message));
            this.emit({ type: "finish_gate", action: "continue", turn });
            continue;
          }
          // A "continue" the caps denied is reported as denied — conflating it
          // with an actual finish verdict would hide a stuck gate.
          if (decision?.action === "continue") this.emit({ type: "finish_gate", action: "denied", turn });
          else if (decision !== undefined) this.emit({ type: "finish_gate", action: "finish", turn });
          this.transition("completed", turn);
          this.emit({
            type: "completed",
            ...(usage !== undefined ? { usage } : {}),
            ...(modelTurn.truncated ? { truncated: true } : {}),
          });
          return { history: structuredClone(this.state.history), turns: turn + 1, ...(usage !== undefined ? { usage } : {}) };
        }

        this.transition("executing_tools", turn);
        // The scheduler drains every started writer on failure/cancellation.
        // Only a successfully settled batch may reach the durable Step boundary.
        const results = await scheduleToolCalls({
          calls: modelTurn.toolCalls,
          classify: (call) => this.options.toolDispatcher.executionMode?.(call) ?? "exclusive",
          execute: (call) => this.options.toolDispatcher.execute(call, signal),
          maxParallelToolCalls: this.options.maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS,
          onResult: (call, result) => {
            this.state.history.push(result.message);
            this.emit({
              type: "tool_execution_end", call, content: result.content, isError: result.isError,
            });
            onProgress();
          },
          onStart: (call) => this.emit({ type: "tool_execution_start", call }),
          signal,
        });
        this.raiseForAbort(signal);
        if (this.options.turnLifecycle) await this.options.turnLifecycle.afterTurn({ turn, history: structuredClone(this.state.history), modelTurn, results });
        this.raiseForAbort(signal);
      }

      // Preserve the historical safety-net behavior: a bounded run returns
      // its transcript even when every allowed turn requested another tool.
      const lastTurn = this.options.maxModelTurns - 1;
      this.transition("completed", lastTurn);
      this.emit({ type: "completed", ...(usage !== undefined ? { usage } : {}) });
      return {
        history: structuredClone(this.state.history),
        turns: this.options.maxModelTurns,
        ...(usage !== undefined ? { usage } : {}),
      };
    } catch (error) {
      this.transition(signal.aborted ? "cancelled" : "failed", this.state.turn);
      throw error;
    } finally {
      unsubscribeWait?.();
    }
  }

  private transition(phase: AgentLoopPhase, turn: number, remember = true): void {
    if (remember && phase !== "waiting_external") this.activePhase = phase;
    this.state = reduceRunState(this.state, { phase, turn });
    this.emit({ type: "state_changed", state: phase, turn });
  }

  private raiseForAbort(signal: AbortSignal): void {
    if (signal.aborted) throw new Error("Agent run cancelled");
  }

  private emit(event: RunEvent<TUsage>): void {
    // Event sinks are observers. Telemetry/UI projection failures must never
    // mutate the run state machine or create a second terminal transition.
    try { this.options.eventSink?.(event); } catch { /* observer isolation */ }
  }

  private isTerminal(phase: AgentLoopPhase): boolean {
    return TERMINAL_PHASES.has(phase);
  }
}

/** Explicit, typed composition root for the stable core ports. */
export class RuntimeBuilder<TMessage extends RuntimeMessage, TModelInput, TUsage> {
  private contextAssembler?: ContextAssembler<TMessage, TModelInput>;
  private eventSink?: RunEventSink<TUsage>;
  private maxModelTurns?: number;
  private maxParallelToolCalls = DEFAULT_MAX_PARALLEL_TOOL_CALLS;
  private modelClient?: ModelClient<TMessage, TModelInput, TUsage>;
  private toolDispatcher?: ToolDispatcher<TMessage>;
  private waitController?: ExternalWaitController;
  private turnLifecycle?: TurnLifecycle<TMessage, TModelInput, TUsage>;

  withContextAssembler(value: ContextAssembler<TMessage, TModelInput>): this { this.contextAssembler = value; return this; }
  withEventSink(value: RunEventSink<TUsage>): this { this.eventSink = value; return this; }
  withMaxModelTurns(value: number): this { this.maxModelTurns = value; return this; }
  withMaxParallelToolCalls(value: number): this { this.maxParallelToolCalls = value; return this; }
  withModelClient(value: ModelClient<TMessage, TModelInput, TUsage>): this { this.modelClient = value; return this; }
  withToolDispatcher(value: ToolDispatcher<TMessage>): this { this.toolDispatcher = value; return this; }
  withWaitController(value: ExternalWaitController): this { this.waitController = value; return this; }
  withTurnLifecycle(value: TurnLifecycle<TMessage, TModelInput, TUsage> | undefined): this { this.turnLifecycle = value; return this; }

  build(): AgentLoop<TMessage, TModelInput, TUsage> {
    const missing = [
      !this.contextAssembler && "contextAssembler",
      !this.modelClient && "modelClient",
      !this.toolDispatcher && "toolDispatcher",
      this.maxModelTurns === undefined && "maxModelTurns",
    ].filter(Boolean);
    if (missing.length) throw new Error(`Runtime composition is incomplete: ${missing.join(", ")}`);
    return new AgentLoop({
      contextAssembler: this.contextAssembler!,
      maxModelTurns: this.maxModelTurns!,
      maxParallelToolCalls: this.maxParallelToolCalls,
      modelClient: this.modelClient!,
      toolDispatcher: this.toolDispatcher!,
      ...(this.eventSink ? { eventSink: this.eventSink } : {}),
      ...(this.waitController ? { waitController: this.waitController } : {}),
      ...(this.turnLifecycle ? { turnLifecycle: this.turnLifecycle } : {}),
    });
  }
}

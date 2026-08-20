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
}

export interface ModelClient<TMessage extends RuntimeMessage, TModelInput, TUsage> {
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
  calling_model: phaseSet("executing_tools", "waiting_external", "completed", "cancelled", "failed"),
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
  | { type: "completed"; usage?: TUsage };

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

export interface AgentLoopOptions<TMessage extends RuntimeMessage, TModelInput, TUsage> {
  contextAssembler: ContextAssembler<TMessage, TModelInput>;
  eventSink?: RunEventSink<TUsage>;
  maxModelTurns: number;
  modelClient: ModelClient<TMessage, TModelInput, TUsage>;
  toolDispatcher: ToolDispatcher<TMessage>;
  waitController?: ExternalWaitController;
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
    // Copy and freeze the run registry. Mutating caller-owned composition
    // objects after construction cannot alter an in-flight run.
    this.options = Object.freeze({ ...options });
  }

  snapshot(): AgentLoopState<TMessage> {
    return structuredClone(this.state);
  }

  async run(history: readonly TMessage[], signal: AbortSignal, onProgress: () => void): Promise<AgentLoopResult<TMessage, TUsage>> {
    if (this.state.phase !== "idle") throw new Error("AgentLoop instances execute exactly once");
    this.state = { history: structuredClone([...history]), phase: "idle", turn: 0 };
    let usage: TUsage | undefined;
    const unsubscribeWait = this.options.waitController?.subscribe((activeCount) => {
      if (this.isTerminal(this.state.phase)) return;
      if (activeCount > 0 && this.state.phase !== "waiting_external") {
        this.transition("waiting_external", this.state.turn, false);
      } else if (this.state.phase === "waiting_external") {
        this.transition(this.activePhase, this.state.turn, false);
      }
    });
    try {
      for (let turn = 0; turn < this.options.maxModelTurns; turn += 1) {
        this.raiseForAbort(signal);
        this.transition("assembling_context", turn);
        const assembly = await this.options.contextAssembler.assemble({
          history: this.state.history,
          signal,
          turn,
          onProgress,
        });
        this.raiseForAbort(signal);
        this.state.history = [...assembly.history];

        this.transition("calling_model", turn);
        this.emit({ type: "turn_start", turn });
        const modelTurn = await this.options.modelClient.invoke(assembly.modelInput, signal, {
          onProgress,
          onTextDelta: (delta) => this.emit({ type: "model_delta", kind: "text", delta }),
          onThinkingDelta: (delta) => this.emit({ type: "model_delta", kind: "thinking", delta }),
        });
        this.raiseForAbort(signal);
        onProgress();
        if (modelTurn.usage !== undefined) usage = modelTurn.usage;
        this.state.history.push(modelTurn.assistantMessage);
        if (modelTurn.toolCalls.length === 0) {
          this.transition("completed", turn);
          this.emit({ type: "completed", ...(usage !== undefined ? { usage } : {}) });
          return { history: structuredClone(this.state.history), turns: turn + 1, ...(usage !== undefined ? { usage } : {}) };
        }

        this.transition("executing_tools", turn);
        for (const call of modelTurn.toolCalls) {
          this.emit({ type: "tool_execution_start", call });
        }
        // Execute independent calls concurrently, then commit results in the
        // model-declared order so every assistant/tool pairing stays stable.
        const results = await Promise.all(
          modelTurn.toolCalls.map((call) => this.options.toolDispatcher.execute(call, signal)),
        );
        this.raiseForAbort(signal);
        for (const [index, result] of results.entries()) {
          const call = modelTurn.toolCalls[index];
          if (!call) continue;
          this.state.history.push(result.message);
          this.emit({
            type: "tool_execution_end",
            call,
            content: result.content,
            isError: result.isError,
          });
          onProgress();
        }
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
  private modelClient?: ModelClient<TMessage, TModelInput, TUsage>;
  private toolDispatcher?: ToolDispatcher<TMessage>;
  private waitController?: ExternalWaitController;

  withContextAssembler(value: ContextAssembler<TMessage, TModelInput>): this { this.contextAssembler = value; return this; }
  withEventSink(value: RunEventSink<TUsage>): this { this.eventSink = value; return this; }
  withMaxModelTurns(value: number): this { this.maxModelTurns = value; return this; }
  withModelClient(value: ModelClient<TMessage, TModelInput, TUsage>): this { this.modelClient = value; return this; }
  withToolDispatcher(value: ToolDispatcher<TMessage>): this { this.toolDispatcher = value; return this; }
  withWaitController(value: ExternalWaitController): this { this.waitController = value; return this; }

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
      modelClient: this.modelClient!,
      toolDispatcher: this.toolDispatcher!,
      ...(this.eventSink ? { eventSink: this.eventSink } : {}),
      ...(this.waitController ? { waitController: this.waitController } : {}),
    });
  }
}

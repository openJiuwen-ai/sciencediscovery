// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import {
  classifyModelWireError,
  EmptyModelTurnError,
  type ModelStreamCallbacks,
  type ModelWireErrorClass,
} from "./client.js";

/**
 * A provider can finish a turn after streaming hidden reasoning and nothing
 * else. The transport detects that shape and both executors replay the same
 * request a small, fixed number of times before giving up. The retry commits
 * no text or tool call (the detection requires both to be absent), so replaying
 * cannot duplicate work; it only gives a transient provider hiccup another
 * chance instead of discarding the whole agent turn.
 */
export const MAX_EMPTY_TURN_RETRIES = 2;
export const EMPTY_TURN_CLASSES: ReadonlySet<ModelWireErrorClass> = new Set(["reasoning_only", "empty_completion"]);

/**
 * The bounded retries above were exhausted. It is still an empty terminal turn
 * for diagnostics (so its wire classification is unchanged), but its message
 * tells the user what happened and what to do instead of exposing only the
 * generic `semantic-error` catch-all.
 */
export class EmptyTurnRecoveryExhaustedError extends EmptyModelTurnError {
  constructor(error: EmptyModelTurnError, retries: number) {
    super(error.diagnostics);
    const attempted = retries === 0 ? "" : ` after ${retries} ${retries === 1 ? "retry" : "retries"}`;
    this.message = `The model returned no answer for this step${attempted} (empty terminal turn: no text and no tool call). Please retry the run; if it keeps happening, switch models or reduce the context size. ${error.message}`;
    this.cause = error;
  }
}

/** What one replayed attempt was, for the caller's log line and retry accounting. */
export interface EmptyTurnRetry {
  /** 1-based retry number, so the bound reads `attempt/maxRetries`. */
  attempt: number;
  maxRetries: number;
  classification: ModelWireErrorClass;
  delayMs: number;
}

export interface EmptyTurnReplayOptions {
  /**
   * Off for auxiliary requests (housekeeping and compaction), which are never
   * replayed: they do not advance the run, so a transient empty answer is not
   * worth a second provider request.
   */
  enabled?: boolean;
  /** Replaces `MAX_EMPTY_TURN_RETRIES`; only a test seam asks for a smaller bound. */
  maxRetries?: number;
  /** Called once per replay, before the delay. */
  onRetry?(retry: EmptyTurnRetry): void;
}

/** The delay before replay `retry` (1-based), matching the gateway's backoff. */
export const emptyTurnRetryDelayMs = (retry: number) => 250 * 2 ** (retry - 1);

/**
 * The bounded replay of an empty terminal turn, shared by the JiuwenSwarm model
 * gateway and the native runtime's model client so both executors recover the
 * same way.
 *
 * One instance belongs to one model request: it owns the retry budget, whether
 * the request already exposed text, and whether hidden reasoning was already
 * forwarded. A replay must never resend reasoning the client has seen, so the
 * callbacks for every attempt after the first drop `onThinkingDelta`.
 */
export class EmptyTurnReplay {
  readonly #signal: AbortSignal;
  readonly #options: EmptyTurnReplayOptions;
  #retries = 0;
  #textExposed = false;

  constructor(signal: AbortSignal, options: EmptyTurnReplayOptions = {}) {
    this.#signal = signal;
    this.#options = options;
  }

  /**
   * The transport callbacks for `attempt`. Text deltas are tracked so a turn
   * that already exposed text is never replayed, and hidden reasoning is
   * forwarded only by the first attempt.
   */
  callbacksFor(attempt: number, callbacks: ModelStreamCallbacks = {}): ModelStreamCallbacks {
    return {
      ...callbacks,
      onTextDelta: (delta) => {
        if (delta.length > 0) this.#textExposed = true;
        callbacks.onTextDelta?.(delta);
      },
      onThinkingDelta: attempt === 0 ? callbacks.onThinkingDelta : undefined,
    };
  }

  /**
   * Decides what a failed attempt means. A replayable empty terminal turn is
   * waited out and reported `true`, so the caller runs the attempt again;
   * `false` means the failure is not this rule's to absorb and must propagate.
   * Once the bound is spent it throws the readable
   * {@link EmptyTurnRecoveryExhaustedError}.
   */
  async replay(error: unknown): Promise<boolean> {
    const classification = classifyModelWireError(error);
    const replayable = this.#options.enabled !== false && !this.#textExposed && EMPTY_TURN_CLASSES.has(classification);
    if (!replayable) return false;
    const maxRetries = this.#options.maxRetries ?? MAX_EMPTY_TURN_RETRIES;
    if (this.#retries >= maxRetries) throw new EmptyTurnRecoveryExhaustedError(error as EmptyModelTurnError, this.#retries);
    this.#retries += 1;
    const delayMs = emptyTurnRetryDelayMs(this.#retries);
    this.#options.onRetry?.({ attempt: this.#retries, maxRetries, classification, delayMs });
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error("aborted")); };
      const timer = setTimeout(() => { this.#signal.removeEventListener("abort", abort); resolve(); }, delayMs);
      this.#signal.addEventListener("abort", abort, { once: true });
    });
    return true;
  }
}

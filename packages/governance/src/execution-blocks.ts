// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
import { randomUUID } from "node:crypto";
import type { ExecutionBlock, ExecutionBlockDecision } from "@sciencediscovery/schema";

export interface ConfigurationWaitOwner {
  sessionId: string;
  runId: string;
  requestId: string;
  stopGeneration: number;
}

/** Internal live binding, never a public readiness decision or a permission grant. */
export interface LiveConfigurationWait<Activation> extends ConfigurationWaitOwner {
  expiresAt: number;
  activate?: Activation;
  signal?: AbortSignal;
  /** Proposal expiry is a domain event: an already committed decision may still
   * be activating. Return settled only after its terminal result is saved. */
  onExpire?(): Promise<"settled" | undefined>;
}
export type ConfigurationWaitResult = "settled" | "cancelled" | "timed_out" | "closed" | "failed";
type WaitResult = { kind: "execution"; choice: ExecutionBlockDecision }
  | { kind: "configuration"; reason: ConfigurationWaitResult };
type WaitEntry<Activation> = ({ kind: "execution"; block: ExecutionBlock }
  | { kind: "configuration"; binding: LiveConfigurationWait<Activation> })
  & { listeners: Set<(result: WaitResult) => void> };

/** Live pre-dispatch/interaction waits. No executing task is replayed and no
 * approval is granted. Waiters survive browser reloads, not their process/run.
 */
export class ExecutionBlocks<Activation = unknown> {
  private entries = new Map<string, WaitEntry<Activation>>();

  list(sessionId: string): ExecutionBlock[] {
    return [...this.entries.values()].flatMap(entry => entry.kind === "execution" && entry.block.sessionId === sessionId
      ? [structuredClone(entry.block)] : []);
  }

  wait(input: Omit<ExecutionBlock, "id" | "createdAt">, signal?: AbortSignal): Promise<ExecutionBlockDecision> {
    signal?.throwIfAborted();
    // Only waiters for the same operation share a decision. Distinct tools or
    // agents must not consume each other's user responses.
    const key = JSON.stringify(["execution", input.sessionId, input.executionId, input.runnerId, input.operationId]);
    const entry = this.entries.get(key) ?? { kind: "execution" as const,
      block: { ...input, id: randomUUID(), createdAt: new Date().toISOString() }, listeners: new Set() };
    return this.register(key, entry, 10 * 60_000, signal).then(result => {
      if (result.kind !== "execution") throw new Error("Invalid execution wait result");
      return result.choice;
    });
  }

  waitForConfiguration(binding: Omit<LiveConfigurationWait<Activation>, "signal">, signal?: AbortSignal): Promise<ConfigurationWaitResult> {
    signal?.throwIfAborted();
    if (!Number.isFinite(binding.expiresAt)) throw new Error("Configuration wait requires a finite expiry");
    const key = this.configurationKey(binding);
    if (this.entries.has(key)) throw new Error("Original configuration tool is already waiting");
    const entry: WaitEntry<Activation> = { kind: "configuration", binding: { ...binding, signal }, listeners: new Set() };
    // Human interaction is bounded by the proposal, not the Runner repair budget.
    return this.register(key, entry, Math.max(0, binding.expiresAt - Date.now()), signal, binding.onExpire).then(result => {
      if (result.kind !== "configuration") throw new Error("Invalid configuration wait result");
      return result.reason;
    });
  }

  configurationWait(owner: ConfigurationWaitOwner): Readonly<LiveConfigurationWait<Activation>> | undefined {
    const entry = this.entries.get(this.configurationKey(owner));
    if (entry?.kind !== "configuration" || entry.binding.runId !== owner.runId
      || entry.binding.stopGeneration !== owner.stopGeneration || entry.binding.signal?.aborted) return undefined;
    return { ...entry.binding };
  }

  /** Only the configuration domain may call this, after validation and saving
   * its decision/activation result. Not exposed by the readiness HTTP endpoint. */
  settleConfiguration(owner: ConfigurationWaitOwner): boolean {
    if (!this.configurationWait(owner)) return false;
    this.finish(this.configurationKey(owner), { kind: "configuration", reason: "settled" });
    return true;
  }

  private configurationKey(owner: ConfigurationWaitOwner): string {
    return JSON.stringify(["configuration", owner.sessionId, owner.requestId]);
  }

  /** Both domains share registration, exactly-once completion, abort and timer cleanup. */
  private register(key: string, entry: WaitEntry<Activation>, timeoutMs: number, signal?: AbortSignal,
    onExpire?: () => Promise<"settled" | undefined>): Promise<WaitResult> {
    return new Promise(resolve => {
      const cancel = (reason: ConfigurationWaitResult) => this.finish(key, entry.kind === "execution"
        ? { kind: "execution", choice: { action: "cancel" } } : { kind: "configuration", reason }, entry);
      const abort = () => cancel("cancelled");
      const timer = setTimeout(() => {
        if (!onExpire) { cancel("timed_out"); return; }
        // Notify once, without another poll. The transport/run signal still
        // bounds activation after the human decision has been committed.
        void Promise.resolve().then(onExpire).then(reason => {
          if (reason) cancel(reason);
        }).catch(() => cancel("failed"));
      }, timeoutMs);
      timer.unref();
      const finish = (result: WaitResult) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      entry.listeners.add(finish);
      this.entries.set(key, entry);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private finish(key: string, result: WaitResult, expected?: WaitEntry<Activation>): void {
    const entry = this.entries.get(key);
    if (!entry || expected && entry !== expected) return;
    this.entries.delete(key);
    for (const listener of entry.listeners) listener(result);
    entry.listeners.clear();
  }

  decide(sessionId: string, id: string, choice: ExecutionBlockDecision): void {
    const found = [...this.entries].find(([, entry]) => entry.kind === "execution"
      && entry.block.id === id && entry.block.sessionId === sessionId);
    if (!found || found[1].kind !== "execution") throw new Error("Execution decision expired or was already resolved");
    if (!["retry", "cancel", "switch"].includes(choice.action)) throw new Error("Invalid execution decision");
    if (choice.action === "switch" && !found[1].block.alternatives.some(x => x.runnerId === choice.runnerId)) {
      throw new Error("Runner is not an offered alternative");
    }
    this.finish(found[0], { kind: "execution", choice });
  }

  close(): void {
    for (const [key, entry] of this.entries) this.finish(key, entry.kind === "execution"
      ? { kind: "execution", choice: { action: "cancel" } } : { kind: "configuration", reason: "closed" });
  }
}

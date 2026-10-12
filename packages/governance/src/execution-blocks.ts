// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
import { randomUUID } from "node:crypto";
import type { ExecutionBlock, ExecutionBlockDecision } from "@sciencediscovery/schema";

/** Pre-dispatch waits only. No executing task is replayed and no approval is granted.
 * Live waiters survive browser reloads, but are cancelled with their process/run.
 */
export class ExecutionBlocks {
  private entries = new Map<string, { block: ExecutionBlock; finish: (choice: ExecutionBlockDecision) => void }>();

  list(sessionId: string): ExecutionBlock[] {
    return [...this.entries.values()].filter(x => x.block.sessionId === sessionId).map(x => structuredClone(x.block));
  }

  wait(input: Omit<ExecutionBlock, "id" | "createdAt">, signal?: AbortSignal): Promise<ExecutionBlockDecision> {
    signal?.throwIfAborted();
    // Only waiters for the same operation share a decision. Distinct tools or
    // agents must not consume each other's user responses.
    const key = JSON.stringify([input.sessionId, input.executionId, input.runnerId, input.operationId]);
    return new Promise(resolve => {
      const existing = this.entries.get(key);
      const block = existing?.block ?? { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
      let finished = false;
      const finish = (choice: ExecutionBlockDecision) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(choice);
      };
      const abort = () => {
        finish({ action: "cancel" });
        // A shared run signal cancels all its pre-dispatch waiters.
        const entry = this.entries.get(key);
        if (entry?.block.id === block.id) { this.entries.delete(key); entry.finish({ action: "cancel" }); }
      };
      const timer = setTimeout(abort, 10 * 60_000);
      timer.unref();
      signal?.addEventListener("abort", abort, { once: true });
      this.entries.set(key, { block, finish: choice => { existing?.finish(choice); finish(choice); } });
    });
  }

  decide(sessionId: string, id: string, choice: ExecutionBlockDecision): void {
    const found = [...this.entries].find(([, x]) => x.block.id === id && x.block.sessionId === sessionId);
    if (!found) throw new Error("Execution decision expired or was already resolved");
    if (!["retry", "cancel", "switch"].includes(choice.action)) throw new Error("Invalid execution decision");
    if (choice.action === "switch" && !found[1].block.alternatives.some(x => x.runnerId === choice.runnerId)) {
      throw new Error("Runner is not an offered alternative");
    }
    this.entries.delete(found[0]);
    found[1].finish(choice);
  }

  close(): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.finish({ action: "cancel" });
  }
}

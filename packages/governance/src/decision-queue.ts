// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * Serializes governance decisions per Session while allowing Sessions to
 * progress independently.
 *
 * A decision reads the request, may tear down kernels, re-reads the request,
 * and only then writes. Two concurrent decisions on the same Session would
 * interleave those steps and could both observe `pending`, so each Session
 * needs a turn holder. Sessions are independent, so the turn is per Session.
 *
 * The state is a plain lock rather than a chain of promises: `holders` marks
 * which Sessions currently have a turn taken, and `waiters` keeps the callers
 * queued behind each of them in arrival order. Both entries are dropped as
 * soon as a Session drains, so an idle Session costs nothing.
 */
export class PermissionDecisionQueue {
  /** Sessions whose turn is taken right now. */
  private readonly holders = new Set<string>();
  /** Per Session, the callbacks that hand the turn to each waiter, oldest first. */
  private readonly waiters = new Map<string, Array<() => void>>();

  async run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    await this.takeTurn(sessionId);
    try {
      return await operation();
    } finally {
      // Runs for both outcomes: a failed decision must not strand the Session.
      this.passTurn(sessionId);
    }
  }

  /** Resolves once the caller owns this Session's turn. */
  private takeTurn(sessionId: string): Promise<void> {
    if (!this.holders.has(sessionId)) {
      this.holders.add(sessionId);
      return Promise.resolve();
    }
    return new Promise<void>((grant) => {
      const queued = this.waiters.get(sessionId);
      if (queued) queued.push(grant);
      else this.waiters.set(sessionId, [grant]);
    });
  }

  /** Hands the turn to the longest-waiting caller, or frees the Session. */
  private passTurn(sessionId: string): void {
    const queued = this.waiters.get(sessionId);
    const next = queued?.shift();
    if (!next) {
      this.waiters.delete(sessionId);
      this.holders.delete(sessionId);
      return;
    }
    if (!queued!.length) this.waiters.delete(sessionId);
    // `holders` deliberately stays set: the turn moves, it is not released,
    // so a decision arriving now queues instead of overtaking the waiters.
    next();
  }
}

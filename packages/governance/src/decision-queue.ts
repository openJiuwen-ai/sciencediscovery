// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** Serializes governance decisions per Session while allowing Sessions to progress independently. */
export class PermissionDecisionQueue {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const marker = previous.then(() => current, () => current);
    this.queues.set(sessionId, marker);
    try {
      await previous.catch(() => undefined);
      return await operation();
    } finally {
      release();
      if (this.queues.get(sessionId) === marker) this.queues.delete(sessionId);
    }
  }
}

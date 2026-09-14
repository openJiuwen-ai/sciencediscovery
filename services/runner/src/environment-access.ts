// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** FIFO readers/writer gate. A waiting update closes admission to new executions. */
export class EnvironmentAccess {
  private readonly states = new Map<string, {
    readers: number;
    writer: boolean;
    waiting: Array<{ write: boolean; grant: (release: () => void) => void }>;
  }>();

  async run<T>(id: string, write: boolean, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(id, write);
    try { return await operation(); } finally { release(); }
  }

  private acquire(id: string, write: boolean): Promise<() => void> {
    let state = this.states.get(id);
    if (!state) {
      state = { readers: 0, writer: false, waiting: [] };
      this.states.set(id, state);
    }
    const current = state;
    return new Promise((grant) => {
      current.waiting.push({ write, grant });
      this.drain(id, current);
    });
  }

  private drain(id: string, state: NonNullable<ReturnType<EnvironmentAccess["states"]["get"]>>): void {
    if (state.writer) return;
    while (state.waiting.length) {
      const next = state.waiting[0]!;
      if (next.write && state.readers) return;
      state.waiting.shift();
      if (next.write) state.writer = true;
      else state.readers++;
      let released = false;
      next.grant(() => {
        if (released) return;
        released = true;
        if (next.write) state.writer = false;
        else state.readers--;
        this.drain(id, state);
      });
      if (next.write) return;
    }
    if (!state.readers) this.states.delete(id);
  }
}

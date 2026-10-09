// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** FIFO lifecycle permits. Callers release only after the child execution has settled. */
export class SubagentPool {
  private active = 0;
  private readonly queue: Array<{ signal: AbortSignal; start: () => void; cancel: () => void }> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid subagent concurrency limit");
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        start: () => {
          signal.removeEventListener("abort", entry.cancel);
          this.active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active--;
            this.drain();
          });
        },
        cancel: () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          signal.removeEventListener("abort", entry.cancel);
          reject(signal.reason);
          this.drain();
        },
      };
      signal.addEventListener("abort", entry.cancel, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length) this.queue.shift()!.start();
  }
}

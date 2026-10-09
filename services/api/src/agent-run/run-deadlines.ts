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
 * A run's two deadlines, as the run bounds them: the whole turn (`runTimeoutMs`) and the longest stretch without
 * progress (`runIdleTimeoutMs`). Both stand still while the run waits on something outside it (an approval),
 * and each says which one ended the run, in the words the run's timeout notice reads.
 */
export class RunDeadlines {
  private kind?: "idle" | "turn";
  private turnTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private remainingTurnMs: number;
  private activeSince = Date.now();
  private waits = 0;
  private stopped = false;

  constructor(private readonly turnMs: number, private readonly idleMs: number, private readonly onExpired: () => void) {
    this.remainingTurnMs = turnMs;
  }

  start(): void {
    this.armTurn();
    this.progress();
  }

  /** Something happened: the idle deadline starts again. */
  progress(): void {
    if (this.stopped) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = this.waits === 0 && this.idleMs > 0 ? setTimeout(() => this.expire("idle"), this.idleMs) : undefined;
  }

  /** The run waits on something outside it; both deadlines stand still until the returned release is called. */
  beginWait(): () => void {
    this.waits += 1;
    if (this.waits === 1) this.pause();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.waits = Math.max(0, this.waits - 1);
      if (this.waits === 0 && !this.stopped && !this.kind) {
        this.armTurn();
        this.progress();
      }
    };
  }

  /** Which deadline ended the run, if one did. */
  get expired(): "idle" | "turn" | undefined {
    return this.kind;
  }

  error(): Error {
    return this.kind === "idle"
      ? new Error(`Agent run stalled: no gateway progress for ${this.idleMs} ms`)
      : new Error(`Agent run timeout: gateway turn exceeded ${this.turnMs} ms`);
  }

  stop(): void {
    this.stopped = true;
    if (this.turnTimer) clearTimeout(this.turnTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  private armTurn(): void {
    if (this.turnMs <= 0 || this.remainingTurnMs <= 0 || this.turnTimer) return;
    this.activeSince = Date.now();
    this.turnTimer = setTimeout(() => this.expire("turn"), this.remainingTurnMs);
  }

  private pause(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = undefined;
      this.remainingTurnMs = Math.max(1, this.remainingTurnMs - (Date.now() - this.activeSince));
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private expire(kind: "idle" | "turn"): void {
    if (this.kind || this.stopped) return;
    this.kind = kind;
    this.onExpired();
  }
}

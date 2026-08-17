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

import type { ScientificExecutionRequest, ShellExecutionRequest } from "@science-agent/schema";

type AgentExecutionRequest = ScientificExecutionRequest | ShellExecutionRequest;

/** A collision-free key for the stable Agent identity inside one Session. */
export function agentExecutionKey(sessionId: string, agentId: string): string {
  if (!sessionId.trim()) throw new Error("Session ID is required");
  if (!agentId.trim()) throw new Error("Agent ID is required");
  return JSON.stringify([sessionId, agentId]);
}

export function requestAgentExecutionKey(request: AgentExecutionRequest): string {
  return agentExecutionKey(request.permissionEpoch.sessionId, request.agentId);
}

/**
 * Promise-tail mutexes partitioned by key. A rejected operation advances only
 * its own tail, and an idle tail is removed so completed Agents do not leak.
 */
export class KeyedTaskQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly groups = new Map<string, string>();
  private readonly groupTails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>, group?: string): Promise<T> {
    const existingGroup = this.groups.get(key);
    if (existingGroup !== undefined && existingGroup !== group) {
      throw new Error("A task queue key cannot move between exclusive groups while active");
    }
    const previous = this.tails.get(key) ?? Promise.resolve();
    const previousGroup = group === undefined ? Promise.resolve() : this.groupTails.get(group) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const ready = Promise.all([previous.catch(() => undefined), previousGroup.catch(() => undefined)]);
    const tail = ready.then(() => current);
    this.tails.set(key, tail);
    if (group !== undefined) this.groups.set(key, group);
    await ready;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
        this.groups.delete(key);
      }
    }
  }

  /**
   * Wait for every active key in a group, block later group members, then run
   * one lifecycle operation such as tearing down every runtime in a Session.
   */
  async runGroupExclusive<T>(group: string, operation: () => Promise<T>): Promise<T> {
    const dependencies = [this.groupTails.get(group) ?? Promise.resolve()];
    for (const [key, tail] of this.tails) {
      if (this.groups.get(key) === group) dependencies.push(tail);
    }
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const ready = Promise.all(dependencies.map(async (dependency) => await dependency.catch(() => undefined)));
    const tail = ready.then(() => current);
    this.groupTails.set(group, tail);
    await ready;
    try {
      return await operation();
    } finally {
      release();
      if (this.groupTails.get(group) === tail) this.groupTails.delete(group);
    }
  }
}

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

/** Scheduling class resolved by the tool capability package. */
export type ToolExecutionMode = "exclusive" | "parallel";

export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10;

export function resolveMaxParallelToolCalls(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error("maxParallelToolCalls must be a positive integer");
  }
  return resolved;
}

export interface ToolScheduleOptions<TCall, TResult> {
  calls: readonly TCall[];
  classify(call: TCall): ToolExecutionMode;
  execute(call: TCall): Promise<TResult>;
  maxParallelToolCalls: number;
  onResult?(call: TCall, result: TResult, index: number): void;
  onStart?(call: TCall, index: number): void;
  signal: AbortSignal;
}

/**
 * Execute model-declared calls through a bounded rolling pool.
 *
 * Consecutive parallel calls overlap up to maxParallelToolCalls. An exclusive
 * call drains the preceding pool, runs alone, and bars later calls. Results are
 * committed in model order even when handlers settle out of order. Cancellation
 * stops replenishing the pool and drains work that has already started.
 */
export async function scheduleToolCalls<TCall, TResult>(
  options: ToolScheduleOptions<TCall, TResult>,
): Promise<TResult[]> {
  const limit = resolveMaxParallelToolCalls(options.maxParallelToolCalls);
  const committed: TResult[] = [];
  let next = 0;

  while (next < options.calls.length && !options.signal.aborted) {
    const first = options.calls[next]!;
    if (safeClassify(options.classify, first) === "exclusive") {
      options.onStart?.(first, next);
      const result = await options.execute(first);
      committed.push(result);
      options.onResult?.(first, result, next);
      next += 1;
      continue;
    }

    const start = next;
    while (next < options.calls.length
      && safeClassify(options.classify, options.calls[next]!) === "parallel") {
      next += 1;
    }
    const group = options.calls.slice(start, next);
    const slots = new Array<TResult | undefined>(group.length);
    const ready = new Array<boolean>(group.length).fill(false);
    let nextToStart = 0;
    let nextToCommit = 0;
    let firstFailure: unknown;

    const commitReady = (): void => {
      while (nextToCommit < slots.length && ready[nextToCommit]) {
        const result = slots[nextToCommit]!;
        const index = start + nextToCommit;
        committed.push(result);
        options.onResult?.(group[nextToCommit]!, result, index);
        nextToCommit += 1;
      }
    };

    const worker = async (): Promise<void> => {
      while (!options.signal.aborted && firstFailure === undefined) {
        const groupIndex = nextToStart;
        if (groupIndex >= group.length) return;
        nextToStart += 1;
        const call = group[groupIndex]!;
        try {
          options.onStart?.(call, start + groupIndex);
          slots[groupIndex] = await options.execute(call);
          ready[groupIndex] = true;
          commitReady();
        } catch (error) {
          firstFailure ??= error;
          return;
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(limit, group.length) },
      () => worker(),
    );
    await Promise.allSettled(workers);
    if (firstFailure !== undefined) throw firstFailure;
  }

  return committed;
}

function safeClassify<TCall>(
  classify: (call: TCall) => ToolExecutionMode,
  call: TCall,
): ToolExecutionMode {
  try {
    return classify(call) === "parallel" ? "parallel" : "exclusive";
  } catch {
    return "exclusive";
  }
}

// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

/** Stop waiting, not the underlying write. Keep handlers attached for late failures. */
export function waitForRecording<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Recording wait cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) abort(); else resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); }
  });
}

export interface RecordingIdentity {
  sessionId?: string;
  agentId?: string;
  trajectoryId?: string;
  requestId?: string;
  turn?: number;
}

/** Observe actual completion even when the caller has stopped waiting. No research payloads. */
export async function recordingStage<T>(stage: string, identity: RecordingIdentity,
  operation: () => Promise<T>, signal?: AbortSignal, slowAfterMs = 30_000): Promise<T> {
  const started = performance.now();
  const operationId = randomUUID();
  const tracing = process.env.SCIENCE_AGENT_TRACE_GATEWAY_PROGRESS === "1";
  let slow = false;
  const log = (event: string) => {
    const record = { at: new Date().toISOString(), event, stage, operationId, ...identity,
      elapsedMs: Math.round(performance.now() - started), aborted: signal?.aborted ?? false };
    console.warn(`[recording-progress] ${JSON.stringify(record)}`);
  };
  if (tracing) log("started");
  const timer = setInterval(() => { slow = true; log("pending"); }, slowAfterMs);
  timer.unref();
  const abort = () => log("abort_requested");
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const result = await operation();
    if (tracing || slow || signal?.aborted) log("completed");
    return result;
  } catch (error) {
    log("failed");
    throw error;
  } finally {
    clearInterval(timer);
    signal?.removeEventListener("abort", abort);
  }
}

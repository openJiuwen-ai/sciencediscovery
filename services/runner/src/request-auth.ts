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

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const EXECUTION_SIGNATURE_HEADER = "x-science-execution-signature";
export const EXECUTION_TIMESTAMP_HEADER = "x-science-execution-timestamp";
/**
 * How far a request's timestamp may be from the Runner's clock. It is the
 * replay window, so it stays as small as correct clocks allow.
 */
export const DEFAULT_EXECUTION_SIGNATURE_MAX_AGE_MS = 30_000;

/**
 * A machine whose clock cannot be disciplined (no NTP client reachable, which
 * happens on isolated compute hosts) rejects every execution once it drifts
 * past the window. Widening is therefore possible, but only when an operator
 * asks for it by name: a larger window is a larger replay window for every
 * Runner, so it is never inferred from a failure.
 */
export function executionSignatureMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SCIENCE_AGENT_EXECUTION_SIGNATURE_MAX_AGE_MS?.trim();
  if (!raw) return DEFAULT_EXECUTION_SIGNATURE_MAX_AGE_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("SCIENCE_AGENT_EXECUTION_SIGNATURE_MAX_AGE_MS must be a positive integer number of milliseconds");
  }
  return value;
}

export const EXECUTION_SIGNATURE_MAX_AGE_MS = executionSignatureMaxAgeMs();

export function createExecutionSignature(token: string, timestamp: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", token).update(`${timestamp}\n${bodyHash}`).digest("hex");
}

export function verifyExecutionSignature(
  token: string,
  timestamp: string | undefined,
  body: string,
  actual: string | undefined,
  now = Date.now(),
): boolean {
  if (!timestamp || !actual || !/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(actual)) return false;
  const requestedAt = Number(timestamp);
  if (!Number.isSafeInteger(requestedAt) || Math.abs(now - requestedAt) > EXECUTION_SIGNATURE_MAX_AGE_MS) return false;
  const expected = createExecutionSignature(token, timestamp, body);
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

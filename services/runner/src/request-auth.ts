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
export const EXECUTION_SIGNATURE_MAX_AGE_MS = 30_000;

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

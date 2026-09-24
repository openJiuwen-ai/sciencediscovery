// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

/** Per-poll read-only recovery budget; never use for task creation or writes. */
export class RunPollRecovery {
  private failures = 0;
  succeeded(): void { this.failures = 0; }
  failed(error: unknown): number {
    const message = error instanceof Error ? error.message : String(error);
    if (!/-> (502|503|504):|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(message) || ++this.failures > 3) throw error;
    return this.failures;
  }
}

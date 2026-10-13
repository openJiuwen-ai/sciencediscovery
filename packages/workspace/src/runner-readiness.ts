// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
import type { RunnerBlockedResult } from "@sciencediscovery/schema";

/** A failed pre-dispatch call, never a queued or automatically replayed job. */
export class RunnerUnavailableError extends Error {
  constructor(readonly result: RunnerBlockedResult) {
    super(JSON.stringify(result));
    this.name = "RunnerUnavailableError";
  }
}

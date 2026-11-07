// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

export class ApiStatusError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    /** Machine-readable reason, so a client can act on it instead of matching prose. */
    readonly code?: string,
    /** Structured payload the client needs to offer a next step. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

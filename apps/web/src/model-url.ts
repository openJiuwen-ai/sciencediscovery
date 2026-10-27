// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** URL parsing matches the server, without importing its model/request runtime. */
export function normalizedModelBaseUrl(baseUrl: string): string {
  try { return new URL(baseUrl.trim()).href.replace(/\/+$/, ""); } catch { return baseUrl.trim(); }
}

export function isPlaintextModelUrl(baseUrl: string): boolean {
  try { return new URL(baseUrl.trim()).protocol === "http:"; } catch { return false; }
}

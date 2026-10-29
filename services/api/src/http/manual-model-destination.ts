// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ManualModelDestination, ModelProfile } from "@sciencediscovery/schema";

/** Optimistic target check for manual settings, independent of Agent approvals. */
export function matchesManualModelDestination(profile: ModelProfile, input: unknown): input is ManualModelDestination {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Partial<ManualModelDestination>;
  if (typeof value.baseUrl !== "string" || value.profileUpdatedAt !== profile.updatedAt) return false;
  const normalized = (url: string) => new URL(url.trim()).href.replace(/\/+$/, "");
  try { return normalized(value.baseUrl) === normalized(profile.baseUrl); } catch { return false; }
}

// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { KernelSession } from "@sciencediscovery/schema";
interface KernelControl {
  listKernels(): Promise<KernelSession[]>;
  teardownKernel(id: string, reason: string): Promise<unknown>;
}
/** Exact old epoch and kernel identities make retries safe for newly-created kernels. */
export async function retireSecurityNetworkKernels(control: KernelControl, retiredEpochIds: readonly string[], reason = "Sandbox network policy changed; old Permission Epoch retired"): Promise<void> {
  if (!retiredEpochIds.length) return;
  const epochs = new Set(retiredEpochIds);
  const old = [...new Map((await control.listKernels()).filter(kernel => kernel.status === "running" && epochs.has(kernel.permissionEpochId)).map(kernel => [kernel.id, kernel])).values()];
  for (const kernel of old.slice(0, 8)) await control.teardownKernel(kernel.id, reason);
  if (old.length > 8) throw new Error("Retired-kernel cleanup budget exhausted; the saved epoch fence remains active");
}

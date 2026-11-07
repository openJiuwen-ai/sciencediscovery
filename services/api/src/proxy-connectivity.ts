// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { withProxyFetch, redactNetworkError, validateProxyUrl, type NetworkProxy } from "@sciencediscovery/network";

/** A user-initiated diagnostic, never a startup gate or a settings mutation. */
export async function testProxyConnectivity(input: unknown) {
  const candidate = input as Partial<NetworkProxy> | null;
  if (!candidate || !["direct", "environment", "url"].includes(candidate.mode ?? "")) throw new Error("Invalid proxy mode");
  if (candidate.mode === "url") validateProxyUrl(candidate.url ?? "");
  if (candidate.noProxy !== undefined && (typeof candidate.noProxy !== "string" || candidate.noProxy.length > 4000 || /[\r\n]/.test(candidate.noProxy))) throw new Error("Invalid proxy bypass list");
  const proxy = candidate as NetworkProxy;
  const started = Date.now();
  const target = "https://github.com/mamba-org/micromamba-releases/releases/latest";
  try {
    const status = await withProxyFetch(proxy, async fetch => {
      const response = await fetch(target, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
      await response.body?.cancel();
      return response.status;
    });
    return { ok: status >= 200 && status < 400, target, status, elapsedMs: Date.now() - started,
      message: status === 407 ? "Proxy authentication rejected" : `Download source returned HTTP ${status}; other destinations have not been tested` };
  } catch (error) {
    return { ok: false, target, elapsedMs: Date.now() - started, message: redactNetworkError(error) };
  }
}

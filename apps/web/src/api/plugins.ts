// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { BridgeEnvelope, BridgeScope, PluginManifest, PluginStatus } from "@sciencediscovery/plugin-sdk";
import type { RuntimeSettingsDetails } from "@sciencediscovery/schema";
import { AuthApiClient } from "./auth.js";

export interface PluginComposition {
  revision: string; settings: RuntimeSettingsDetails; plugins: PluginManifest[];
  status: PluginStatus[]; applies: "nextRun" | "restart";
}
const pathFor = (scope: BridgeScope, suffix = "") => `/api/projects/${encodeURIComponent(scope.projectId)}/plugins${suffix}${scope.sessionId ? "?sessionId=" + encodeURIComponent(scope.sessionId) : ""}`;
export class PluginApiClient extends AuthApiClient {
  getPluginComposition(scope: BridgeScope): Promise<PluginComposition> {
    return this.request(pathFor(scope));
  }
  async pluginBridge<T>(envelope: BridgeEnvelope): Promise<T> {
    const response = await this.request<{result:T}>(pathFor(envelope.scope, "/bridge"), { method: "POST", body: JSON.stringify(envelope) });
    return response.result;
  }
  /** Fetch, not EventSource: the existing bearer credential stays out of URLs. */
  async subscribePlugins(scope: BridgeScope, changed: () => void, signal: AbortSignal): Promise<void> {
    const response = await fetch(pathFor(scope, "/events"), { headers: { authorization: `Bearer ${this.token}` }, signal });
    this.reportAuthStatus(response.status);
    if (!response.ok || !response.body) throw new Error("Plugin subscription unavailable");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        pending += decoder.decode(result.value, { stream: true });
        if (pending.length > 64 * 1024) throw new Error("Invalid plugin event frame");
        let boundary;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          if (frame.startsWith("event: changed\n")) changed();
        }
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}

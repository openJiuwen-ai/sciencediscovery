// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
export interface BridgeScope { projectId: string; sessionId?: string }
export interface BridgeEnvelope {
  apiVersion: 1; pluginId: string; scope: BridgeScope;
  kind: "query" | "command"; method: string; input?: unknown;
}
export class BridgeError extends Error {
  constructor(readonly code: "invalid" | "forbidden" | "unavailable" | "conflict", message: string) { super(message); }
}
export interface BridgeProvider {
  id: string;
  queries: Readonly<Record<string, (input: unknown, signal: AbortSignal) => unknown | Promise<unknown>>>;
  commands: Readonly<Record<string, (input: unknown, signal: AbortSignal) => unknown | Promise<unknown>>>;
}
/** A bridge instance is bound to an authenticated, validated scope by its transport. */
export class PluginBridge {
  private readonly providers = new Map<string, BridgeProvider>();
  constructor(private readonly scope: BridgeScope, private readonly authorize: (pluginId: string, kind: "query" | "command") => boolean) {}
  register(provider: BridgeProvider): () => void {
    if (this.providers.has(provider.id)) throw new BridgeError("conflict", "Duplicate Bridge provider");
    this.providers.set(provider.id, provider);
    return () => { if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id); };
  }
  async invoke(request: BridgeEnvelope, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (request?.apiVersion !== 1 || !["query", "command"].includes(request.kind) || typeof request.method !== "string"
      || !request.scope || request.scope.projectId !== this.scope.projectId || request.scope.sessionId !== this.scope.sessionId) {
      throw new BridgeError("invalid", "Bridge contract or scope mismatch");
    }
    if (!this.authorize(request.pluginId, request.kind)) throw new BridgeError("forbidden", "Plugin access denied");
    const provider = this.providers.get(request.pluginId);
    const methods = request.kind === "query" ? provider?.queries : provider?.commands;
    const handler = methods && Object.hasOwn(methods, request.method) ? methods[request.method] : undefined;
    if (!handler) throw new BridgeError("unavailable", "Bridge method unavailable");
    return await handler(request.input, signal);
  }
}

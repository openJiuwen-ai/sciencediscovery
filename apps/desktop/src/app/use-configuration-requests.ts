// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ConfigurationRequestView, ConnectorConfigurationRequest } from "@sciencediscovery/schema";
import { isConfigurationRequestView, mergeConfigurationRequests, shouldPollConfigurationRequest } from "@sciencediscovery/configuration-ui";
import type { ApiClient } from "../api/client.js";
import { listConfigurationRequests, type DesktopConfigurationRequest } from "../api/configuration.js";

interface Options {
  client: ApiClient;
  sessionId: string | undefined;
  active: boolean;
  refreshKey: string;
  onChange?: (request: DesktopConfigurationRequest) => void;
}

export function useConfigurationRequests({ client, sessionId, active, refreshKey, onChange }: Options) {
  const [, render] = useReducer((value: number) => value + 1, 0);
  // A distinct scope for every visit also rejects A → B → A responses.
  const scope = useMemo(() => ({
    requests: [] as ConfigurationRequestView[], legacyRequests: [] as ConnectorConfigurationRequest[], loading: Boolean(sessionId), error: false,
    alive: true, sequence: 0, controller: undefined as AbortController | undefined,
    removed: new Set<string>(),
  }), [client, sessionId]);
  const current = useRef(scope);
  current.current = scope;
  const changed = useRef(onChange);
  changed.current = onChange;
  const valid = useCallback(() => current.current === scope && scope.alive, [scope]);

  const merge = useCallback((incoming: DesktopConfigurationRequest[]) => {
    if (!valid()) return;
    const previous = new Map(scope.requests.map(request => [request.id, request]));
    const merged = mergeConfigurationRequests(scope.requests, incoming.filter(isConfigurationRequestView).filter(request =>
      request.sessionId === sessionId && !scope.removed.has(request.id)));
    // Equal snapshots must not reset a card's in-progress field edits.
    scope.requests = merged.map(request => {
      const old = previous.get(request.id);
      return old && JSON.stringify(old) === JSON.stringify(request) ? old : request;
    });
    const previousLegacy = new Map(scope.legacyRequests.map(request => [request.id, request]));
    const genericIds = new Set(scope.requests.map(request => request.id));
    const legacy = new Map(previousLegacy);
    for (const request of incoming) {
      if (isConfigurationRequestView(request) || !("connectorId" in request)
        || request.sessionId !== sessionId || scope.removed.has(request.id)) continue;
      const old = legacy.get(request.id);
      // Historical records have timestamps, not generic revision/stateVersion.
      // A delayed read must never revive a decided card, even at equal times.
      if (old && (request.updatedAt < old.updatedAt
        || (old.state !== "awaiting_confirmation" && request.state !== old.state)
        || (old.continuationRunId && !request.continuationRunId && request.updatedAt === old.updatedAt))) continue;
      legacy.set(request.id, old && JSON.stringify(old) === JSON.stringify(request) ? old : request);
    }
    scope.legacyRequests = [...legacy.values()].filter(request => !genericIds.has(request.id));
    render();
    for (const request of scope.legacyRequests) {
      if (request !== previousLegacy.get(request.id)) changed.current?.(request);
    }
    for (const request of scope.requests) {
      if (request !== previous.get(request.id)) changed.current?.(request);
    }
  }, [scope, sessionId, valid]);

  const refresh = useCallback(async () => {
    if (!valid() || !sessionId) return;
    scope.controller?.abort();
    const controller = new AbortController();
    scope.controller = controller;
    const sequence = ++scope.sequence;
    scope.loading = true;
    render();
    try {
      const response = await listConfigurationRequests(client, sessionId, controller.signal);
      if (!valid() || sequence !== scope.sequence || controller.signal.aborted) return;
      scope.error = false;
      merge(response.items);
    } catch {
      if (!valid() || sequence !== scope.sequence || controller.signal.aborted) return;
      // Keep the last good cards; do not expose transport/backend error text.
      scope.error = true;
    } finally {
      if (valid() && sequence === scope.sequence) {
        scope.loading = false;
        render();
      }
    }
  }, [client, sessionId, scope, merge, valid]);

  useEffect(() => {
    scope.alive = true;
    return () => { scope.alive = false; scope.controller?.abort(); };
  }, [scope]);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);
  const polling = active || scope.requests.some(shouldPollConfigurationRequest)
    || scope.legacyRequests.some(request => request.state === "awaiting_confirmation");
  useEffect(() => {
    if (!sessionId || !polling) return;
    const timer = setInterval(() => {
      // Slow reads are allowed to finish instead of being aborted every tick.
      if (!scope.loading) void refresh();
    }, 2_000);
    return () => clearInterval(timer);
  }, [sessionId, polling, scope, refresh]);

  const update = useCallback((request: DesktopConfigurationRequest) => merge([request]), [merge]);
  const remove = useCallback((id: string) => {
    if (!valid()) return;
    scope.removed.add(id);
    scope.requests = scope.requests.filter(request => request.id !== id);
    scope.legacyRequests = scope.legacyRequests.filter(request => request.id !== id);
    render();
  }, [scope, valid]);
  return { requests: scope.requests, legacyRequests: scope.legacyRequests, loading: scope.loading, error: scope.error, refresh, update, remove };
}

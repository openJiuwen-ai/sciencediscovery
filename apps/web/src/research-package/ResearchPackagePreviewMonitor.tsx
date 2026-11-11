// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../api.js";
import { ApiRequestError } from "../api/auth.js";
import { ExportPreviewCache } from "./export-preview-cache.js";

/** Mounted with the conversation, before the export dialog is ever opened. */
export function ResearchPackagePreviewMonitor({ client, projectId, sessionId, revision, isRunning }: { client: ApiClient; projectId?: string; sessionId?: string; revision?: string; isRunning: boolean }) {
  const cache = useMemo(() => new ExportPreviewCache(client), [client]);
  // A Project or Session that has been deleted keeps its page mounted (another
  // client or a teardown removed it). The API answers such a poll as a normal
  // end of polling, and asking again would only repeat the same answer (#1072).
  const [gone, setGone] = useState(false);
  // The answer belongs to the scope that asked for it. Switching conversations
  // keeps this component mounted, so a rejection that lands after the switch
  // would otherwise mark the *new* scope gone and stop its poll for good.
  const scope = `${projectId ?? ""}:${sessionId ?? ""}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => { setGone(false); }, [projectId, sessionId]);
  useEffect(() => {
    if (!projectId || !sessionId || isRunning || gone) return;
    cache.notifySessionRevision(projectId, sessionId, revision);
    const asked = scope;
    const refresh = () => {
      void cache.refreshDefaults(projectId, sessionId).catch((reason: unknown) => {
        if (scopeRef.current !== asked) return;
        if (reason instanceof ApiRequestError && reason.code === "EXPORT_PREVIEW_RESOURCE_DELETED") setGone(true);
      });
    };
    refresh();
  }, [cache, projectId, sessionId, revision, isRunning, gone]);
  useEffect(() => {
    if (!projectId || !sessionId || isRunning || gone) return;
    const asked = scope;
    const refresh = () => {
      void cache.refreshDefaults(projectId, sessionId).catch((reason: unknown) => {
        if (scopeRef.current !== asked) return;
        if (reason instanceof ApiRequestError && reason.code === "EXPORT_PREVIEW_RESOURCE_DELETED") setGone(true);
      });
    };
    const timer = window.setInterval(refresh, 3_000);
    return () => { window.clearInterval(timer); };
  }, [cache, projectId, sessionId, isRunning, gone]);
  return null;
}

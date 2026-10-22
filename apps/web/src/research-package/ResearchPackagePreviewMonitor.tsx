// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useMemo } from "react";
import type { ApiClient } from "../api.js";
import { ExportPreviewCache } from "./export-preview-cache.js";

/** Mounted with the conversation, before the export dialog is ever opened. */
export function ResearchPackagePreviewMonitor({ client, projectId, sessionId, revision }: { client: ApiClient; projectId?: string; sessionId?: string; revision?: string }) {
  const cache = useMemo(() => new ExportPreviewCache(client), [client]);
  useEffect(() => {
    if (!projectId || !sessionId) return;
    cache.notifySessionRevision(projectId, sessionId, revision);
    const refresh = () => { void cache.refreshDefaults(projectId, sessionId).catch(() => undefined); };
    refresh();
  }, [cache, projectId, sessionId, revision]);
  useEffect(() => {
    if (!projectId || !sessionId) return;
    const refresh = () => { void cache.refreshDefaults(projectId, sessionId).catch(() => undefined); };
    const timer = window.setInterval(refresh, 3_000);
    return () => { window.clearInterval(timer); };
  }, [cache, projectId, sessionId]);
  return null;
}

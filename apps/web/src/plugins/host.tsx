// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { disabledPluginIds } from "@sciencediscovery/plugin-sdk";
import type { ApiClient } from "../api.js";

const PluginContext = createContext<readonly string[]>([]);
export const useDisabledPlugins = () => useContext(PluginContext);

/** Per-Project/Session UI host. Switching scope cancels its authenticated subscription. */
export function PluginWebHost({client,projectId,sessionId,children}: {
  client: ApiClient; projectId?:string; sessionId?:string; children:ReactNode;
}) {
  const [view,setView] = useState<{key:string;disabled:readonly string[]}>();
  const key = JSON.stringify([projectId,sessionId]);
  useEffect(() => {
    if (!projectId) return;
    const scope = {projectId,...(sessionId ? {sessionId} : {})}, abort = new AbortController();
    let sequence = 0;
    const refresh = async () => {
      const current = ++sequence;
      try {
        const composition = await client.getPluginComposition(scope);
        if (!abort.signal.aborted && current === sequence) setView({key, disabled:disabledPluginIds(composition.settings.effective.plugins)});
      } catch { /* Keep the last known scope; unavailable views cannot add actions. */ }
    };
    void refresh();
    void client.subscribePlugins(scope, () => { void refresh(); }, abort.signal).catch(() => undefined);
    const poll = window.setInterval(() => { void refresh(); }, 30_000);
    return () => { abort.abort(); window.clearInterval(poll); };
  }, [client,projectId,sessionId,key]);
  // Generic source previews remain available while extension availability is unresolved.
  const disabled = !projectId ? [] : view?.key === key ? view.disabled : ["artifact-json"];
  return <PluginContext.Provider value={disabled}>{children}</PluginContext.Provider>;
}

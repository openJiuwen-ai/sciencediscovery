// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ApiClient } from "../api.js";
import { ContinuationTasks, type ContinuationTask } from "./continuation-tasks.js";

export const ResearchContinuationContext = createContext<ReturnType<typeof useResearchContinuationTasks> | undefined>(undefined);
export function useResearchContinuationTasks(client: ApiClient, onReady: (task: ContinuationTask, canAutoOpen: () => boolean) => void, navigationKey: string) {
  const ready = useRef(onReady); ready.current = onReady;
  const navigation = useRef({ key: navigationKey, epoch: 0 });
  if (navigation.current.key !== navigationKey) navigation.current = { key: navigationKey, epoch: navigation.current.epoch + 1 };
  const starts = useRef(new Map<string, number>());
  const manager = useMemo(() => {
    let storage: Storage | undefined;
    try { storage = localStorage; } catch { /* Browser storage is optional. */ }
    return new ContinuationTasks(client, storage, (task) => {
      const startEpoch = starts.current.get(task.requestId);
      const canAutoOpen = () => startEpoch !== undefined && startEpoch === navigation.current.epoch;
      starts.current.delete(task.requestId);
      ready.current(task, canAutoOpen);
    }, undefined, (task) => starts.current.set(task.requestId, navigation.current.epoch));
  }, [client]);
  useEffect(() => { manager.resume(); return () => manager.dispose(); }, [manager]);
  const tasks = useSyncExternalStore(manager.subscribe, manager.snapshot, manager.snapshot);
  return { manager, tasks };
}
export function useResearchContinuationContext() { return useContext(ResearchContinuationContext); }

export function ResearchContinuationStatus({ tasks, onRetry, onDismiss }: {
  tasks: ContinuationTask[]; onRetry: (sourceId: string) => void; onDismiss: (id: string) => void;
}) {
  // Copying and successful tasks are intentionally silent. The continuation
  // button already explains that the durable task continues in the background;
  // only failures need a persistent surface in the application shell.
  const failedTasks = tasks.filter((task) => task.state === "failed");
  if (!failedTasks.length) return null;
  return <aside className="research-background-tasks" aria-label="继续研究任务">
    {failedTasks.map((task) => <div key={task.requestId} className="research-background-task">
      <span role="status">创建研究会话失败</span>
      {task.error ? <small role={task.state === "failed" ? "alert" : "status"}>{task.error}</small> : null}
      <div><button type="button" className="secondary-button compact-button" onClick={() => onRetry(task.sourceSessionId)}>重试</button><button type="button" className="icon-button" aria-label="关闭任务提示" onClick={() => onDismiss(task.requestId)}>×</button></div>
    </div>)}
  </aside>;
}

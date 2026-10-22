// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api.js";
import { downloadBlob } from "../artifact-download.js";
import type { ToastTone } from "../Toasts.js";
import type { ResearchPackageExportTaskView } from "../api/plugins.js";

type TrackedExport = Pick<ResearchPackageExportTaskView, "id" | "filename" | "createdAt"> & { projectId: string };
const STORAGE_KEY = "sciencediscovery.research-package-exports.v1";
const listeners = new Set<() => void>();
let memoryTasks: TrackedExport[] | undefined;

function readTasks(): TrackedExport[] {
  if (memoryTasks) return memoryTasks;
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "[]");
    memoryTasks = Array.isArray(parsed) ? parsed.filter((item): item is TrackedExport => Boolean(item)
      && typeof item.projectId === "string" && typeof item.id === "string"
      && typeof item.filename === "string" && typeof item.createdAt === "string") : [];
  } catch { memoryTasks = []; }
  return memoryTasks;
}

function writeTasks(tasks: TrackedExport[]): void {
  memoryTasks = tasks;
  if (typeof window !== "undefined") {
    try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); } catch { /* In-memory tracking still works for this page. */ }
  }
  for (const listener of listeners) listener();
}

export function trackResearchPackageExport(projectId: string, task: ResearchPackageExportTaskView): void {
  const current = readTasks().filter((item) => item.id !== task.id);
  writeTasks([...current, { projectId, id: task.id, filename: task.filename, createdAt: task.createdAt }]);
}

function removeResearchPackageExport(taskId: string): void {
  writeTasks(readTasks().filter((item) => item.id !== taskId));
}

/** The monitor stays mounted at app scope, so exports survive session navigation. */
export function ResearchPackageExportMonitor({ client, onToast }: {
  client: ApiClient;
  onToast: (tone: ToastTone, title: string, detail?: string) => void;
}) {
  const [generation, setGeneration] = useState(0);
  const polling = useRef(false);
  useEffect(() => {
    const update = () => setGeneration((value) => value + 1);
    listeners.add(update);
    return () => { listeners.delete(update); };
  }, []);
  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        for (const task of readTasks()) {
          if (!active) return;
          try {
            const status = await client.getResearchPackageExport(task.projectId, task.id);
            if (!active) return;
            if (status.status === "completed") {
              const blob = await client.downloadResearchPackageExport(task.projectId, task.id);
              if (!active) return;
              downloadBlob(blob, status.filename || task.filename);
              removeResearchPackageExport(task.id);
              onToast("success", "证据包导出完成", `${status.filename || task.filename} 已下载`);
            } else if (status.status === "failed") {
              removeResearchPackageExport(task.id);
              onToast("error", "证据包导出失败", status.error || "请重试后台导出。");
            }
          } catch { /* Keep the task and retry after transient network or auth failures. */ }
        }
      } finally { polling.current = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [client, generation, onToast]);
  return null;
}

// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface ContextTraceWriter {
  readonly directory: string;
  write(contextId: string, turn: number, record: Record<string, unknown>): Promise<void>;
}

function enabled(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "0" || value === "false" || value === "off") return false;
  if (value === "1" || value === "true" || value === "on") return true;
  throw new Error("SCIENCE_AGENT_CONTEXT_TRACE must be 0/1, false/true, or off/on");
}

function safeContextId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "_").slice(0, 180) || "context";
}

export function createContextTraceWriter(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ContextTraceWriter | undefined {
  if (!enabled(env.SCIENCE_AGENT_CONTEXT_TRACE)) return undefined;
  const directory = resolve(env.SCIENCE_AGENT_CONTEXT_TRACE_DIR?.trim() || resolve(dataDir, "context-traces"));
  return {
    directory,
    async write(contextId, turn, record) {
      const contextDirectory = resolve(directory, safeContextId(contextId));
      await mkdir(contextDirectory, { recursive: true });
      const recovery = record.recovery;
      const recoveryAttempt = typeof recovery === "object" && recovery !== null && !Array.isArray(recovery)
        && (recovery as Record<string, unknown>).reason === "model-input-overflow"
        && (recovery as Record<string, unknown>).attempt === 1
        ? 1 : undefined;
      const filename = `turn-${String(turn).padStart(4, "0")}${recoveryAttempt ? `-recovery-${recoveryAttempt}` : ""}.json`;
      const destination = resolve(contextDirectory, filename);
      const temporary = `${destination}.${process.pid}.tmp`;
      const payload = JSON.stringify({
        ...record,
        contextId,
        exportedAt: new Date().toISOString(),
        schemaVersion: 5,
        turn,
      }, null, 2);
      await writeFile(temporary, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, destination);
    },
  };
}

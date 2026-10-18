// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy at https://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

// Process/session transport only: no repository polling or scheduling decisions.
import { appendFile, mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function runRequest(requestPath, { createCodex, signal, notify = () => {} } = {}) {
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  for (const key of ["workingDirectory", "promptFile", "sessionFile", "logDirectory"]) {
    if (typeof request[key] !== "string" || !isAbsolute(request[key])) {
      throw new Error(`Request requires absolute ${key}`);
    }
  }
  if (request.fullAccess !== true) throw new Error("Explicit fullAccess authorization is required");
  if (!["main", "worker"].includes(request.role)) throw new Error("Role must be main or worker");
  const priorMask = process.umask(0o077);
  const lock = `${request.sessionFile}.lock`;
  let locked = false;
  try {
    await mkdir(dirname(request.sessionFile), { recursive: true, mode: 0o700 });
    await mkdir(lock, { mode: 0o700 });
    locked = true;
    let previous;
    try {
      previous = JSON.parse(await readFile(request.sessionFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (previous && previous.workingDirectory !== request.workingDirectory) {
      throw new Error("Saved session belongs to a different working directory");
    }
    const startedAt = new Date().toISOString();
    const runDirectory = resolve(request.logDirectory, `${startedAt.replaceAll(":", "-")}-${process.pid}`);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const effectiveOptions = {
      workingDirectory: request.workingDirectory,
      sandboxMode: "danger-full-access", approvalPolicy: "never",
      networkAccessEnabled: true, skipGitRepoCheck: true,
    };
    const status = {
      role: request.role, pid: process.pid, startedAt, runDirectory,
      workingDirectory: request.workingDirectory, effectiveOptions,
      threadId: previous?.threadId ?? null, state: "starting", lastEventAt: startedAt,
    };
    async function persist() {
      const temporary = `${request.sessionFile}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(status, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, request.sessionFile);
    }
    await persist();
    try {
      const options = { config: { features: { multi_agent: false } } };
      if (process.env.CODEX_EXECUTABLE) options.codexPathOverride = process.env.CODEX_EXECUTABLE;
      const factory = createCodex ?? (async (settings) => {
        const { Codex } = await import("@openai/codex-sdk");
        return new Codex(settings);
      });
      const codex = await factory(options);
      const thread = status.threadId
        ? codex.resumeThread(status.threadId, effectiveOptions)
        : codex.startThread(effectiveOptions);
      const prompt = await readFile(request.promptFile, "utf8");
      await writeFile(resolve(runDirectory, "input.md"), prompt, { mode: 0o600 });
      let completed = false;
      let failed = false;
      let finalResponse = "";
      const { events } = await thread.runStreamed(prompt, { signal });
      for await (const event of events) {
        await appendFile(resolve(runDirectory, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
        status.lastEventAt = new Date().toISOString();
        if (event.type === "thread.started") {
          status.threadId = event.thread_id;
          status.state = "running";
        }
        if (event.type === "item.completed" && event.item.type === "agent_message") finalResponse = event.item.text;
        if (event.type === "turn.completed") {
          completed = true;
          status.usage = event.usage;
        }
        if (event.type === "turn.failed" || event.type === "error") failed = true;
        await persist();
      }
      if (signal?.aborted) throw new Error("SDK turn interrupted");
      if (failed || !completed) throw new Error("SDK turn failed or ended without completion");
      await writeFile(resolve(runDirectory, "final.md"), finalResponse + "\n", { mode: 0o600 });
      status.state = "completed";
    } catch (error) {
      status.state = signal?.aborted ? "interrupted" : "failed";
      await writeFile(resolve(runDirectory, "error.txt"), String(error), { mode: 0o600 });
    }
    status.finishedAt = new Date().toISOString();
    await persist();
    notify({ role: status.role, state: status.state, threadId: status.threadId, runDirectory });
    return status;
  } finally {
    if (locked) await rmdir(lock);
    process.umask(priorMask);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (!process.argv[2]) throw new Error("Request path required");
    const result = await runRequest(resolve(process.argv[2]), {
      signal: cancellation.signal,
      notify: (event) => console.log(JSON.stringify(event)),
    });
    if (result.state !== "completed") process.exitCode = 1;
  } catch {
    console.error("SDK host failed; check the private request, session and logs. Usage: node sdk-runner.mjs /absolute/request.json");
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

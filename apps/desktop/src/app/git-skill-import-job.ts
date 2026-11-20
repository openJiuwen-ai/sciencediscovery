// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { ApiRequestError, type ApiClient } from "../api/client.js";
import { getGitSkillImportJob, getJiuwenSwarmSkills, setJiuwenSwarmSkillEnabledById, startGitSkillImportJob } from "../api/settings.js";
import type { GitSkillImportJob, StartGitSkillImportJobRequest } from "../api/types.js";

/** How often a running job is read. The import installs one package per step,
 *  so a second is frequent enough to move the banner and rare enough not to
 *  compete with the work it is reporting. */
const POLL_INTERVAL_MS = 1_000;
/** How long the finished banner stays after the last package. */
const FINISHED_NOTICE_MS = 10_000;

type Listener = (job: GitSkillImportJob | undefined) => void;

let current: GitSkillImportJob | undefined;
let client: ApiClient | undefined;
let poller: ReturnType<typeof setInterval> | undefined;
let clearTimer: ReturnType<typeof setTimeout> | undefined;
let consecutiveFailures = 0;
/** One enable run per job: the pane and the store may both await it. */
const enablePromises = new Map<string, Promise<void>>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of [...listeners]) listener(current);
}

function stopPolling(): void {
  if (poller !== undefined) clearInterval(poller);
  poller = undefined;
}

function clearLater(id: string): void {
  if (clearTimer !== undefined) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    if (current?.id === id) {
      current = undefined;
      enablePromises.delete(id);
      emit();
    }
  }, FINISHED_NOTICE_MS);
}

async function poll(): Promise<void> {
  if (!client || !current) return;
  const id = current.id;
  try {
    const next = await getGitSkillImportJob(client, id);
    // A newer job may have replaced this one while the read was in flight.
    if (current?.id !== id) return;
    consecutiveFailures = 0;
    current = next;
    emit();
    if (next.status !== "queued" && next.status !== "running") {
      stopPolling();
      void enableCreatedSkills(client, next);
      clearLater(id);
    }
  } catch (reason) {
    // A job the API no longer knows (a restart or its 30-minute cleanup) is
    // terminal: leaving it here would block every later import forever.
    if (reason instanceof ApiRequestError && reason.status === 404) {
      stopPolling();
      current = undefined;
      client = undefined;
      emit();
      return;
    }
    // A transient read failure does not end the import; a few are tolerated,
    // but a permanently unreachable watcher must not keep the banner alive.
    consecutiveFailures += 1;
    if (consecutiveFailures >= 5) {
      stopPolling();
      current = undefined;
      client = undefined;
      emit();
    }
  }
}

function startPolling(): void {
  stopPolling();
  poller = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
}

/** The job currently shown by the settings pane, if any. */
export function currentGitSkillImportJob(): GitSkillImportJob | undefined {
  return current;
}

export function gitSkillImportJobRunning(): boolean {
  return current?.status === "queued" || current?.status === "running";
}

/** Watch the one background job. The listener is called once with the state
 *  already known, so a pane mounted mid-import paints the banner at once. */
export function subscribeGitSkillImportJob(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

/** Start an import that keeps running while the reader is elsewhere. */
export async function startGitSkillImportInBackground(
  api: ApiClient,
  request: StartGitSkillImportJobRequest,
): Promise<GitSkillImportJob> {
  if (gitSkillImportJobRunning()) {
    throw new Error("A Git Skill import is already running");
  }
  if (clearTimer !== undefined) clearTimeout(clearTimer);
  clearTimer = undefined;
  const started = await startGitSkillImportJob(api, request);
  consecutiveFailures = 0;
  client = api;
  current = started;
  emit();
  startPolling();
  return started;
}

/** Switch on the packages this job created, when JiuwenSwarm is the agent
 *  backend. The job store owns this rather than the settings pane: the pane
 *  may be closed by the time the import finishes. */
export function enableCreatedSkills(client: ApiClient, job: GitSkillImportJob): Promise<void> {
  const existing = enablePromises.get(job.id);
  if (existing) return existing;
  const promise = (async () => {
    const created = job.imported.filter((entry) => entry.created);
    if (created.length === 0) return;
    try {
      const state = await getJiuwenSwarmSkills(client);
      if (state.backend !== "jiuwenswarm") return;
    } catch {
      return;
    }
    for (const entry of created) {
      try {
        await setJiuwenSwarmSkillEnabledById(client, entry.id, true);
      } catch {
        // The row's switch shows whatever the server actually stored.
      }
    }
  })();
  enablePromises.set(job.id, promise);
  return promise;
}

/** Drop the banner (a finished job only). A running job keeps going. */
export function dismissGitSkillImportJob(): void {
  if (gitSkillImportJobRunning()) return;
  stopPolling();
  if (clearTimer !== undefined) clearTimeout(clearTimer);
  clearTimer = undefined;
  current = undefined;
  emit();
}

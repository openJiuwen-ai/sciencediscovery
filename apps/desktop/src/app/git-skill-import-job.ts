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

import type { ApiClient } from "../api/client.js";
import { getGitSkillImportJob, startGitSkillImportJob } from "../api/settings.js";
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
    current = next;
    emit();
    if (next.status !== "queued" && next.status !== "running") {
      stopPolling();
      clearLater(id);
    }
  } catch {
    // A transient read failure does not end the import; the next tick retries.
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
  client = api;
  current = started;
  emit();
  startPolling();
  return started;
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

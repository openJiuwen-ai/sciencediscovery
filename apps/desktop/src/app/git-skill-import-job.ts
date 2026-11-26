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
/** Where this window remembers the job it was watching. The import keeps
 *  running in the API across a reload; without the id the renderer could never
 *  find it again, so the packages would arrive switched off. */
export const GIT_SKILL_IMPORT_JOB_KEY = "sciencediscovery.desktop.gitSkillImportJob";

type Listener = (job: GitSkillImportJob | undefined) => void;

/** The packages one enable run could not switch on. */
export interface GitSkillImportEnableFailure {
  count: number;
  jobId: string;
  /** The first refusal, which is enough to say why the rest are off too. */
  message: string;
}

export interface EnableOutcome {
  failed: Array<{ id: string; message: string }>;
}

type EnableListener = (failure: GitSkillImportEnableFailure | undefined) => void;

let current: GitSkillImportJob | undefined;
let client: ApiClient | undefined;
let poller: ReturnType<typeof setInterval> | undefined;
let clearTimer: ReturnType<typeof setTimeout> | undefined;
let consecutiveFailures = 0;
let enableFailure: GitSkillImportEnableFailure | undefined;
/** One enable run per job: the pane and the store may both await it. */
const enablePromises = new Map<string, Promise<EnableOutcome>>();
/** The runs that settled with failures. Their promise stays cached so the
 *  pane joining late reads the same result, and only an explicit retry (which
 *  sees this mark) starts a new attempt. */
const failedEnableJobs = new Set<string>();
const listeners = new Set<Listener>();
const enableListeners = new Set<EnableListener>();

function emit(): void {
  for (const listener of [...listeners]) listener(current);
}

function emitEnable(): void {
  for (const listener of [...enableListeners]) listener(enableFailure);
}

function rememberJob(id: string): void {
  try {
    globalThis.sessionStorage?.setItem(GIT_SKILL_IMPORT_JOB_KEY, id);
  } catch {
    // A browser without storage still imports; it only loses the reload path.
  }
}

function rememberedJob(): string | undefined {
  try {
    return globalThis.sessionStorage?.getItem(GIT_SKILL_IMPORT_JOB_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function forgetJob(): void {
  try {
    globalThis.sessionStorage?.removeItem(GIT_SKILL_IMPORT_JOB_KEY);
  } catch {
    // Nothing was remembered.
  }
}

function clearEnableFailure(id: string): void {
  if (enableFailure?.jobId !== id) return;
  enableFailure = undefined;
  emitEnable();
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
      failedEnableJobs.delete(id);
      clearEnableFailure(id);
      forgetJob();
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
      enablePromises.delete(id);
      failedEnableJobs.delete(id);
      clearEnableFailure(id);
      forgetJob();
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
      // The id stays remembered: the next mount can pick the job up again.
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

/** Watch what the last enable run could not switch on. Called once with the
 *  state already known, so a pane mounted after the import still says so. */
export function subscribeGitSkillImportEnableFailure(listener: EnableListener): () => void {
  enableListeners.add(listener);
  listener(enableFailure);
  return () => {
    enableListeners.delete(listener);
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
  const previous = current;
  const started = await startGitSkillImportJob(api, request);
  consecutiveFailures = 0;
  client = api;
  current = started;
  if (previous !== undefined) {
    enablePromises.delete(previous.id);
    failedEnableJobs.delete(previous.id);
  }
  rememberJob(started.id);
  // A new job replaces the one whose result the banner was still showing.
  if (enableFailure !== undefined) {
    enableFailure = undefined;
    emitEnable();
  }
  emit();
  startPolling();
  return started;
}

/** Reattach to the job this window started before a reload. The API kept
 *  importing; only the renderer lost the id it was watching. */
export async function resumeGitSkillImport(api: ApiClient): Promise<void> {
  if (current !== undefined) return;
  const id = rememberedJob();
  if (id === undefined) return;
  try {
    const job = await getGitSkillImportJob(api, id);
    // A foreground start may have won the race while the read was in flight.
    if (current !== undefined) return;
    client = api;
    consecutiveFailures = 0;
    current = job;
    emit();
    if (job.status === "queued" || job.status === "running") {
      startPolling();
      return;
    }
    // The import ended while no renderer was watching: do the enable step the
    // page never got to. The run itself decides how long the result stays: a
    // package that stayed off waits until it is dismissed.
    await enableCreatedSkills(api, job);
  } catch (reason) {
    // A foreground start may have installed its own job and client while the
    // read was in flight. That owner keeps both: clearing them here would
    // leave a running job with no client to read it.
    if (current !== undefined) return;
    client = undefined;
    // A job the API no longer knows is gone for good. Any other failure (the
    // API is still starting) keeps the id for the next mount.
    if (reason instanceof ApiRequestError && reason.status === 404) forgetJob();
  }
}

async function runEnable(api: ApiClient, job: GitSkillImportJob): Promise<EnableOutcome> {
  const created = job.imported.filter((entry) => entry.created);
  if (created.length === 0) return { failed: [] };
  try {
    const state = await getJiuwenSwarmSkills(api);
    if (state.backend !== "jiuwenswarm") return { failed: [] };
  } catch (reason) {
    // Without the switch list there is no way to know these packages are on;
    // report them all so the retry says what it was for.
    const message = reason instanceof Error ? reason.message : "JiuwenSwarm is unreachable";
    return { failed: created.map((entry) => ({ id: entry.id, message })) };
  }
  const failed: EnableOutcome["failed"] = [];
  for (const entry of created) {
    try {
      await setJiuwenSwarmSkillEnabledById(api, entry.id, true);
    } catch (reason) {
      failed.push({ id: entry.id, message: reason instanceof Error ? reason.message : "Enable failed" });
    }
  }
  return { failed };
}

/** Switch on the packages this job created, when JiuwenSwarm is the agent
 *  backend. The job store owns this rather than the settings pane: the pane
 *  may be closed by the time the import finishes. */
export function enableCreatedSkills(client: ApiClient, job: GitSkillImportJob): Promise<EnableOutcome> {
  const existing = enablePromises.get(job.id);
  if (existing) return existing;
  const promise = runEnable(client, job).then((outcome) => {
    if (outcome.failed.length > 0) {
      failedEnableJobs.add(job.id);
      enableFailure = {
        count: outcome.failed.length,
        jobId: job.id,
        message: outcome.failed[0]!.message,
      };
      // A package that stayed off needs the reader to see it. The finished
      // notice may leave by itself; this one waits to be dismissed.
      if (current?.id === job.id && clearTimer !== undefined) {
        clearTimeout(clearTimer);
        clearTimer = undefined;
      }
    } else {
      failedEnableJobs.delete(job.id);
      if (enableFailure?.jobId === job.id) enableFailure = undefined;
      // A retry that worked leaves a settled result rather than a permanent
      // banner.
      if (current?.id === job.id && clearTimer === undefined) clearLater(job.id);
    }
    emitEnable();
    return outcome;
  });
  enablePromises.set(job.id, promise);
  return promise;
}

/** Try the switch-on step again after it reported packages that stayed off.
 *  A run still in flight (or one that already succeeded) is shared, not
 *  duplicated; only a settled failure is restarted. */
export function retryEnableCreatedSkills(client: ApiClient, job: GitSkillImportJob): Promise<EnableOutcome> {
  if (!failedEnableJobs.has(job.id)) return enableCreatedSkills(client, job);
  failedEnableJobs.delete(job.id);
  enablePromises.delete(job.id);
  return enableCreatedSkills(client, job);
}

/** Drop the banner (a finished job only). A running job keeps going. */
export function dismissGitSkillImportJob(): void {
  if (gitSkillImportJobRunning()) return;
  stopPolling();
  if (clearTimer !== undefined) clearTimeout(clearTimer);
  clearTimer = undefined;
  if (current !== undefined) {
    enablePromises.delete(current.id);
    failedEnableJobs.delete(current.id);
    clearEnableFailure(current.id);
  }
  current = undefined;
  forgetJob();
  emit();
}

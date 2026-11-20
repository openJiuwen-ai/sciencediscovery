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

import { randomUUID } from "node:crypto";

import type {
  GitSkillImportJob,
  GitSkillImportJobItem,
  StartGitSkillImportJobRequest,
} from "@sciencediscovery/schema";
import { SkillCatalogError, validateGitSkillImportRequest, type SkillCatalog } from "@sciencediscovery/specialist";

/** How long a finished job stays readable. The renderer polls it for its
 *  completion banner; after that the result has served its purpose and nothing
 *  should hold the package names in memory. */
const JOB_RETENTION_MS = 30 * 60_000;

interface RunningJob extends GitSkillImportJob {
  cancelRequested: boolean;
  items: GitSkillImportJobItem[];
}

const jobs = new Map<string, RunningJob>();
let activeJobId: string | undefined;

function publicJob(job: RunningJob): GitSkillImportJob {
  const { cancelRequested: _cancelRequested, items: _items, ...visible } = job;
  return structuredClone(visible);
}

function cleanupLater(id: string): void {
  const timer = setTimeout(() => jobs.delete(id), JOB_RETENTION_MS);
  timer.unref?.();
}

/**
 * Start one background Git import.
 *
 * The packages are installed by the API process, not by the request that asked
 * for them: the reader can leave the page (or close 设置) and the job keeps
 * going. One job at a time is enough for a single-user control plane, and it
 * keeps the retained checkout from being expanded by two batches at once.
 */
export function startGitSkillImportJob(
  catalog: SkillCatalog,
  request: StartGitSkillImportJobRequest,
  onChanged?: () => void,
): GitSkillImportJob {
  const active = activeJobId === undefined ? undefined : jobs.get(activeJobId);
  if (active && (active.status === "queued" || active.status === "running")) {
    throw new Error("A Git Skill import is already running");
  }
  if (!Array.isArray(request.items) || request.items.length === 0) {
    throw new SkillCatalogError("SKILL_VALIDATION", "Select at least one Git Skill package");
  }
  if (request.items.length > 500) {
    throw new SkillCatalogError("SKILL_VALIDATION", "Select at most 500 Git Skill packages");
  }
  if (request.items.some((item) => !item || typeof item.subdirectory !== "string" || item.subdirectory.trim() === "")) {
    throw new SkillCatalogError("SKILL_VALIDATION", "Every selected Git Skill needs a subdirectory");
  }
  if (typeof request.commit !== "string" || request.commit.trim() === "") {
    throw new SkillCatalogError("SKILL_VALIDATION", "Importing a Git selection requires the commit returned by inspection");
  }
  // Reject an unusable repository URL before a job exists; the commit and the
  // selected roots are checked again when the job starts.
  validateGitSkillImportRequest(request);
  const job: RunningJob = {
    cancelRequested: false,
    done: 0,
    failures: [],
    id: randomUUID(),
    imported: [],
    items: request.items.map((item) => ({ ...item })),
    startedAt: new Date().toISOString(),
    status: "queued",
    total: request.items.length,
    ...(request.commit ? { commit: request.commit } : {}),
  };
  jobs.set(job.id, job);
  activeJobId = job.id;
  queueMicrotask(() => { void run(catalog, job, request, onChanged); });
  return publicJob(job);
}

export function getGitSkillImportJob(id: string): GitSkillImportJob | undefined {
  const job = jobs.get(id);
  return job === undefined ? undefined : publicJob(job);
}

export function cancelGitSkillImportJob(id: string): GitSkillImportJob | undefined {
  const job = jobs.get(id);
  if (job === undefined) return undefined;
  if (job.status === "queued" || job.status === "running") job.cancelRequested = true;
  return publicJob(job);
}

async function run(
  catalog: SkillCatalog,
  job: RunningJob,
  request: StartGitSkillImportJobRequest,
  onChanged?: () => void,
): Promise<void> {
  job.status = "running";
  onChanged?.();
  try {
    // Fetch every selected package's files in one sparse-checkout expansion;
    // each import below then reads them from disk.
    await catalog.prepareGitImport(request);
    const before = new Set(catalog.ids());
    for (const item of job.items) {
      if (job.cancelRequested) {
        job.status = "cancelled";
        break;
      }
      try {
        const detail = await catalog.importFromGit({
          repositoryUrl: request.repositoryUrl,
          ...(request.ref ? { ref: request.ref } : {}),
          ...(request.commit ? { commit: request.commit } : {}),
          subdirectory: item.subdirectory,
          ...(item.overwrite === undefined ? {} : { overwrite: item.overwrite }),
          ...(item.expectedRevision === undefined ? {} : { expectedRevision: item.expectedRevision }),
        });
        job.imported.push({ created: !before.has(detail.id), id: detail.id });
        before.add(detail.id);
      } catch (error) {
        job.failures.push({
          message: error instanceof Error ? error.message : String(error),
          subdirectory: item.subdirectory,
        });
      }
      job.done += 1;
      onChanged?.();
    }
    if (job.status !== "cancelled") job.status = "done";
  } catch (error) {
    job.status = "failed";
    job.failures.push({
      message: error instanceof Error ? error.message : String(error),
      subdirectory: "*",
    });
  } finally {
    job.finishedAt = new Date().toISOString();
    if (activeJobId === job.id) activeJobId = undefined;
    onChanged?.();
    cleanupLater(job.id);
  }
}

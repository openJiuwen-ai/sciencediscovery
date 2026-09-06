// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import type { RunnerClient } from "@sciencediscovery/executor";
import type { CreateEnvironmentRequest, InstallEnvironmentRequest, UninstallEnvironmentRequest } from "@sciencediscovery/schema";
import type { SessionStore } from "./store.js";
import { resolveEnvironmentInstallRequest } from "./environment-sources.js";
import { remoteWorkspaceKey } from "./remote-runner.js";

/** Remote catalogs stay on their Runner: IDs may overlap the local catalog. */
export async function manageRunnerEnvironment(runner: RunnerClient, store: SessionStore, path: string, method: string, body: unknown): Promise<unknown> {
  if (path === "environment-setup" && method === "GET") return runner.getEnvironmentSetup();
  if (path === "environment-setup" && method === "POST") return runner.setupScientificEnvironments();
  if (path === "environment-revisions" && method === "GET") return runner.listEnvironmentRevisions();
  if (path === "environments" && method === "GET") return runner.listEnvironments();
  if (path === "environments" && method === "POST") return runner.createEnvironment(body as CreateEnvironmentRequest);
  const match = path.match(/^environments\/([^/]+)(?:\/(install|uninstall))?$/);
  if (match) {
    const id = decodeURIComponent(match[1]!);
    if (!match[2] && method === "DELETE") { await runner.deleteEnvironment(id); return { deleted: id }; }
    if (match[2] && method === "POST") {
      let revision;
      if (match[2] === "install") {
        const input = body as InstallEnvironmentRequest;
        if (input.packages.some((value) => value.trim().toLowerCase().endsWith(".whl"))) throw new Error("Local wheel paths require an Agent Session workspace");
        revision = await runner.installEnvironment(id, resolveEnvironmentInstallRequest(input, store.getEnvironmentSourceSettings()));
      } else {
        const input = body as UninstallEnvironmentRequest;
        revision = await runner.uninstallEnvironment(id, { packages: input.packages });
      }
      const environment = (await runner.listEnvironments()).find((item) => item.id === id);
      if (!environment) throw new Error("Updated environment disappeared from the Runner catalog");
      return { environment, revision, status: "succeeded" };
    }
  }
  throw new Error("Unsupported Runner environment operation");
}

/** Catalog known Session workspaces, including historical references after deselection. */
export async function runnerWorkspaceBindings(store: SessionStore, hostId: string) {
  const host = store.getRemoteHost(hostId);
  if (!host) throw new Error("Remote host not found");
  const result = [];
  for (const project of store.listProjects()) {
    for (const session of store.listSessions(project.id, "all")) {
      const records = store.listRemoteWorkspaceSyncs(session.id).filter((record) => record.hostId === hostId);
      const selected = (session.remoteRunnerHostIds ?? project.remoteRunnerHostIds).includes(hostId);
      const executions = selected || records.length ? [] : await store.listExecutionRuns(session.id);
      if (!selected && !records.length && !executions.some((run) => run.runnerId === hostId)) continue;
      result.push({ sessionId: session.id, sessionTitle: session.title, projectName: project.name,
        workspaceKey: remoteWorkspaceKey(project.id, session.id, host.workspaceNamespace), records });
    }
  }
  return result;
}

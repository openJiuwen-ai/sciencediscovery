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

import type { ApiClient } from "../../api/client.js";
import { listProjects } from "../../api/sessions.js";
import { listRunners } from "../../api/settings.js";
import type { Project, RunnerTarget } from "../../api/types.js";
import { remoteHosts } from "../../app/remote-format.js";
import { useLoaded } from "../../app/use-loaded.js";
import type { ConfirmRequest } from "../../app/use-workspace.js";
import { TEXT } from "../../text.js";
import { ProjectRunnerAllowlist, RunnerSection } from "./RemoteHosts.js";
import { Group, LoadGate } from "./rows.js";

interface Props {
  activeProjectId?: string;
  client: ApiClient;
  onConfirm: (request: ConfirmRequest) => void;
}

interface RuntimePage {
  /** The Project whose allowlist is edited here; absent when none exists yet. */
  project?: Project;
  /** Every Runner, the local one included: the allowlist can toggle it. */
  runners: RunnerTarget[];
  /** The same catalog without the local entry, which is what the cards show. */
  remote: RunnerTarget[];
}

/**
 * 设置 › 远程.
 *
 * The Runner is where work is actually executed, so this page is the list of
 * the remote ones registered, what can be done with each, and — below it —
 * which of them this Project's Sessions may use. The local Runner is not one
 * of them: this page manages machines other than this one, and a row for the
 * machine the app is already running on would be the one row none of its
 * actions apply to.
 *
 * The machine section owns its own multi-step flows (register then probe,
 * connect then poll, fail then accept a key then try again), which is why it
 * lives in `RemoteHosts.tsx` rather than inline here. What it does not own is
 * the catalog: this page reads it and hands it down, so a machine registered
 * above reaches the allowlist below in the same reload.
 */
export function RuntimeSettings({ activeProjectId, client, onConfirm }: Props) {
  const loaded = useLoaded<RuntimePage>(async () => {
    const [runners, projects] = await Promise.all([listRunners(client), listProjects(client)]);
    const project = projects.find((candidate) => candidate.id === activeProjectId) ?? projects[0];
    // The cards leave the local entry out: it always exists, needs no
    // registration, and nothing on this page can act on it. The allowlist still
    // receives it — the local machine is a valid answer to "may this Project
    // run here", and the list is explicit rather than a set of defaults.
    return { ...(project ? { project } : {}), remote: remoteHosts(runners), runners };
  });

  return (
    <>
      <Group>
        <LoadGate loaded={loaded}>
          {(page) => (
            <RunnerSection client={client} hosts={page.remote} onConfirm={onConfirm} onReload={loaded.reload} />
          )}
        </LoadGate>
      </Group>
      <LoadGate loaded={loaded}>
        {(page) =>
          page.project ? (
            <ProjectRunnerAllowlist client={client} hosts={page.runners} onReload={loaded.reload} project={page.project} />
          ) : null
        }
      </LoadGate>
    </>
  );
}

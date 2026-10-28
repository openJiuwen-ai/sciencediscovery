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
import { listRunners } from "../../api/settings.js";
import type { Project, RunnerTarget } from "../../api/types.js";
import { remoteHosts } from "../../app/remote-format.js";
import { useLoaded } from "../../app/use-loaded.js";
import type { ConfirmRequest } from "../../app/use-workspace.js";
import { TEXT } from "../../text.js";
import { ProjectRunnerAllowlist, RunnerSection } from "./RemoteHosts.js";
import { Group, LoadGate } from "./rows.js";

interface Props {
  client: ApiClient;
  onConfirm: (request: ConfirmRequest) => void;
  /** The Project the open Session is in. Absent before the workspace has
   *  loaded one, in which case there is nothing to scope the allowlist to.
   *  It is the whole Project rather than an id because the allowlist has to
   *  render its current value, and looking the id up in `GET /api/projects`
   *  would miss the inbox — the Project standalone Sessions live in. */
  project?: Project;
}

interface RuntimePage {
  /** The Runner catalog without the local entry, which is all this page shows. */
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
export function RuntimeSettings({ client, onConfirm, project }: Props) {
  const loaded = useLoaded<RuntimePage>(async () => {
    const runners = await listRunners(client);
    // The local entry is left out once, here: it always exists, needs no
    // registration, and nothing on this page — cards or allowlist — can act on
    // it. A stored allowlist that still names it keeps doing so.
    return { remote: remoteHosts(runners) };
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
          project ? (
            <ProjectRunnerAllowlist client={client} hosts={page.remote} onReload={loaded.reload} project={project} />
          ) : null
        }
      </LoadGate>
    </>
  );
}

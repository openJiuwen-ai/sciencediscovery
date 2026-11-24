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

import { useEffect, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { listRunners } from "../../api/settings.js";
import { useLoaded } from "../../app/use-loaded.js";
import type { ConfirmRequest } from "../../app/use-workspace.js";
import { TEXT } from "../../text.js";
import { EnvironmentSources, RunnerEnvironmentPane } from "./EnvironmentSettings.js";
import { RunnerSection } from "./RemoteHosts.js";
import { Group, LoadGate, SkeletonBlock, SkeletonRegion } from "./rows.js";

interface Props {
  client: ApiClient;
  onConfirm: (request: ConfirmRequest) => void;
}

/** One catalog, with machine connections and environments scoped to a Runner's detail. */
export function RuntimeSettings({ client, onConfirm }: Props) {
  const loaded = useLoaded(() => listRunners(client), { client, key: "runner-catalog" });
  const [runnerId, setRunnerId] = useState<string>();
  useEffect(() => {
    if (loaded.value && runnerId && !loaded.value.some(runner => runner.id === runnerId)) setRunnerId(undefined);
  }, [loaded.value, runnerId]);
  const text = TEXT.settings.system.migrated.environments;

  const selected = loaded.value?.find(runner => runner.id === runnerId);
  const name = selected?.id === "local" ? text.local : selected?.runnerName ?? selected?.alias ?? selected?.id;
  const overview = !runnerId || (loaded.value !== undefined && !selected);

  return <>
    <LoadGate loaded={loaded} skeleton={<SkeletonRegion label={text.skeleton}>
      <Group heading={text.machinesHeading}>
        <p className="settings-note">{text.overviewHint}</p>
        <div className="settings-list">
          {[0, 1].map(index => <div className="settings-card settings-skeleton-card" key={index}>
            <SkeletonBlock className="is-runner-mark" />
            <div className="settings-skeleton-card-main">
              <SkeletonBlock className="is-runner-name" />
              <SkeletonBlock className="is-runner-detail" />
            </div>
            <SkeletonBlock className="is-runner-action" />
          </div>)}
        </div>
      </Group>
    </SkeletonRegion>}>{runners => <>
      {selected ? <div className="runner-detail-heading">
        <button className="secondary-button" type="button" onClick={() => setRunnerId(undefined)}>{text.back}</button>
        <h3>{name}</h3>
      </div> : null}
      <Group heading={selected ? text.connectionHeading : text.machinesHeading}>
        {!selected ? <p className="settings-note">{text.overviewHint}</p> : null}
        <RunnerSection client={client} hosts={selected ? [selected] : runners} onConfirm={onConfirm}
          onReload={loaded.reload} overview={!selected} allowRegistration={!selected} onSelectRunner={setRunnerId} />
      </Group>
      {selected ? selected.id !== "local" && selected.runnerStatus?.state !== "ready"
        ? <Group heading={text.heading}><p className="settings-note" role="status">{text.unavailable}</p></Group>
        : <RunnerEnvironmentPane key={selected.id} client={client} runnerId={selected.id} onConfirm={onConfirm} />
        : null}
    </>}</LoadGate>
    {overview ? <EnvironmentSources client={client} /> : null}
  </>;
}

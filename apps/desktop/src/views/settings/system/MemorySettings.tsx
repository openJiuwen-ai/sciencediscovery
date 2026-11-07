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

import { useState } from "react";

import type { ApiClient } from "../../../api/client.js";
import { getMemoryGraphSettings, updateMemoryGraphSettings } from "../../../api/settings.js";
import type {
  MemoryGraphSettingsDetails,
  UpdateMemoryGraphSettingsRequest,
} from "../../../api/types.js";
import { useLoaded } from "../../../app/use-loaded.js";
import { TEXT } from "../../../text.js";
import { MemoryStatus } from "../../MemoryStatus.js";
import { Group, LoadGate, Row, Switch } from "../rows.js";

interface Props {
  client: ApiClient;
}

/**
 * 设置 › 科学记忆: the on/off switch, and the state it decides.
 *
 * Where the graph is stored belongs to the memory service's own configuration
 * — a deployment that keeps a Neo4j graph says so there — and nothing in this
 * window has to know which store answered, so no part of it is asked here. The
 * page writes only the field it shows: a press cannot carry a value the reader
 * did not mean to change. The status line beside the switch is this page's
 * whole answer to "is it working", and it is read only while memory is on.
 */
export function MemorySettings({ client }: Props) {
  const loaded = useLoaded<MemoryGraphSettingsDetails>(() => getMemoryGraphSettings(client));
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<string>();
  const [failure, setFailure] = useState<string>();

  const save = async (body: UpdateMemoryGraphSettingsRequest) => {
    setBusy(true);
    setFailure(undefined);
    try {
      await updateMemoryGraphSettings(client, body);
      setSavedAt(new Date().toLocaleTimeString());
      loaded.reload();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <LoadGate loaded={loaded}>
      {(settings) => {
        const text = TEXT.settings.system.memory;
        return (
          <Group>
            <p className="settings-note">{text.help}</p>

            <Row hint={text.enabledHint} title={text.enabled}>
              {/* The state reads beside the switch, because the switch is what
                  decides it. Turning memory on is what starts the read; a row
                  that asked `/api/health` while memory was off was reporting
                  on something the reader had already turned off. */}
              <span className="memory-switch">
                <MemoryStatus client={client} enabled={settings.enabled} />
                <Switch
                  disabled={busy}
                  label={text.enabled}
                  onChange={(enabled) => void save({ enabled })}
                  value={settings.enabled}
                />
              </span>
            </Row>

            <small aria-live="polite" className="settings-detail-meta">
              {busy
                ? TEXT.settings.system.saving
                : savedAt === undefined
                  ? null
                  : `${TEXT.settings.system.timeouts.saved} · ${savedAt}`}
            </small>
            {failure ? <small className="row-note is-error">{failure}</small> : null}
          </Group>
        );
      }}
    </LoadGate>
  );
}

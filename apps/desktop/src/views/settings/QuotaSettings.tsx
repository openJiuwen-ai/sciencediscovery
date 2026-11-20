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
import { getQuotaSettings, updateQuotaSettings } from "../../api/settings.js";
import type { SystemQuotaSettings } from "../../api/types.js";
import { useLoaded } from "../../app/use-loaded.js";
import { TEXT } from "../../text.js";
import { Group, LoadGate, Row, Switch } from "./rows.js";
import { SettingsNumber, useSettingsWrite, WriteStatus } from "./setting-controls.js";

const GB = 1_000_000_000;
type ByteField = Exclude<keyof SystemQuotaSettings, "maxConcurrentSubagents">;

export function QuotaSettings({ client, onSaved }: {
  client: ApiClient; onSaved: (settings: SystemQuotaSettings) => void;
}) {
  const loaded = useLoaded(() => getQuotaSettings(client));
  const write = useSettingsWrite();
  return <LoadGate loaded={loaded}>{settings => {
    const text = TEXT.settings.system.quotas;
    const disabled = write.busy || loaded.loading;
    const save = (patch: Partial<SystemQuotaSettings>) => void write.run(async () => {
      const saved = await updateQuotaSettings(client, { ...settings, ...patch });
      onSaved(saved);
      loaded.reload();
    });
    const fields: { field: ByteField; title: string; hint: string; fallback: number }[] = [
      { field: "runnerMaxWorkspaceBytes", title: text.workspace, hint: text.workspaceHint, fallback: 10 * GB },
      { field: "runnerMaxOutputBytes", title: text.output, hint: text.outputHint, fallback: GB },
      { field: "uploadMaxFileBytes", title: text.uploadFile, hint: text.uploadFileHint, fallback: GB },
      { field: "uploadMaxRequestBytes", title: text.uploadRequest, hint: text.uploadRequestHint, fallback: 10 * GB },
    ];
    return <>
      <Group><p className="settings-note">{text.help}</p>
        <Row title={text.subagents} hint={text.subagentsHint}>
          <SettingsNumber label={text.subagents} value={settings.maxConcurrentSubagents ?? 10} min={1} max={10}
            disabled={disabled} onCommit={value => save({ maxConcurrentSubagents: value })} />
        </Row>
      </Group>
      {[fields.slice(0, 2), fields.slice(2)].map((group, index) => <Group key={index}>
        {group.map(({ field, title, hint, fallback }) => <Row key={field} title={title} hint={hint}>
          <div className="row-inline-control">
            <SettingsNumber label={title} value={settings[field]} scale={GB} precision={2} min={0.01}
              disabled={disabled || settings[field] === 0} onCommit={value => save({ [field]: value })} />
            <small>{text.gb}</small>
            <label className="settings-toggle-line"><span>{TEXT.settings.system.timeouts.unlimited}</span>
              <Switch label={`${title} · ${TEXT.settings.system.timeouts.unlimited}`} disabled={disabled}
                value={settings[field] === 0} onChange={unlimited => save({ [field]: unlimited ? 0 : fallback })} />
            </label>
          </div>
        </Row>)}
      </Group>)}
      <WriteStatus state={write} />
    </>;
  }}</LoadGate>;
}

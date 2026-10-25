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

import type { ApiClient } from "../../../api/client.js";
import { getTimeoutSettings, updateTimeoutSettings } from "../../../api/settings.js";
import type { SystemTimeoutSettings } from "../../../api/types.js";
import { useLoaded } from "../../../app/use-loaded.js";
import { TEXT } from "../../../text.js";
import { Group, LoadGate, Row, Switch } from "../rows.js";
import { useSettingsSave } from "./save.js";

type TimeoutField = keyof SystemTimeoutSettings;

function fields(): { field: TimeoutField; hint: string; label: string }[] {
  const text = TEXT.settings.system.timeouts;
  return [
    { field: "gatewayIdleTimeoutMs", label: text.gatewayIdle, hint: text.gatewayIdleHint },
    { field: "gatewayTurnTimeoutMs", label: text.gatewayTurn, hint: text.gatewayTurnHint },
    { field: "kernelIdleTimeoutMs", label: text.kernelIdle, hint: text.kernelIdleHint },
    { field: "permissionWaitTimeoutMs", label: text.permissionWait, hint: text.permissionWaitHint },
    { field: "runnerExecTimeoutMs", label: text.runnerExec, hint: text.runnerExecHint },
  ];
}

function seconds(ms: number): string {
  return String(Math.round((ms / 1000) * 1000) / 1000);
}

/** 设置 › 超时: the wall-clock limits, where zero means 不限. */
export function TimeoutSettings({ client }: { client: ApiClient }) {
  const loaded = useLoaded<SystemTimeoutSettings>(async () => getTimeoutSettings(client));
  const [draft, setDraft] = useState<SystemTimeoutSettings>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (loaded.value !== undefined) setDraft(loaded.value);
  }, [loaded.value]);

  useSettingsSave(async () => {
    if (draft === undefined) return true;
    setFailure(undefined);
    try {
      await updateTimeoutSettings(client, draft);
      loaded.reload();
      return true;
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
      return false;
    }
  });

  const setMilliseconds = (field: TimeoutField, value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    setDraft((current) => (current === undefined
      ? current
      : ({ ...current, [field]: Math.round(parsed * 1000) } as SystemTimeoutSettings)));
  };

  return (
    <LoadGate loaded={loaded}>
      {(settings) => {
        const current = draft ?? settings;
        return (
          <Group>
            <p className="settings-note">{TEXT.settings.system.timeouts.help}</p>
            {fields().map(({ field, hint, label }) => {
              const unlimited = current[field] === 0;
              return (
                <Row hint={hint} key={field} title={label}>
                  <div className="row-inline-control">
                    <input
                      aria-label={label}
                      className="field-input is-number"
                      disabled={unlimited}
                      min="0.001"
                      onChange={(event) => setMilliseconds(field, event.target.value)}
                      step="0.001"
                      type="number"
                      value={unlimited ? "" : seconds(current[field])}
                    />
                    <small>{TEXT.settings.system.timeouts.seconds}</small>
                    <label className="settings-toggle-line">
                      <span>{TEXT.settings.system.timeouts.unlimited}</span>
                      <Switch
                        label={`${label} · ${TEXT.settings.system.timeouts.unlimited}`}
                        onChange={(next) => setDraft({
                          ...current,
                          [field]: next ? 0 : (current[field] || 60_000),
                        } as SystemTimeoutSettings)}
                        value={unlimited}
                      />
                    </label>
                  </div>
                </Row>
              );
            })}
            {failure ? <small className="row-note is-error">{failure}</small> : null}
          </Group>
        );
      }}
    </LoadGate>
  );
}

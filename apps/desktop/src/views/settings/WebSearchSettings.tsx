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
import type { ApiClient } from "../../api/client.js";
import { getWebSettings, updateWebSettings } from "../../api/settings.js";
import type { UpdateWebSettingsRequest, WebKeyProvider } from "../../api/types.js";
import { useLoaded } from "../../app/use-loaded.js";
import type { ConfirmRequest } from "../../app/use-workspace.js";
import { TEXT } from "../../text.js";
import { SettingsModal } from "./SettingsModal.js";
import { Group, LoadGate, Row, Switch, Tag } from "./rows.js";
import { useSettingsWrite, WriteStatus } from "./setting-controls.js";

const PROVIDERS: { id: WebKeyProvider; name: string }[] = [
  { id: "bocha", name: "Bocha" }, { id: "perplexity", name: "Perplexity" },
  { id: "serper", name: "Serper" }, { id: "jina", name: "Jina" },
  { id: "deepseek", name: "DeepSeek" },
];

export function WebSearchSettings({ client, onConfirm }: {
  client: ApiClient; onConfirm: (request: ConfirmRequest) => void;
}) {
  const loaded = useLoaded(() => getWebSettings(client));
  const write = useSettingsWrite();
  const [editing, setEditing] = useState<{ id: WebKeyProvider; name: string }>();
  const [key, setKey] = useState("");
  const text = TEXT.settings.system.migrated.web;
  const common = TEXT.settings.system.migrated.common;
  const save = (patch: UpdateWebSettingsRequest) => write.run(async () => {
    await updateWebSettings(client, patch);
    loaded.reload();
  });
  return <LoadGate loaded={loaded}>{settings => {
    if (settings.backend !== "jiuwenswarm") return <Group><p className="settings-note">{text.unsupported}</p></Group>;
    const disabled = write.busy || loaded.loading;
    const hasDeepseekKey = settings.providers.some(item => item.provider === "deepseek" && item.hasApiKey);
    const fetchProvider = settings.deepseekEnabled && settings.fetchProvider === "deepseek" ? "deepseek" : "jina";
    const credentialPatch = (provider: WebKeyProvider, value: string | null | undefined): UpdateWebSettingsRequest => {
      const keys = value === undefined ? {} : { providerApiKeys: { [provider]: value } };
      if (provider !== "deepseek") return keys;
      const enabled = value !== null;
      return {
        ...keys,
        deepseekEnabled: enabled,
        paidSearchProviders: enabled
          ? [...settings.paidSearchProviders.filter(id => id !== "deepseek"), "deepseek"]
          : settings.paidSearchProviders.filter(id => id !== "deepseek"),
        // Saving a search credential must not activate a reader hidden behind the old master switch.
        ...(settings.fetchProvider === "deepseek" && (!enabled || !settings.deepseekEnabled) ? { fetchProvider: "jina" } : {}),
      };
    };
    const providerRow = (provider: { id: WebKeyProvider; name: string }) => {
      const saved = settings.providers.some(item => item.provider === provider.id && item.hasApiKey);
      const inactive = provider.id === "deepseek" && saved
        && (!settings.deepseekEnabled || !settings.paidSearchProviders.includes("deepseek"));
      return <Row key={provider.id} title={provider.name} hint={inactive ? text.reconfigureToEnable : undefined}>
        <div className="row-inline-control"><Tag>{inactive ? text.searchInactive : saved ? text.configured : text.missing}</Tag>
          <button className="secondary-button" type="button" disabled={disabled}
            onClick={() => { setKey(""); setEditing(provider); }}>{text.configure}</button>
          {saved ? <button className="danger-button" type="button" disabled={disabled}
            aria-label={`${provider.name} · ${common.remove}`} onClick={() => onConfirm({
              title: text.removeTitle,
              body: provider.id === "deepseek" && settings.fetchProvider === "deepseek" ? text.deepseekRemoveBody : text.removeBody,
              eyebrow: provider.name, accept: common.remove,
              onAccept: async () => { await save(credentialPatch(provider.id, null)); },
            })}>{common.remove}</button> : null}
        </div>
      </Row>;
    };
    return <>
      <Group heading={text.free}>
        <p className="settings-note">{text.freeHint}</p>
        {([{ id: "duckduckgo", name: "DuckDuckGo" }, { id: "bing", name: "Bing" }] as const).map(engine =>
          <Row key={engine.id} title={engine.name}><Switch disabled={disabled} label={engine.name}
            value={settings.freeSearchEngines[engine.id]} onChange={enabled => void save({
              freeSearchEngines: { ...settings.freeSearchEngines, [engine.id]: enabled },
            })} /></Row>)}
      </Group>
      <Group heading={text.paid}><p className="settings-note">{text.paidHint}</p>{PROVIDERS.map(provider => providerRow(provider))}</Group>
      <Group heading={text.fetchHeading}>
        <Row title={text.fetchProvider} hint={!hasDeepseekKey ? text.keyRequired : undefined}>
          <select className="field-select scale-select" aria-label={text.fetchProvider} value={fetchProvider} disabled={disabled}
            onChange={event => {
              const value = event.target.value;
              if (value === "jina") void save({ fetchProvider: "jina" });
              else if (value === "deepseek" && hasDeepseekKey) void save({
                fetchProvider: "deepseek", deepseekEnabled: true,
                paidSearchProviders: [...settings.paidSearchProviders.filter(id => id !== "deepseek"), "deepseek"],
              });
            }}>
            <option value="jina">{text.fetchDefault}</option>
            <option value="deepseek" disabled={!hasDeepseekKey}>DeepSeek</option>
          </select>
        </Row>
        {fetchProvider === "deepseek" ? <p className="settings-note">{text.fetchCost}</p> : null}
      </Group>
      <WriteStatus state={write} />
      <p className="settings-note">{text.activation}</p>
      {editing ? <SettingsModal label={`${editing.name} · ${text.key}`} onClose={() => { setEditing(undefined); setKey(""); }}>
        <form className="settings-card-form" onSubmit={async event => {
          event.preventDefault();
          if (!key.trim() && !(editing.id === "deepseek" && hasDeepseekKey)) { setEditing(undefined); return; }
          if (await save(credentialPatch(editing.id, key.trim() || undefined))) { setKey(""); setEditing(undefined); }
        }}>
          <p className="settings-note">{editing.id === "deepseek" ? text.deepseekKeyHint : text.keyHint}</p>
          <Row title={text.key} tone="stack"><input aria-label={text.key} className="field-input" type="password"
            autoComplete="new-password" value={key} disabled={write.busy} onChange={event => setKey(event.target.value)} /></Row>
          <WriteStatus state={write} />
          <div className="settings-form-actions"><button className="secondary-button" type="button" disabled={write.busy}
            onClick={() => { setEditing(undefined); setKey(""); }}>{common.cancel}</button>
            <button className="primary-button" type="submit" disabled={disabled}>{common.save}</button></div>
        </form>
      </SettingsModal> : null}
    </>;
  }}</LoadGate>;
}

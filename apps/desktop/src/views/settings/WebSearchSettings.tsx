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
import { Group, LoadGate, Row, Select, Switch, Tag } from "./rows.js";
import { useSettingsWrite, WriteStatus } from "./setting-controls.js";

const PROVIDERS: { id: WebKeyProvider; name: string }[] = [
  { id: "bocha", name: "Bocha" }, { id: "perplexity", name: "Perplexity" },
  { id: "serper", name: "Serper" }, { id: "jina", name: "Jina" },
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
    const providerRow = (provider: { id: WebKeyProvider; name: string }) => {
      const saved = settings.providers.some(item => item.provider === provider.id && item.hasApiKey);
      return <Row key={provider.id} title={provider.name}>
        <div className="row-inline-control"><Tag>{saved ? text.configured : text.missing}</Tag>
          <button className="secondary-button" type="button" disabled={disabled}
            onClick={() => { setKey(""); setEditing(provider); }}>{text.configure}</button>
          {saved ? <button className="danger-button" type="button" disabled={disabled}
            aria-label={`${provider.name} · ${common.remove}`} onClick={() => onConfirm({
              title: text.removeTitle, body: text.removeBody, eyebrow: provider.name, accept: common.remove,
              onAccept: async () => { await save({ providerApiKeys: { [provider.id]: null } }); },
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
      <Group heading={text.paid}><p className="settings-note">{text.paidHint}</p>{PROVIDERS.map(providerRow)}</Group>
      <Group heading="DeepSeek">
        <Row title={text.deepseek} hint={text.deepseekHint}><Switch label={text.deepseek} disabled={disabled}
          value={settings.deepseekEnabled} onChange={deepseekEnabled => void save({ deepseekEnabled })} /></Row>
        {providerRow({ id: "deepseek", name: "DeepSeek" })}
        <Row title={text.deepseekSearch}><Switch label={text.deepseekSearch} disabled={disabled || !settings.deepseekEnabled}
          value={settings.paidSearchProviders.includes("deepseek")}
          onChange={enabled => void save({ paidSearchProviders: enabled
            ? [...settings.paidSearchProviders.filter(id => id !== "deepseek"), "deepseek"]
            : settings.paidSearchProviders.filter(id => id !== "deepseek") })} /></Row>
      </Group>
      <Group heading={text.fetch}>
        <Row title={text.fetchProvider}><Select label={text.fetchProvider} disabled={disabled}
          value={settings.fetchProvider === "deepseek" ? "deepseek" : "jina"}
          options={[{ value: "jina", label: text.fetchDefault }, { value: "deepseek", label: "DeepSeek" }]}
          onChange={value => { if (value === "jina" || value === "deepseek") void save({ fetchProvider: value }); }} /></Row>
        {!settings.deepseekEnabled && settings.fetchProvider === "deepseek" ? <p className="settings-note">{text.deepseekInactive}</p> : null}
      </Group>
      <WriteStatus state={write} />
      <p className="settings-note">{text.activation}</p>
      {editing ? <SettingsModal label={`${editing.name} · ${text.key}`} onClose={() => { setEditing(undefined); setKey(""); }}>
        <form className="settings-card-form" onSubmit={async event => {
          event.preventDefault();
          if (!key.trim()) { setEditing(undefined); return; }
          if (await save({ providerApiKeys: { [editing.id]: key.trim() } })) { setKey(""); setEditing(undefined); }
        }}>
          <p className="settings-note">{text.keyHint}</p>
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

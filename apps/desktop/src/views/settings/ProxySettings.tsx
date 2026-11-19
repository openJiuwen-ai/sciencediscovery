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
import {
  createProxyServer, deleteProxyServer, getMcpProxyPolicies, getProxySettings, getWebSettings,
  listMcpSources, testProxyConnectivity, updateMcpProxyPolicies, updateProxyServer, updateProxySettings, updateWebSettings,
} from "../../api/settings.js";
import type { CreateProxyServerRequest, ProxyPolicy, ProxyServer, ProxySettingsDetails, ResolvedProxy } from "../../api/types.js";
import { useLoaded } from "../../app/use-loaded.js";
import type { ConfirmRequest } from "../../app/use-workspace.js";
import { TEXT } from "../../text.js";
import { SettingsModal } from "./SettingsModal.js";
import { Group, LoadGate, Row, Select } from "./rows.js";
import { useSettingsWrite, WriteStatus } from "./setting-controls.js";

function kindLabel(kind: ProxyServer["kind"]) {
  const text = TEXT.settings.system.proxies;
  return kind === "custom_url" ? text.kindCustom : kind === "environment" ? text.kindEnvironment : text.kindSystem;
}

function PolicySelect({ settings, value, disabled, label, inherit = true, onChange }: {
  settings: ProxySettingsDetails; value: ProxyPolicy; disabled: boolean; label: string; inherit?: boolean;
  onChange: (policy: ProxyPolicy) => void;
}) {
  const text = TEXT.settings.system.proxies;
  const options: { value: ProxyPolicy; label: string }[] = [
    ...(inherit ? [{ value: "inherit" as const, label: text.inherit }] : []),
    { value: "none", label: text.none },
    ...settings.servers.map(server => ({ value: `proxy:${server.id}` as const, label: `${server.name} · ${kindLabel(server.kind)}` })),
  ];
  return <Select label={label} value={value} disabled={disabled} options={options}
    onChange={next => { const option = options.find(item => item.value === next); if (option) onChange(option.value); }} />;
}

export function ProxySettings({ client, onConfirm }: { client: ApiClient; onConfirm: (request: ConfirmRequest) => void }) {
  const loaded = useLoaded(() => getProxySettings(client));
  const write = useSettingsWrite();
  const [editing, setEditing] = useState<{ server?: ProxyServer }>();
  const [testResult, setTestResult] = useState<string>();
  const text = TEXT.settings.system.proxies;
  const extra = TEXT.settings.system.migrated.proxy;
  const common = TEXT.settings.system.migrated.common;
  const run = (operation: () => Promise<unknown>) => write.run(async () => {
    await operation(); setTestResult(undefined); loaded.reload();
  });
  return <LoadGate loaded={loaded}>{settings => {
    const disabled = write.busy || loaded.loading;
    const selected = settings.servers.find(server => `proxy:${server.id}` === settings.defaultPolicy);
    const test = () => void write.run(async () => {
      let proxy: ResolvedProxy;
      if (!selected) {
        if (settings.defaultPolicy !== "none") throw new Error(TEXT.settings.saveFailed);
        proxy = { mode: "direct", noProxy: settings.noProxy };
      } else if (selected.kind === "environment") proxy = { mode: "environment", noProxy: settings.noProxy };
      else if (selected.kind === "custom_url" && selected.url) proxy = { mode: "url", url: selected.url, noProxy: settings.noProxy };
      else throw new Error(extra.systemTest);
      const result = await testProxyConnectivity(client, proxy);
      setTestResult(`${result.ok ? extra.testOk : extra.testFailed} · ${result.message} (${result.elapsedMs} ms)`);
    }, false);
    return <>
      <Group heading={text.defaultHeading}>
        <p className="settings-note">{extra.scope}</p>
        <Row title={text.default} hint={text.defaultHint}>
          <div className="proxy-default-controls">
            <div className="row-inline-control">
              <PolicySelect label={text.default} settings={settings}
                value={settings.defaultPolicy} inherit={false} disabled={disabled} onChange={defaultPolicy => {
                  if (defaultPolicy !== "inherit") void run(() => updateProxySettings(client, { defaultPolicy }));
                }} />
              <button className="secondary-button" type="button" disabled={disabled || selected?.kind === "system"}
                title={selected?.kind === "system" ? extra.systemTest : undefined}
                onClick={() => { setTestResult(undefined); test(); }}>{extra.test}</button>
            </div>
            {selected?.kind === "system" ? <small className="settings-note">{extra.systemTest}</small> : null}
            {testResult ? <p className="settings-note" role="status">{testResult}</p> : null}
          </div>
        </Row>
        <ProxyBypass key={settings.noProxy ?? ""} value={settings.noProxy ?? ""} disabled={disabled}
          onSave={async noProxy => { await run(() => updateProxySettings(client, { defaultPolicy: settings.defaultPolicy, noProxy })); }} />
      </Group>
      <Group heading={text.serversHeading} actions={
        <button className="secondary-button" type="button" disabled={disabled} onClick={() => setEditing({})}>{text.add}</button>
      }>
        {!settings.servers.length ? <p className="settings-empty">{text.empty}</p> : settings.servers.map(server => <Row key={server.id} title={server.name} hint={kindLabel(server.kind)}>
          <div className="row-inline-control"><button className="secondary-button" type="button" disabled={disabled} onClick={() => setEditing({ server })}>{common.edit}</button>
            <button className="danger-button" type="button" disabled={disabled} aria-label={`${server.name} · ${common.remove}`}
              onClick={() => onConfirm({ title: text.deleteTitle(server.name), body: extra.deleteBody, eyebrow: text.serversHeading, accept: common.remove,
                onAccept: async () => { await run(() => deleteProxyServer(client, server.id)); } })}>{common.remove}</button></div>
        </Row>)}
      </Group>
      <WriteStatus state={write} />
      <ProxyModules key={settings.servers.map(server => server.id).join(":")} client={client} settings={settings} />
      {editing ? <ProxyForm key={editing.server?.id ?? "new"} server={editing.server} disabled={disabled} write={write}
        onClose={() => setEditing(undefined)} onSave={async body => {
          const server = editing.server;
          if (await run(() => server ? updateProxyServer(client, server.id, body) : createProxyServer(client, body))) setEditing(undefined);
        }} /> : null}
    </>;
  }}</LoadGate>;
}

function ProxyBypass({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (value: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  const text = TEXT.settings.system.migrated.proxy;
  return (
    <Row title={text.noProxy} hint={text.noProxyHint} tone="stack">
      <form className="proxy-bypass-editor" onSubmit={event => { event.preventDefault(); void onSave(draft.trim()); }}>
        <input className="field-input" aria-label={text.noProxy} value={draft} maxLength={4000}
          disabled={disabled} onChange={event => setDraft(event.target.value)} />
        <button className="secondary-button" type="submit" disabled={disabled || draft.trim() === value}>{TEXT.settings.system.migrated.common.save}</button>
      </form>
    </Row>
  );
}

function ProxyForm({ server, disabled, write, onSave, onClose }: {
  server?: ProxyServer; disabled: boolean; write: ReturnType<typeof useSettingsWrite>;
  onSave: (body: CreateProxyServerRequest) => Promise<void>; onClose: () => void;
}) {
  const text = TEXT.settings.system.proxies;
  const common = TEXT.settings.system.migrated.common;
  const [name, setName] = useState(server?.name ?? "");
  const [kind, setKind] = useState<ProxyServer["kind"]>(server?.kind ?? "custom_url");
  const [url, setUrl] = useState(server?.url ?? "");
  const kinds: ProxyServer["kind"][] = ["custom_url", "environment", "system"];
  const requiresUrl = kind === "custom_url" && (!server || server.kind !== "custom_url");
  return <SettingsModal label={server ? `${common.edit} · ${server.name}` : text.add} onClose={onClose}>
    <form className="settings-card-form" onSubmit={event => {
      event.preventDefault(); if (!name.trim() || (requiresUrl && !url.trim())) return;
      void onSave({ name: name.trim(), kind, ...(kind === "custom_url" && url.trim() && url.trim() !== server?.url ? { url: url.trim() } : {}) });
    }}>
      <Row title={text.name} tone="stack"><input className="field-input" aria-label={text.name} value={name} required maxLength={200} disabled={disabled} onChange={event => setName(event.target.value)} /></Row>
      <Row title={text.kind}><Select label={text.kind} disabled={disabled} value={kind} options={kinds.map(value => ({ value, label: kindLabel(value) }))}
        onChange={value => { const found = kinds.find(item => item === value); if (found) setKind(found); }} /></Row>
      {kind === "custom_url" ? <Row title={text.url} hint={text.urlHint} tone="stack"><input className="field-input" type="text" autoComplete="off" spellCheck={false}
        aria-label={text.url} value={url} required={requiresUrl} placeholder={server?.hasUrl ? text.urlStored : text.urlHint}
        disabled={disabled} onChange={event => setUrl(event.target.value)} /></Row> : null}
      <WriteStatus state={write} /><div className="settings-form-actions">
        <button className="secondary-button" type="button" disabled={disabled} onClick={onClose}>{common.cancel}</button>
        <button className="primary-button" type="submit" disabled={disabled || !name.trim() || (requiresUrl && !url.trim())}>{common.save}</button>
      </div>
    </form>
  </SettingsModal>;
}

function ProxyModules({ client, settings }: { client: ApiClient; settings: ProxySettingsDetails }) {
  const loaded = useLoaded(async () => {
    const [sources, policies, web] = await Promise.all([listMcpSources(client), getMcpProxyPolicies(client), getWebSettings(client)]);
    const servers = new Map<string, string[]>();
    for (const source of sources) {
      const id = source.manifest.transport?.mcpServerId;
      if (!id) continue;
      servers.set(id, [...(servers.get(id) ?? []), source.manifest.displayName ?? source.manifest.id]);
    }
    return { servers: [...servers], policies: policies.policies, web };
  });
  const write = useSettingsWrite();
  const text = TEXT.settings.system.migrated.proxy;
  return <LoadGate loaded={loaded}>{page => <Group heading={text.modules}>
    {page.web.backend === "jiuwenswarm" ? <p className="settings-note">{text.swarmNote}</p> : <Row title={text.web}>
      <PolicySelect label={text.web} settings={settings} disabled={write.busy || loaded.loading} value={page.web.proxyPolicy}
        onChange={proxyPolicy => void write.run(async () => { await updateWebSettings(client, { proxyPolicy }); loaded.reload(); })} />
    </Row>}
    {!page.servers.length ? <p className="settings-note">{TEXT.settings.system.proxies.mcpEmpty}</p> : page.servers.map(([id, names]) => <Row key={id} title={names.join(", ")} hint={id}>
      <PolicySelect label={`${text.mcp} · ${names.join(", ")}`} settings={settings} value={page.policies[id] ?? "inherit"} disabled={write.busy || loaded.loading}
        onChange={policy => void write.run(async () => { await updateMcpProxyPolicies(client, { ...page.policies, [id]: policy }); loaded.reload(); })} />
    </Row>)}
    <WriteStatus state={write} />
  </Group>}</LoadGate>;
}

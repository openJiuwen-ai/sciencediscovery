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

import { useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../../api/client.js";
import { getEnvironmentSource, runnerEnvironmentApi, updateEnvironmentSource } from "../../api/settings.js";
import type { Environment, EnvironmentPackageManager, EnvironmentSourceSettings, ScientificLanguage } from "../../api/types.js";
import { useLoaded } from "../../app/use-loaded.js";
import type { ConfirmRequest } from "../../app/use-workspace.js";
import { TEXT } from "../../text.js";
import { SettingsModal } from "./SettingsModal.js";
import { Group, LoadGate, Row, Select, Tag } from "./rows.js";
import { useSettingsWrite, WriteStatus } from "./setting-controls.js";

export function EnvironmentSources({ client }: { client: ApiClient }) {
  const loaded = useLoaded(() => getEnvironmentSource(client));
  const write = useSettingsWrite();
  const text = TEXT.settings.system.migrated.environments;
  const options = [
    { value: "upstream", label: "Official upstream" }, { value: "tsinghua", label: "Tsinghua TUNA" },
    { value: "ustc", label: "USTC" }, { value: "huawei", label: "Huawei Cloud" },
  ] as const;
  return <LoadGate loaded={loaded}>{settings => <Group heading={text.sources}>
    <p className="settings-note">{text.sourcesHint}</p>
    {(["condaSource", "pipSource"] as const).map(field => <Row key={field} title={field === "condaSource" ? text.conda : text.pip}>
      <Select label={field === "condaSource" ? text.conda : text.pip} value={settings[field]}
        disabled={write.busy || loaded.loading} options={options.filter(item => field !== "condaSource" || item.value !== "huawei")}
        onChange={value => {
          const option = options.find(item => item.value === value);
          if (!option || option.value === settings[field] || (field === "condaSource" && option.value === "huawei")) return;
          const patch: Partial<EnvironmentSourceSettings> = {};
          if (field === "condaSource" && option.value !== "huawei") patch.condaSource = option.value;
          else if (field === "pipSource") patch.pipSource = option.value;
          void write.run(async () => { await updateEnvironmentSource(client, patch); loaded.reload(); });
        }} />
    </Row>)}
    <WriteStatus state={write} quiet />
  </Group>}</LoadGate>;
}

export function RunnerEnvironmentPane({ client, runnerId, onConfirm }: {
  client: ApiClient; runnerId: string; onConfirm: (request: ConfirmRequest) => void;
}) {
  const api = useMemo(() => runnerEnvironmentApi(client, runnerId), [client, runnerId]);
  const loaded = useLoaded(async () => {
    const setup = await api.setup();
    if (setup.state !== "ready") return { setup, environments: [], revisions: [] };
    const [environments, revisions] = await Promise.all([api.list(), api.revisions()]);
    return { setup, environments, revisions };
  });
  const write = useSettingsWrite();
  const text = TEXT.settings.system.migrated.environments;
  const common = TEXT.settings.system.migrated.common;
  const [creating, setCreating] = useState(false);
  const [creationWrite, setCreationWrite] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  useEffect(() => {
    if (loaded.value?.setup.state !== "installing") return;
    const timer = window.setInterval(loaded.reload, 1000);
    return () => window.clearInterval(timer);
  }, [loaded.value?.setup.state, loaded.reload]);
  const run = (operation: () => Promise<unknown>, creation = false) => {
    setCreationWrite(creation);
    return write.run(async () => { await operation(); loaded.reload(); });
  };
  return <LoadGate loaded={loaded}>{({ setup, environments, revisions }) => {
    const disabled = write.busy || loaded.loading;
    const selected = environments.find(item => item.id === selectedId);
    return <Group heading={text.heading} actions={<>
      <button className="secondary-button" type="button" disabled={disabled} onClick={loaded.reload}>{common.refresh}</button>
      {setup.state === "ready" ? <button className="secondary-button" type="button" disabled={disabled}
        onClick={() => setCreating(true)}>{text.create}</button> : null}
    </>}>
      {setup.state !== "ready" ? <div className="environment-setup-progress" role="status">
        <Tag>{text.states[setup.state]}</Tag>
        <p>{setup.message}</p>
        {setup.state === "not-configured" ? <small>Python · {setup.starterPackages.python.join(" · ")}</small> : null}
        {Object.entries(setup.components).map(([name, component]) => <div key={name}>
          <strong>{name}</strong><small>{component.message}</small>
          {component.action ? <small>{component.action}</small> : null}
          {component.error ? <p className="row-note is-error">{component.error}</p> : null}
        </div>)}
        {setup.error || setup.lastError ? <p className="row-note is-error">{setup.error || setup.lastError}</p> : null}
        <button className="primary-button" type="button" disabled={disabled || setup.state === "disabled" || setup.state === "installing"}
          onClick={() => void run(api.initialize)}>{setup.state === "failed" ? text.retry : text.initialize}</button>
      </div> : <>
        <p className="settings-note">{text.catalogHint}</p>
        {!environments.length ? <p className="settings-empty">{text.empty}</p> : environments.map(environment => <div className="settings-card" key={environment.id}>
          <button className="settings-card-main" type="button" disabled={disabled} onClick={() => setSelectedId(environment.id)}>
            <strong>{environment.name}</strong><small>{environment.language.toUpperCase()} · {environment.kind === "starter" ? text.base : text.managed}</small>
          </button><Tag>{text.environmentStates[environment.status ?? "ready"]}</Tag>
        </div>)}
      </>}
      <WriteStatus state={write} pendingLabel={creationWrite ? text.creating : undefined} successLabel={creationWrite ? text.created : undefined} />
      {creating ? <CreateEnvironment onClose={() => setCreating(false)} busy={disabled} write={write}
        onCreate={async body => { if (await run(() => api.create(body), true)) setCreating(false); }} /> : null}
      {selected ? <SettingsModal wide label={selected.name} onClose={() => setSelectedId(undefined)}>
        <div className="environment-details">
          <div className="environment-details-header">
            <div className="environment-version"><strong>{text.revision}</strong><code>{selected.currentRevisionId}</code></div>
            {selected.kind === "task" ? <button className="danger-button" type="button" disabled={disabled}
              onClick={() => onConfirm({ title: text.deleteTitle, body: text.deleteBody, eyebrow: selected.name, accept: common.remove,
                onAccept: async () => { if (await run(() => api.remove(selected.id))) setSelectedId(undefined); } })}>{common.remove}</button> : null}
          </div>
          {selected.error ? <p className="row-note is-error" role="alert">{selected.error}</p> : null}
          {selected.kind === "task" ?
            <InstallPackages key={selected.id} environment={selected} disabled={disabled}
              onInstall={async (manager, packages) => run(() => api.install(selected.id, { manager, packages }))} />
          : <p className="settings-note">{text.base}</p>}
          <WriteStatus state={write} />
          <Row title={text.installedPackages} hint={text.installedPackagesHint} tone="stack"><p className="environment-package-list">{revisions.find(item => item.id === selected.currentRevisionId)?.packages.join(" · ") || text.noSnapshot}</p></Row>
        </div>
      </SettingsModal> : null}
    </Group>;
  }}</LoadGate>;
}

function CreateEnvironment({ onClose, onCreate, busy, write }: {
  onClose: () => void; onCreate: (body: { language: ScientificLanguage; name: string }) => Promise<void>;
  busy: boolean; write: ReturnType<typeof useSettingsWrite>;
}) {
  const text = TEXT.settings.system.migrated.environments;
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<ScientificLanguage>("python");
  return <SettingsModal label={text.create} onClose={onClose}>
    <form className="settings-card-form" onSubmit={event => { event.preventDefault(); if (name.trim()) void onCreate({ name: name.trim(), language }); }}>
      <Row title={text.name} tone="stack"><input className="field-input" aria-label={text.name} value={name} maxLength={80} required disabled={busy} onChange={event => setName(event.target.value)} /></Row>
      <Row title={text.language}><Select label={text.language} value={language} disabled={busy}
        options={[{ value: "python", label: "Python" }, { value: "r", label: "R" }]}
        onChange={value => { if (value === "python" || value === "r") setLanguage(value); }} /></Row>
      <WriteStatus state={write} pendingLabel={text.creating} successLabel={null} /><div className="settings-form-actions"><button className="primary-button" type="submit" disabled={busy || !name.trim()}>{text.create}</button></div>
    </form>
  </SettingsModal>;
}

function InstallPackages({ environment, disabled, onInstall }: {
  environment: Environment; disabled: boolean;
  onInstall: (manager: EnvironmentPackageManager, packages: string[]) => Promise<boolean>;
}) {
  const text = TEXT.settings.system.migrated.environments;
  const [packages, setPackages] = useState("");
  const [manager, setManager] = useState<EnvironmentPackageManager>("conda");
  const managers: EnvironmentPackageManager[] = ["conda", "pip", "cran", "bioconductor"];
  return <form className="settings-card-form" onSubmit={async event => {
    event.preventDefault();
    const items = packages.split(/[\s,]+/).filter(Boolean);
    if (items.length && await onInstall(manager, items)) setPackages("");
  }}>
    <Row title={text.manager}><Select label={text.manager} disabled={disabled} value={manager}
      options={managers.map(value => ({ value, label: value }))} onChange={value => { const found = managers.find(item => item === value); if (found) setManager(found); }} /></Row>
    <Row title={text.packages} hint={text.packagesHint} tone="stack"><div>
      <textarea className="field-textarea is-code" rows={3} aria-label={`${environment.name} · ${text.packages}`}
        disabled={disabled} value={packages} onChange={event => setPackages(event.target.value)} />
      <div className="settings-form-actions"><button className="secondary-button" type="submit" disabled={disabled || !packages.trim()}>{text.install}</button></div>
    </div></Row>
  </form>;
}

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

import { useEffect, useMemo, useState, type FormEvent } from "react";

import {
  ENVIRONMENT_CONDA_SOURCE_PRESETS,
  ENVIRONMENT_PIP_SOURCE_PRESETS,
  environmentPackageSourcePreset,
  type EnvironmentCondaSourceId,
  type Environment,
  type EnvironmentPackageManager,
  type EnvironmentPipSourceId,
  type EnvironmentRevision,
  type EnvironmentSourceSettings,
  type ScientificEnvironmentSetup,
  type ScientificLanguage,
} from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";

export function EnvironmentSourceSettingsEditor({
  busy,
  draft,
  onChange,
  onSave,
  saved,
  savedSettings,
}: {
  busy: boolean;
  draft: EnvironmentSourceSettings;
  onChange: (settings: EnvironmentSourceSettings) => void;
  onSave: () => void;
  saved: boolean;
  savedSettings: EnvironmentSourceSettings;
}) {
  const changed = draft.condaSource !== savedSettings.condaSource
    || draft.pipSource !== savedSettings.pipSource;
  return <>
    <div className="environment-create environment-source-settings">
      <div className="environment-source-intro">
        <strong>Global package sources</strong>
        <small>Used for managed installs when a request does not provide a one-time source override. These choices are system-wide, not Project-specific.</small>
      </div>
      <label className="environment-source-pip">
        <small>pip source</small>
        <select
          aria-label="Global pip source"
          disabled={busy}
          value={draft.pipSource}
          onChange={(event) => onChange({ ...draft, pipSource: event.target.value as EnvironmentPipSourceId })}
        >
          {ENVIRONMENT_PIP_SOURCE_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
      </label>
      <label className="environment-source-conda">
        <small>conda source</small>
        <select
          aria-label="Global conda source"
          disabled={busy}
          value={draft.condaSource}
          onChange={(event) => onChange({ ...draft, condaSource: event.target.value as EnvironmentCondaSourceId })}
        >
          {ENVIRONMENT_CONDA_SOURCE_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
      </label>
      <button className="secondary-button environment-source-save" disabled={busy || !changed} onClick={onSave} type="button">Save package sources</button>
    </div>
    <p className="config-note environment-source-summary">
      <span>pip: {environmentPackageSourcePreset(draft.pipSource).pipIndexUrl}</span>
      <span>conda: {environmentPackageSourcePreset(draft.condaSource).condaChannels.join(", ")}</span>
      {saved ? <span>Saved.</span> : null}
    </p>
  </>;
}

export function EnvironmentManager({ client, onError }: { client: ApiClient; onError: (message: string) => void }) {
  const [setup, setSetup] = useState<ScientificEnvironmentSetup>();
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [revisions, setRevisions] = useState<EnvironmentRevision[]>([]);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<ScientificLanguage>("python");
  const [installDrafts, setInstallDrafts] = useState<Record<string, string>>({});
  const [managerDrafts, setManagerDrafts] = useState<Record<string, EnvironmentPackageManager>>({});
  const [sourceSettings, setSourceSettings] = useState<EnvironmentSourceSettings>();
  const [sourceDraft, setSourceDraft] = useState<EnvironmentSourceSettings>();
  const [sourceSaved, setSourceSaved] = useState(false);

  const revisionById = useMemo(() => new Map(revisions.map((revision) => [revision.id, revision])), [revisions]);

  async function refresh(): Promise<void> {
    const [nextSetup, nextSources] = await Promise.all([
      client.getEnvironmentSetup(),
      client.getEnvironmentSourceSettings(),
    ]);
    setSetup(nextSetup);
    setSourceSettings(nextSources);
    setSourceDraft((current) => current ?? nextSources);
    if (nextSetup.state !== "ready") {
      setEnvironments([]);
      setRevisions([]);
      return;
    }
    const [nextEnvironments, nextRevisions] = await Promise.all([
      client.listEnvironments(),
      client.listEnvironmentRevisions(),
    ]);
    setEnvironments(nextEnvironments);
    setRevisions(nextRevisions);
  }

  useEffect(() => {
    void refresh().catch((reason: Error) => onError(reason.message));
  }, [client]);

  useEffect(() => {
    if (setup?.state !== "installing") return;
    const timer = window.setInterval(() => {
      void refresh().catch((reason: Error) => onError(reason.message));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [client, setup?.state]);

  async function run(operation: () => Promise<void>): Promise<void> {
    setBusy(true);
    onError("");
    try {
      await operation();
      await refresh();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Scientific environment operation failed");
    } finally {
      setBusy(false);
    }
  }

  async function createEnvironment(event: FormEvent): Promise<void> {
    event.preventDefault();
    const requestedName = name.trim();
    if (!requestedName) return;
    await run(async () => {
      await client.createEnvironment({ language, name: requestedName });
      setName("");
    });
  }

  async function saveSources(): Promise<void> {
    if (!sourceDraft) return;
    await run(async () => {
      const saved = await client.updateEnvironmentSourceSettings(sourceDraft);
      setSourceSettings(saved);
      setSourceDraft(saved);
      setSourceSaved(true);
    });
  }

  async function installPackages(environmentId: string): Promise<void> {
    const packages = (installDrafts[environmentId] ?? "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
    if (!packages.length) return;
    await run(async () => {
      await client.installEnvironment(environmentId, { manager: managerDrafts[environmentId] ?? "conda", packages });
      setInstallDrafts((current) => ({ ...current, [environmentId]: "" }));
    });
  }

  async function deleteEnvironment(environment: Environment): Promise<void> {
    if (!window.confirm(`Delete named environment “${environment.name}”? This cannot be undone.`)) return;
    await run(async () => { await client.deleteEnvironment(environment.id); });
  }

  if (!setup || !sourceSettings || !sourceDraft) {
    return <p className="muted">Loading scientific environment settings…</p>;
  }

  return <div className="environment-manager">
    <div className="settings-detail-header">
      <span className="eyebrow">Managed runtimes</span>
      <h3>Scientific environments</h3>
      <p>Use the shared read-only Python base or create named Python and R environments with immutable revisions.</p>
    </div>

    <EnvironmentSourceSettingsEditor
      busy={busy}
      draft={sourceDraft}
      onChange={(settings) => {
        setSourceDraft(settings);
        setSourceSaved(false);
      }}
      onSave={() => void saveSources()}
      saved={sourceSaved}
      savedSettings={sourceSettings}
    />

    <div className={`environment-setup-state ${setup.state}`}>
      <div><strong>{setup.state === "ready" ? "Ready" : setup.state === "installing" ? "Installing" : setup.state === "failed" ? "Setup failed" : setup.state === "disabled" ? "Disabled" : "Not configured"}</strong>
        <small>{setup.message} · Phase: {setup.phase}. {setup.networkPolicy === "offline-cache" ? "Provisioning uses the configured offline cache." : `Provisioning can fetch only through the configured channel arguments: ${setup.allowedChannels.join(", ")}.`} Agent execution remains offline.</small>
      </div>
      {setup.provisioner ? <span>{setup.provisionerVersion ? `micromamba ${setup.provisionerVersion}` : setup.provisioner}</span> : null}
    </div>
    {setup.error ? <p className="environment-error">{setup.error}</p> : null}

    {setup.state !== "ready" ? <>
      <div className="environment-starter-plan">
        <div><strong>Python base</strong><small>{setup.starterPackages.python.join(" · ")}</small></div>
      </div>
      <button className="primary-button" disabled={busy || setup.state === "disabled" || setup.state === "installing"} type="button" onClick={() => void run(async () => { setSetup(await client.setupScientificEnvironments()); })}>
        {setup.state === "installing" || busy ? "Installing managed Python environment…" : setup.state === "failed" ? "Retry Python environment setup" : "Install managed Python environment"}
      </button>
      <p className="config-note">Startup begins this work in the background. It downloads the pinned standalone provisioner into the application data directory and creates only the Python base. Creating an R environment later installs the R base on demand. System Python, R, conda, and shell configuration are unchanged.</p>
    </> : <>
      <form className="environment-create" onSubmit={(event) => void createEnvironment(event)}>
        <div><strong>Create named environment</strong><small>Named environments start from the matching read-only base and receive a new immutable revision after every successful package change.</small></div>
        <select aria-label="Environment language" disabled={busy} value={language} onChange={(event) => setLanguage(event.target.value as ScientificLanguage)}><option value="python">Python</option><option value="r">R</option></select>
        <input aria-label="Environment name" disabled={busy} maxLength={80} required value={name} onChange={(event) => setName(event.target.value)} placeholder="single-cell" />
        <button className="primary-button" disabled={busy || !name.trim()} type="submit">Create</button>
      </form>

      <div className="environment-catalog">
        {environments.map((environment) => {
          const revision = revisionById.get(environment.currentRevisionId);
          return <article key={environment.id}>
            <div className="environment-card-heading"><span><strong>{environment.name}</strong><small>{environment.language.toUpperCase()} · {environment.kind === "starter" ? "base" : "named"} · revision {environment.currentRevisionId.slice(0, 12)}</small></span>{environment.kind === "task" ? <button className="danger-button" disabled={busy} onClick={() => void deleteEnvironment(environment)} type="button">Delete</button> : <span className="environment-readonly">Read-only</span>}</div>
            <p>{revision?.packages.length ? revision.packages.join(" · ") : "Package snapshot unavailable"}</p>
            {environment.kind === "task" ? <div className="environment-install"><select aria-label={`Package manager for ${environment.name}`} disabled={busy} value={managerDrafts[environment.id] ?? "conda"} onChange={(event) => setManagerDrafts((current) => ({ ...current, [environment.id]: event.target.value as EnvironmentPackageManager }))}><option value="conda">conda</option>{environment.language === "python" ? <option value="pip">pip</option> : <><option value="cran">CRAN</option><option value="bioconductor">Bioconductor</option></>}</select><input aria-label={`Packages for ${environment.name}`} disabled={busy} value={installDrafts[environment.id] ?? ""} onChange={(event) => setInstallDrafts((current) => ({ ...current, [environment.id]: event.target.value }))} placeholder={environment.language === "python" ? "scanpy=1.10 leidenalg" : "DESeq2 edgeR"} /><button className="secondary-button" disabled={busy || !(installDrafts[environment.id] ?? "").trim()} onClick={() => void installPackages(environment.id)} type="button">Install packages</button></div> : null}
          </article>;
        })}
      </div>
    </>}
  </div>;
}

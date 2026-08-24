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

import type { FormEvent } from "react";

import {
  FREE_SEARCH_ORDER,
  PAID_SEARCH_ORDER,
  type FreeSearchEngine,
  type PaidSearchProvider,
  type UpdateWebSettingsRequest,
  type WebSettingsDetails,
} from "@sciencediscovery/schema";

import { useLocale } from "./i18n/index.js";

const ENGINE_LABELS: Record<FreeSearchEngine | PaidSearchProvider, string> = {
  bing: "Bing",
  brave: "Brave Search API",
  "brave-html": "Brave (free)",
  duckduckgo: "DuckDuckGo",
  exa: "Exa",
  tavily: "Tavily",
};

export interface WebSettingsDraft {
  keys: Record<"brave" | "exa" | "jina" | "tavily", string>;
  remove: ReadonlySet<string>;
  values: WebSettingsDetails;
}

export function createWebSettingsDraft(settings: WebSettingsDetails): WebSettingsDraft {
  return {
    keys: { brave: "", exa: "", jina: "", tavily: "" },
    remove: new Set(),
    values: settings,
  };
}

export function webSettingsRequest(draft: WebSettingsDraft): UpdateWebSettingsRequest {
  const providerApiKeys: UpdateWebSettingsRequest["providerApiKeys"] = {};
  for (const provider of ["brave", "exa", "jina", "tavily"] as const) {
    if (draft.remove.has(provider)) providerApiKeys[provider] = null;
    else if (draft.keys[provider].trim()) providerApiKeys[provider] = draft.keys[provider].trim();
  }
  return {
    fetchCacheTtlSeconds: draft.values.fetchCacheTtlSeconds,
    fetchProvider: draft.values.fetchProvider,
    freeSearchEngines: draft.values.freeSearchEngines,
    paidSearchProviders: draft.values.paidSearchProviders,
    proxyPolicy: draft.values.proxyPolicy,
    searchCacheTtlSeconds: draft.values.searchCacheTtlSeconds,
    ...(Object.keys(providerApiKeys).length ? { providerApiKeys } : {}),
  };
}

export function WebSettingsEditor({
  draft,
  onChange,
  settings,
}: {
  draft: WebSettingsDraft;
  onChange: (draft: WebSettingsDraft) => void;
  settings: WebSettingsDetails;
}) {
  const { t } = useLocale();
  function submit(event: FormEvent): void {
    event.preventDefault();
  }

  const values = draft.values;
  function togglePaid(provider: PaidSearchProvider, enabled: boolean): void {
    const selected = new Set(values.paidSearchProviders);
    if (enabled) selected.add(provider);
    else selected.delete(provider);
    onChange({ ...draft, values: {
      ...values,
      paidSearchProviders: PAID_SEARCH_ORDER.filter((entry) => selected.has(entry)),
    } });
  }

  return <form className="model-editor" onSubmit={submit}>
    <div className="settings-detail-header">
      <span className="eyebrow">Web providers</span>
      <h3>Web providers</h3>
      <p>Search aggregates several engines for every Session: the paid providers you have keyed are tried first, in the order below, then the free engines you leave enabled. The first engine that returns results wins. Fetch stays a single provider.</p>
    </div>
    <fieldset className="settings-array">
      <legend>Paid search providers (tried first)</legend>
      <div className="settings-choices">
        {PAID_SEARCH_ORDER.map((provider) => {
          const saved = settings.providers.some((item) => item.provider === provider && item.hasApiKey);
          return <label key={provider}>
            <input
              checked={values.paidSearchProviders.includes(provider)}
              onChange={(event) => togglePaid(provider, event.target.checked)}
              type="checkbox"
            />
            <span>{ENGINE_LABELS[provider]}{saved ? " · key saved" : " · no key"}</span>
          </label>;
        })}
      </div>
      <span className="settings-hint">Tried in the order shown. A provider without a saved API key is skipped rather than attempted.</span>
    </fieldset>
    <fieldset className="settings-array">
      <legend>Free search engines (tried after paid)</legend>
      <div className="settings-choices">
        {FREE_SEARCH_ORDER.map((engine) => <label key={engine}>
          <input
            checked={values.freeSearchEngines[engine]}
            onChange={(event) => onChange({ ...draft, values: {
              ...values,
              freeSearchEngines: { ...values.freeSearchEngines, [engine]: event.target.checked },
            } })}
            type="checkbox"
          />
          <span>{ENGINE_LABELS[engine]}</span>
        </label>)}
      </div>
      <span className="settings-hint">No key required. A switched-off engine is never requested.</span>
    </fieldset>
    <label><span>Fetch provider</span><select value={values.fetchProvider} onChange={(event) => onChange({ ...draft, values: { ...values, fetchProvider: event.target.value as typeof values.fetchProvider } })}>
      <option value="jina">Jina (default)</option>
      <option value="tavily">Tavily</option>
      <option value="exa">Exa</option>
    </select></label>
    <div className="config-note">{t("web.proxyMovedNote")}</div>
    <label><span>Search cache (seconds)</span><input min={0} max={2592000} type="number" value={values.searchCacheTtlSeconds} onChange={(event) => onChange({ ...draft, values: { ...values, searchCacheTtlSeconds: Number(event.target.value) } })} /></label>
    <label><span>Fetch cache (seconds)</span><input min={0} max={2592000} type="number" value={values.fetchCacheTtlSeconds} onChange={(event) => onChange({ ...draft, values: { ...values, fetchCacheTtlSeconds: Number(event.target.value) } })} /></label>
    {(["jina", "tavily", "exa", "brave"] as const).map((provider) => {
      const saved = settings.providers.some((item) => item.provider === provider && item.hasApiKey);
      return <div key={provider}>
        <label><span>{provider[0]!.toUpperCase() + provider.slice(1)} API key</span><input
          type="password"
          value={draft.keys[provider]}
          onChange={(event) => {
            onChange({
              ...draft,
              keys: { ...draft.keys, [provider]: event.target.value },
              remove: new Set([...draft.remove].filter((item) => item !== provider)),
            });
          }}
          placeholder={saved ? "Saved · enter a new key to replace it" : provider === "jina" ? "Optional · raises the anonymous rate limit" : "Required when selected"}
        /></label>
        {saved ? <button className={draft.remove.has(provider) ? "credential-remove pending" : "credential-remove"} type="button" onClick={() => {
          const next = new Set(draft.remove);
          if (next.has(provider)) next.delete(provider);
          else next.add(provider);
          onChange({ ...draft, remove: next });
        }}>{draft.remove.has(provider) ? "Saved key will be removed" : "Remove saved key"}</button> : null}
      </div>;
    })}
    <div className="config-note">Provider keys are encrypted by the backend and never returned to this browser. A disabled engine is never requested. Web inherits the global proxy by default; choose direct or one registry entry to override it. Use <code>/web-refresh request</code> to bypass both caches for one run and <code>/web-usage</code> to inspect local call statistics.</div>
  </form>;
}

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

import type { UpdateWebSettingsRequest, WebSettingsDetails } from "@science-agent/schema";

import { useLocale } from "./i18n/index.js";

function editableSettings(settings: WebSettingsDetails): WebSettingsDetails {
  return settings.searchProvider === "ddgs" && settings.searchFallbackProvider === "ddgs"
    ? { ...settings, searchFallbackProvider: null }
    : settings;
}

export interface WebSettingsDraft {
  keys: Record<"brave" | "exa" | "jina" | "tavily", string>;
  remove: ReadonlySet<string>;
  values: WebSettingsDetails;
}

export function createWebSettingsDraft(settings: WebSettingsDetails): WebSettingsDraft {
  return {
    keys: { brave: "", exa: "", jina: "", tavily: "" },
    remove: new Set(),
    values: editableSettings(settings),
  };
}

export function webSettingsRequest(draft: WebSettingsDraft): UpdateWebSettingsRequest {
  const providerApiKeys: UpdateWebSettingsRequest["providerApiKeys"] = {};
  for (const provider of ["brave", "exa", "jina", "tavily"] as const) {
    if (draft.remove.has(provider)) providerApiKeys[provider] = null;
    else if (draft.keys[provider].trim()) providerApiKeys[provider] = draft.keys[provider].trim();
  }
  return {
    ddgsBackend: draft.values.ddgsBackend,
    fetchCacheTtlSeconds: draft.values.fetchCacheTtlSeconds,
    fetchProvider: draft.values.fetchProvider,
    proxyPolicy: draft.values.proxyPolicy,
    searchCacheTtlSeconds: draft.values.searchCacheTtlSeconds,
    searchFallbackProvider: draft.values.searchFallbackProvider,
    searchProvider: draft.values.searchProvider,
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
  return <form className="model-editor" onSubmit={submit}>
    <div className="settings-detail-header">
      <span className="eyebrow">Web providers</span>
      <h3>Web providers</h3>
      <p>Global provider selection for every Session. The free defaults use DDGS with Bing for search and Jina Reader for fetch.</p>
    </div>
    <label><span>Search provider</span><select value={values.searchProvider} onChange={(event) => {
      const searchProvider = event.target.value as typeof values.searchProvider;
      onChange({ ...draft, values: {
        ...values,
        searchProvider,
        ...(searchProvider === "ddgs" ? { searchFallbackProvider: null } : {}),
      } });
    }}>
      <option value="ddgs">DDGS (free default)</option>
      <option value="tavily">Tavily</option>
      <option value="exa">Exa</option>
      <option value="brave">Brave Search</option>
    </select></label>
    {values.searchProvider !== "ddgs" ? <label><span>Search fallback</span><select value={values.searchFallbackProvider ?? "none"} onChange={(event) => onChange({ ...draft, values: { ...values, searchFallbackProvider: event.target.value === "none" ? null : "ddgs" } })}>
      <option value="ddgs">DDGS for transient failures</option>
      <option value="none">No fallback</option>
    </select></label> : null}
    {values.searchProvider === "ddgs" || values.searchFallbackProvider === "ddgs" ? <label><span>{values.searchProvider === "ddgs" ? "DDGS backend" : "DDGS fallback backend"}</span><select value={values.ddgsBackend} onChange={(event) => onChange({ ...draft, values: { ...values, ddgsBackend: event.target.value as typeof values.ddgsBackend } })}>
      <option value="bing">Bing (default)</option>
      <option value="auto">Auto</option>
      <option value="duckduckgo">DuckDuckGo</option>
    </select></label> : null}
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
    <div className="config-note">Provider keys are encrypted by the backend and never returned to this browser. Web inherits the global proxy by default; choose direct or one registry entry to override it. Use <code>/web-refresh request</code> to bypass both caches for one run and <code>/web-usage</code> to inspect local call statistics.</div>
  </form>;
}

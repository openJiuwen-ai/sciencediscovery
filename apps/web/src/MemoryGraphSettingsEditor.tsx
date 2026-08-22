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

import { useLocale, type MessageKey } from "./i18n/index.js";
import type {
  MemoryGraphSettingsDetails,
  UpdateMemoryGraphSettingsRequest,
} from "@sciencediscovery/schema";

export interface MemoryGraphSettingsDraft {
  enabled: boolean;
  neo4jHttp: string;
  neo4jUser: string;
  password: string;
  removePassword: boolean;
}

export function createMemoryGraphSettingsDraft(settings: MemoryGraphSettingsDetails): MemoryGraphSettingsDraft {
  return {
    enabled: settings.enabled,
    neo4jHttp: settings.neo4jHttp,
    neo4jUser: settings.neo4jUser,
    password: "",
    removePassword: false,
  };
}

export function memoryGraphSettingsRequest(draft: MemoryGraphSettingsDraft): UpdateMemoryGraphSettingsRequest {
  return {
    enabled: draft.enabled,
    neo4jHttp: draft.neo4jHttp,
    neo4jUser: draft.neo4jUser,
    ...(draft.removePassword ? { neo4jPassword: null } : draft.password.trim() ? { neo4jPassword: draft.password.trim() } : {}),
  };
}

export function MemoryGraphSettingsEditor({
  draft,
  onChange,
  settings,
}: {
  draft: MemoryGraphSettingsDraft;
  onChange: (draft: MemoryGraphSettingsDraft) => void;
  settings: MemoryGraphSettingsDetails;
}) {
  const { t } = useLocale();

  // No status badge here — the live health already shows
  // on the workspace thumbnail. The settings panel only surfaces connection
  // fields + the degraded install hint below.
  const degraded = settings.memoryGraphStatus === "degraded" || settings.memoryGraphStatus === "needs-password";

  // The dependency hint carries a clickable link in the middle ({link}); the
  // translate() helper returns plain text, so split on the placeholder and
  // render the link as a real <a> between the two halves.
  const dependsHint = t("settings.memoryGraph.dependsHint" as MessageKey);
  const linkLabel = t("settings.memoryGraph.dependsLink" as MessageKey);
  const dependsParts = dependsHint.split("{link}");

  return <section aria-label={t("settings.groups.memory-graph.label" as MessageKey)} className="memory-graph-settings">
    <div className="settings-detail-header">
      <span className="eyebrow">{t("settings.memoryGraph.eyebrow" as MessageKey)}</span>
      <h3>{t("settings.memoryGraph.title" as MessageKey)}</h3>
      <p>{t("settings.memoryGraph.help" as MessageKey)}</p>
    </div>
    <div className="config-note memory-graph-depends-note">
      {dependsParts[0]}<a href="https://neo4j.com/docs/operations-manual/current/install/" rel="noreferrer" target="_blank">{linkLabel}</a>{dependsParts[1] ?? ""}
    </div>
    {/* The toggle mirrors the Reviewer Specialist switch
        and sits inside a bordered card (built-in-specialists) so the label and
        the switch read as one grouped control, not a far-apart pair. */}
    <div className="built-in-specialists memory-graph-toggle-card">
      <div className="built-in-specialist-row memory-graph-toggle-row">
        <span>
          <strong>{t("settings.memoryGraph.enableTitle" as MessageKey)}</strong>
        </span>
        <button
          aria-checked={draft.enabled}
          aria-label={t("settings.memoryGraph.enableTitle" as MessageKey)}
          className={draft.enabled ? "specialist-switch on" : "specialist-switch"}
          onClick={() => onChange({ ...draft, enabled: !draft.enabled })}
          role="switch"
          type="button"
        ><i /></button>
      </div>
    </div>
    <div className="memory-graph-connection">
      <label><span>{t("settings.memoryGraph.httpUri" as MessageKey)}</span><input value={draft.neo4jHttp} onChange={(event) => onChange({ ...draft, neo4jHttp: event.target.value })} placeholder="http://127.0.0.1:7474" /></label>
      <label><span>{t("settings.memoryGraph.user" as MessageKey)}</span><input value={draft.neo4jUser} onChange={(event) => onChange({ ...draft, neo4jUser: event.target.value })} placeholder="neo4j" /></label>
    </div>
    <div>
      <label><span>{t("settings.memoryGraph.password" as MessageKey)}</span><input
        type="password"
        value={draft.password}
        onChange={(event) => {
          onChange({ ...draft, password: event.target.value, ...(event.target.value ? { removePassword: false } : {}) });
        }}
        placeholder={settings.hasNeo4jPassword ? t("settings.memoryGraph.passwordReplace" as MessageKey) : t("settings.memoryGraph.passwordEnter" as MessageKey)}
      /></label>
      {settings.hasNeo4jPassword ? <button className={draft.removePassword ? "credential-remove pending" : "credential-remove"} type="button" onClick={() => onChange({ ...draft, removePassword: !draft.removePassword })}>
        {draft.removePassword ? t("settings.memoryGraph.passwordRemovePending" as MessageKey) : t("settings.memoryGraph.passwordRemove" as MessageKey)}
      </button> : null}
    </div>
    {degraded ? <div className="config-note">
      {t("settings.memoryGraph.degradedHint" as MessageKey)}
    </div> : null}
  </section>;
}

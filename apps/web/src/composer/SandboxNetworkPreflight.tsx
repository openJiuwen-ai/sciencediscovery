// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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

import type { ConnectorManifest } from "@sciencediscovery/schema";
import { useLocale } from "../i18n/index.js";

/** Hosts selected for the Session that sandboxed research code may need. */
export function selectedResearchHosts(
  connectors: readonly ConnectorManifest[],
  enabledIds: readonly string[],
): string[] {
  const enabled = new Set(enabledIds);
  return [...new Set(connectors
    .filter((connector) => enabled.has(connector.id))
    .flatMap((connector) => connector.networkHosts))].sort();
}

/** Explicit source requests need a warning even before the source is selected. */
export function requestsResearchNetwork(prompt: string, hosts: readonly string[]): boolean {
  return hosts.length > 0 || /\b(arxiv|biorxiv|medrxiv|pubmed|ncbi|europe\s*pmc|uniprot)\b/i.test(prompt);
}

export function SandboxNetworkPreflight({
  hosts,
  onConfigure,
  onContinue,
}: {
  hosts: readonly string[];
  onConfigure: () => void;
  onContinue: () => void;
}) {
  const { t } = useLocale();
  return <div className="composer-network-preflight" role="alert">
    <strong>{t("composer.networkPreflightTitle")}</strong>
    <span>{t("composer.networkPreflightDetail", { domains: hosts.length ? hosts.join(", ") : t("composer.networkPreflightResearchSources") })}</span>
    <div>
      <button onClick={onConfigure} type="button">{t("composer.networkPreflightConfigure")}</button>
      <button onClick={onContinue} type="button">{t("composer.networkPreflightContinue")}</button>
    </div>
  </div>;
}

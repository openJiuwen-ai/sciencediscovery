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

import { useEffect, useRef, useState } from "react";
import type { ConnectorId, ConnectorManifest } from "@sciencediscovery/schema";
import type { ReactNode } from "react";
type Translate=(key:"connectors.title"|"connectors.summary"|"connectors.providerPolicy"|"connectors.enabled"|"connectors.note"|"connectors.groupBuiltin"|"connectors.groupWeb"|"connectors.groupCustom",variables?:Record<string,string|number>)=>string;

export function connectorName(id: ConnectorId): string {
  return ({
    arxiv: "arXiv",
    biorxiv: "bioRxiv",
    chembl: "ChEMBL",
    clinvar: "ClinVar",
    ensembl: "Ensembl",
    "europe-pmc": "Europe PMC",
    geo: "GEO",
    medrxiv: "medRxiv",
    pdb: "PDB",
    pubmed: "PubMed",
    reactome: "Reactome",
    uniprot: "UniProt",
    web: "Web",
  })[id] ?? id;
}

export function ConnectorPicker({
  t, icons,
  connectors,
  defaultOpen = false,
  disabled = false,
  enabledIds,
  onToggle,
}: {
  t: Translate; icons:{database:ReactNode;external:ReactNode};
  connectors: ConnectorManifest[];
  defaultOpen?: boolean;
  disabled?: boolean;
  enabledIds: readonly string[];
  onToggle: (connectorId: ConnectorId) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const enabledCount = connectors.filter((connector) => enabledIds.includes(connector.id)).length;
  const summary = `${t("connectors.title")}: ${t("connectors.summary", { enabled: enabledCount, total: connectors.length })}`;
  const builtinConnectors = connectors.filter((connector) => !connector.id.startsWith("custom-") && connector.id !== "web");
  const customConnectors = connectors.filter((connector) => connector.id.startsWith("custom-"));
  const webConnectors = connectors.filter((connector) => connector.id === "web");
  const groups: Array<{ label: string; items: ConnectorManifest[] }> = [
    { label: "connectors.groupBuiltin", items: builtinConnectors },
    ...(webConnectors.length ? [{ label: "connectors.groupWeb", items: webConnectors }] : []),
    ...(customConnectors.length ? [{ label: "connectors.groupCustom", items: customConnectors }] : []),
  ];
  return <div className="connector-picker" ref={rootRef}>
    <button
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={summary}
      className={enabledCount ? "connector-picker-trigger has-enabled" : "connector-picker-trigger"}
      onClick={() => setOpen((current) => !current)}
      title={summary}
      type="button"
    >
      {icons.database}
      <span className="connector-picker-count">{enabledCount}</span>
    </button>
    {open ? <div aria-label={t("connectors.title")} className="connector-picker-popover" role="dialog">
      <div className="connector-picker-heading"><strong>{t("connectors.title")}</strong><span>{t("connectors.enabled", { enabled: enabledCount, total: connectors.length })}</span></div>
      {groups.map((group) => group.items.length ? <div key={group.label} className="connector-picker-group">
        <small className="connector-picker-group-label">{t(group.label as "connectors.groupBuiltin")}</small>
        <ul>
          {group.items.map((connector) => {
            const name = connector.displayName ?? connectorName(connector.id);
            const policyLabel = t("connectors.providerPolicy", { name });
            return <li key={connector.id}>
              <label>
                <input
                  checked={enabledIds.includes(connector.id)}
                  disabled={disabled}
                  onChange={() => onToggle(connector.id)}
                  type="checkbox"
                />
                <span><strong>{name}</strong><small>{connector.publisher}</small></span>
              </label>
              {connector.termsUrl ? <a
                aria-label={policyLabel}
                href={connector.termsUrl}
                rel="noreferrer"
                target="_blank"
                title={policyLabel}
              >{icons.external}</a> : null}
            </li>;
          })}
        </ul>
      </div> : null)}
      <p className="connector-picker-note">{t("connectors.note")}</p>
    </div> : null}
  </div>;
}

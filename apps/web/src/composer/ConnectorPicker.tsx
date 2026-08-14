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
import type { ConnectorId, ConnectorManifest } from "@science-agent/schema";
import { DatabaseIcon, ExternalIcon } from "../icons.js";
import { useLocale } from "../i18n/index.js";

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
  })[id] ?? id;
}

export function ConnectorPicker({
  connectors,
  defaultOpen = false,
  disabled = false,
  enabledIds,
  onToggle,
}: {
  connectors: ConnectorManifest[];
  defaultOpen?: boolean;
  disabled?: boolean;
  enabledIds: readonly string[];
  onToggle: (connectorId: ConnectorId) => void;
}) {
  const { t } = useLocale();
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
      <DatabaseIcon size={15} />
      <span className="connector-picker-count">{enabledCount}</span>
    </button>
    {open ? <div aria-label={t("connectors.title")} className="connector-picker-popover" role="dialog">
      <div className="connector-picker-heading"><strong>{t("connectors.title")}</strong><span>{t("connectors.enabled", { enabled: enabledCount, total: connectors.length })}</span></div>
      <ul>
        {connectors.map((connector) => {
          const name = connectorName(connector.id);
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
            <a
              aria-label={`${name} provider policy`}
              href={connector.termsUrl}
              rel="noreferrer"
              target="_blank"
              title={`${name} provider policy`}
            ><ExternalIcon size={13} /></a>
          </li>;
        })}
      </ul>
      <p className="connector-picker-note">{t("connectors.note")}</p>
    </div> : null}
  </div>;
}

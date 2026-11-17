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

import { DownloadButton } from "./DownloadButton.js";
import { SOURCE_LABELS } from "../labels.js";

import type { JSX } from "react";
import type { Asset } from "../catalog/types.js";
import type { Language } from "../i18n.js";

interface AssetCardProps {
  asset: Asset;
  basePath: string;
  downloadLabel: string;
  language: Language;
  onOpen: () => void;
}

function formatSize(bytes: number | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AssetCard({ asset, basePath, downloadLabel, language, onOpen }: AssetCardProps): JSX.Element {
  const source = SOURCE_LABELS[asset.source];
  return (
    <article className="card" onClick={onOpen}>
      <header className="card-head">
        <h3 className="card-title">{asset.name}</h3>
        <span className="badges">
          {asset.kind === "team-skill" ? <span className="badge badge-team">{language === "zh" ? "团队" : "Team"}</span> : null}
          {source ? <span className="badge">{source[language]}</span> : null}
        </span>
      </header>
      <p className="card-description">{asset.description}</p>
      {asset.tags.length ? (
        <p className="tags">
          {asset.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}
        </p>
      ) : null}
      <footer className="card-foot">
        <span className="muted">
          {language === "zh" ? "版本" : "Version"} {asset.version ?? "—"}
          {asset.download.size ? ` · ${formatSize(asset.download.size)}` : ""}
        </span>
        <DownloadButton basePath={basePath} label={downloadLabel} url={asset.download.url} />
      </footer>
    </article>
  );
}

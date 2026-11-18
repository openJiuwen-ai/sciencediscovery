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
import { ConnectorIcon, SessionIcon, SpecialistIcon } from "./icons.js";
import { formatSize } from "../format.js";
import { counted } from "../i18n.js";
import { SOURCE_LABELS } from "../labels.js";

import type { JSX } from "react";
import type { Asset } from "../catalog/types.js";
import type { CopyKey, Language } from "../i18n.js";

interface AssetCardProps {
  asset: Asset;
  basePath: string;
  copy: (key: CopyKey) => string;
  language: Language;
  onOpen: () => void;
}

/** The tint of the leading tile: a skill takes its domain's colour, the rest their kind. */
const DOMAIN_TONES: Record<string, string> = {
  astronomy: "indigo",
  biology: "blue",
  chemistry_and_materials: "violet",
  earth_sciences: "green",
  economics: "teal",
  electromagnetics: "amber",
  energy: "lime",
  fluid_dynamics: "cyan",
  machine_learning: "indigo",
  mathematics: "slate",
  medical_and_pharmacy: "rose",
  quantum: "purple",
  research_tools: "amber",
};

function tileTone(asset: Asset): string {
  if (asset.kind === "skill") return DOMAIN_TONES[asset.category.domain] ?? "blue";
  if (asset.kind === "team-skill") return "purple";
  if (asset.kind === "specialist") return "orange";
  if (asset.kind === "connector") return "cyan";
  return "green";
}

/** The signals each kind actually carries; no invented popularity counters. */
function statsOf(asset: Asset, copy: (key: CopyKey) => string, language: Language): string[] {
  const size = formatSize(asset.download.size);
  // A zero count says "we have nothing to report", so it is left out rather than
  // printed beside the assets that do carry something.
  const count = (value: number, key: CopyKey): string | null => value > 0 ? counted(value, copy(key), language) : null;
  if (asset.kind === "session-package") {
    const score = asset.benchmark.score === undefined ? null : `${copy("score")} ${asset.benchmark.score}`;
    return [score, size].filter((part): part is string => Boolean(part));
  }
  if (asset.kind === "specialist") {
    return [
      count(asset.skills.length, "boundSkills"),
      count(asset.connectors.length, "boundConnectors"),
    ].filter((part): part is string => Boolean(part));
  }
  if (asset.kind === "connector") {
    return [count(asset.toolCount, "toolCount"), size].filter((part): part is string => Boolean(part));
  }
  if (asset.kind === "team-skill") {
    return [count((asset.members ?? []).length, "members"), size].filter((part): part is string => Boolean(part));
  }
  return [count(asset.resources.length, "files"), size].filter((part): part is string => Boolean(part));
}

/** One line under the name: where the asset came from, as the reference card shows an author. */
function metaOf(asset: Asset, language: Language): string | null {
  if (asset.kind === "session-package") return asset.benchmark.name;
  if (asset.kind === "connector") return asset.publisher;
  const source = SOURCE_LABELS[asset.source];
  return source ? source[language] : null;
}

export function AssetTile({ asset, large = false }: { asset: Asset; large?: boolean }): JSX.Element {
  const size = large ? 26 : 22;
  const glyph = asset.kind === "specialist"
    ? <SpecialistIcon size={size} />
    : asset.kind === "connector"
      ? <ConnectorIcon size={size} />
      : asset.kind === "session-package" ? <SessionIcon size={size} /> : null;
  return (
    <span aria-hidden="true" className={`tile tile-${tileTone(asset)}${large ? " tile-large" : ""}`}>
      {glyph ?? <b>{asset.name.slice(0, 1).toUpperCase()}</b>}
    </span>
  );
}

export function AssetCard({ asset, basePath, copy, language, onOpen }: AssetCardProps): JSX.Element {
  const version = asset.kind === "session-package" ? null : asset.version;
  const meta = metaOf(asset, language);
  const stats = statsOf(asset, copy, language);
  return (
    <article className="card" onClick={onOpen}>
      <header className="card-head">
        <AssetTile asset={asset} />
        <div className="card-heading">
          <button
            className="card-title"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            type="button"
          >
            {asset.name}
          </button>
          {meta ? <p className="card-meta"><span>{meta}</span></p> : null}
        </div>
        {version ? <span className="version">v{version}</span> : null}
      </header>
      <p className="card-description">{asset.description}</p>
      {asset.tags.length ? (
        <p className="tags">
          {asset.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}
        </p>
      ) : null}
      <footer className="card-foot">
        <span className="card-stats">
          {stats.map((stat, index) => (
            <span className="stat" key={stat}>
              {index ? <span aria-hidden="true" className="dot">·</span> : null}
              {stat}
            </span>
          ))}
        </span>
        <DownloadButton basePath={basePath} label={copy("download")} url={asset.download.url} variant="ghost" />
      </footer>
    </article>
  );
}

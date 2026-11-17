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

import { DownloadButton } from "../components/DownloadButton.js";
import { MarkdownFile } from "../components/Markdown.js";
import { SOURCE_LABELS } from "../labels.js";

import type { JSX } from "react";
import type { Asset, Catalog, ConnectorAsset, SkillAsset, SpecialistAsset } from "../catalog/types.js";
import type { CopyKey, Language } from "../i18n.js";
import type { Tab } from "../router.js";

export interface DetailProps {
  asset: Asset;
  basePath: string;
  catalog: Catalog;
  copy: (key: CopyKey) => string;
  language: Language;
  onNavigate: (tab: Tab, id: string) => void;
}

function AssetLink({ catalog, id, onNavigate }: { catalog: Catalog; id: string; onNavigate: (tab: Tab, id: string) => void }): JSX.Element {
  const target = catalog.assets.find((asset) => asset.id === id);
  const tab: Tab | null = target?.kind === "connector"
    ? "connectors"
    : target?.kind === "specialist" ? "specialists" : target ? "skills" : null;
  if (!target || !tab) return <span className="muted">{id}</span>;
  return <button className="link" onClick={() => onNavigate(tab, id)} type="button">{target.name}</button>;
}

function Links({ catalog, ids, label, onNavigate }: {
  catalog: Catalog;
  ids: string[];
  label: string;
  onNavigate: (tab: Tab, id: string) => void;
}): JSX.Element | null {
  if (!ids.length) return null;
  return (
    <section>
      <h3>{label}</h3>
      <ul className="link-list">
        {ids.map((id) => <li key={id}><AssetLink catalog={catalog} id={id} onNavigate={onNavigate} /></li>)}
      </ul>
    </section>
  );
}

export function SkillDetail({ asset, basePath, catalog, copy, onNavigate }: DetailProps): JSX.Element {
  const skill = asset as SkillAsset;
  const members = (skill.members ?? []).flatMap((id) => {
    const specialist = catalog.assets.find((candidate) => candidate.id === id && candidate.kind === "specialist");
    return specialist?.kind === "specialist" ? [specialist] : [];
  });
  return (
    <article className="detail">
      <div className="detail-head">
        <div>
          <h1>{skill.name}</h1>
          <p className="muted">
            {copy("version")} {skill.version ?? "—"}
            {skill.author ? ` · ${skill.author}` : ""}
            {skill.download.size ? ` · ${(skill.download.size / 1024).toFixed(1)} KB` : ""}
          </p>
        </div>
        <DownloadButton basePath={basePath} label={copy("download")} url={skill.download.url} />
      </div>

      {members.length ? (
        <section className="members">
          <h2>{copy("members")}</h2>
          <ul className="member-list">
            {members.map((specialist) => (
              <li key={specialist.id}>
                <button className="link" onClick={() => onNavigate("specialists", specialist.id)} type="button">
                  {specialist.name}
                </button>
                {specialist.skills.map((skillId) => (
                  <span className="badge member-skill" key={skillId}>{copy("boundSkills")} · {skillId}</span>
                ))}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <MarkdownFile basePath={basePath} url={skill.readme} />

      {skill.resources.length ? (
        <section>
          <h2>{copy("resources")}</h2>
          <ul className="resources">
            {skill.resources.map((resource) => (
              <li key={resource.path}>
                <code>{resource.path}</code>
                <span className="muted"> {resource.size} B</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Links catalog={catalog} ids={skill.related?.specialists ?? []} label={copy("specialists")} onNavigate={onNavigate} />
    </article>
  );
}

export function SpecialistDetail({ asset, basePath, catalog, copy, language, onNavigate }: DetailProps): JSX.Element {
  const specialist = asset as SpecialistAsset;
  return (
    <article className="detail">
      <div className="detail-head">
        <div>
          <h1>{specialist.name}</h1>
          <p className="muted">{SOURCE_LABELS[specialist.source]?.[language] ?? specialist.source}</p>
        </div>
        <div className="actions">
          <DownloadButton basePath={basePath} label={copy("downloadJson")} url={specialist.download.url} />
          <DownloadButton basePath={basePath} label={copy("downloadMarkdown")} url={specialist.download.text} />
        </div>
      </div>
      <p>{specialist.description}</p>
      <details className="prompt">
        <summary>{copy("instructions")}</summary>
        <pre>{specialist.instructions}</pre>
      </details>
      {specialist.runtime ? (
        <section>
          <h3>Runtime</h3>
          <pre>{JSON.stringify(specialist.runtime, null, 2)}</pre>
        </section>
      ) : null}
      <Links catalog={catalog} ids={specialist.skills} label={copy("boundSkills")} onNavigate={onNavigate} />
      <Links catalog={catalog} ids={specialist.connectors} label={copy("boundConnectors")} onNavigate={onNavigate} />
    </article>
  );
}

export function ConnectorDetail({ asset, basePath, copy }: DetailProps): JSX.Element {
  const connector = asset as ConnectorAsset;
  return (
    <article className="detail">
      <div className="detail-head">
        <div>
          <h1>{connector.name}</h1>
          <p className="muted">
            {copy("version")} {connector.version ?? "—"} · {connector.publisher} · {connector.toolCount} {copy("toolCount")}
          </p>
        </div>
        <DownloadButton basePath={basePath} label={copy("downloadJson")} url={connector.download.url} />
      </div>
      <p>{connector.description}</p>
      <section>
        <h2>{copy("config")}</h2>
        <pre>{JSON.stringify(connector.config, null, 2)}</pre>
      </section>
      <section>
        <h2>{copy("governance")}</h2>
        <dl className="governance">
          {Object.entries(connector.governance).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{Array.isArray(value) ? value.join(", ") : String(value)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <h2>{copy("tools")}</h2>
        <ul className="tools">
          {connector.tools.map((tool) => (
            <li key={tool.id}>
              <code>{tool.id}</code>
              <span> {tool.displayName}</span>
              <p className="muted">{tool.description}</p>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}

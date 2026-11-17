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
import {
  DOMAIN_LABELS,
  HARDWARE_LABELS,
  SKILL_TYPE_LABELS,
  SOURCE_LABELS,
  SUBDOMAIN_LABELS,
} from "../labels.js";

import type { JSX } from "react";
import type { Asset, Catalog, ConnectorAsset, SessionAsset, SkillAsset, SpecialistAsset } from "../catalog/types.js";
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

export function SkillDetail({ asset, basePath, catalog, copy, language, onNavigate }: DetailProps): JSX.Element {
  const skill = asset as SkillAsset;
  const members = (skill.members ?? []).flatMap((id) => {
    const specialist = catalog.assets.find((candidate) => candidate.id === id && candidate.kind === "specialist");
    return specialist?.kind === "specialist" ? [specialist] : [];
  });
  const domain = DOMAIN_LABELS[skill.category.domain]?.[language] ?? skill.category.domain;
  const subdomain = SUBDOMAIN_LABELS[skill.category.subdomain]?.[language] ?? skill.category.subdomain;
  const type = skill.type ? SKILL_TYPE_LABELS[skill.type]?.[language] ?? skill.type : null;
  const hardware = skill.hardware ? HARDWARE_LABELS[skill.hardware]?.[language] ?? skill.hardware : null;
  const snapshot = skill.source === "mindscience" ? catalog.sources.externalSkills : undefined;
  return (
    <article className="detail">
      <div className="detail-head">
        <div>
          <h1>{skill.name}</h1>
          <p className="muted">
            {domain} · {subdomain}
            {` · ${copy("version")} ${skill.version ?? "—"}`}
            {skill.author ? ` · ${skill.author}` : ""}
            {skill.download.size ? ` · ${(skill.download.size / 1024).toFixed(1)} KB` : ""}
          </p>
          {type || hardware ? (
            <p className="badges detail-badges">
              {type ? <span className="badge">{type}</span> : null}
              {hardware ? <span className="badge">{hardware}</span> : null}
            </p>
          ) : null}
          {snapshot ? (
            <p className="muted">
              {copy("snapshot")} {snapshot.ref}@{snapshot.commit.slice(0, 8)} ·{" "}
              <a
                href={`https://gitcode.com/${snapshot.repo}/blob/${snapshot.ref}/MindScienceSkills/${skill.id}/SKILL.md`}
                rel="noreferrer"
                target="_blank"
              >
                {copy("upstream")}
              </a>
            </p>
          ) : null}
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

function formatDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined) return null;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function SessionDetail({ asset, basePath, catalog, copy, language, onNavigate }: DetailProps): JSX.Element {
  const session = asset as SessionAsset;
  const { benchmark, contents, run } = session;
  const meta = [
    `${copy("benchmark")} ${benchmark.name}`,
    `${copy("caseId")} ${benchmark.caseId}`,
    `${copy("score")} ${benchmark.score ?? "—"}`,
    benchmark.runAt ? `${copy("runAt")} ${benchmark.runAt}` : null,
    benchmark.dataset ? `Dataset ${benchmark.dataset}` : null,
    benchmark.commit ? `Commit ${benchmark.commit}` : null,
  ].filter((part): part is string => Boolean(part)).join(" · ");
  const duration = formatDuration(run?.durationMs);
  const runMeta = [
    run?.model ? `${copy("model")} ${run.model}` : null,
    duration ? `${copy("duration")} ${duration}` : null,
    run?.tokens !== undefined ? `${copy("tokens")} ${run.tokens.toLocaleString(language === "zh" ? "zh-CN" : "en-US")}` : null,
    run?.productVersion ? `${copy("version")} ${run.productVersion}` : null,
    session.download.size ? `${(session.download.size / 1024 / 1024).toFixed(1)} MB` : null,
  ].filter((part): part is string => Boolean(part)).join(" · ");
  const stats: [string, number | string][] = [
    [copy("messages"), contents.messages],
    [copy("artifacts"), contents.artifacts],
    [copy("files"), contents.files],
    [copy("executions"), contents.executions],
    [copy("memoryNodes"), contents.memoryNodes],
    [copy("trajectory"), copy(contents.trajectory === "complete" ? "trajectoryComplete" : "trajectorySummary")],
  ];
  return (
    <article className="detail">
      <div className="detail-head">
        <div>
          <h1>{session.name}</h1>
          <p className="muted">{meta}</p>
          {runMeta ? <p className="muted">{runMeta}</p> : null}
        </div>
        <DownloadButton basePath={basePath} label={copy("downloadPackage")} url={session.download.url} />
      </div>
      <p>{session.description}</p>
      <section aria-label={copy("contents")} className="session-contents">
        {stats.map(([label, value]) => (
          <div className="session-stat" key={label}>
            <span className="muted">{label}</span>
            <b>{value}</b>
          </div>
        ))}
      </section>
      <MarkdownFile basePath={basePath} url={session.readme} />
      <Links catalog={catalog} ids={session.related?.specialists ?? []} label={copy("specialists")} onNavigate={onNavigate} />
      <Links catalog={catalog} ids={session.related?.skills ?? []} label={copy("skills")} onNavigate={onNavigate} />
      <Links catalog={catalog} ids={session.related?.connectors ?? []} label={copy("connectors")} onNavigate={onNavigate} />
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

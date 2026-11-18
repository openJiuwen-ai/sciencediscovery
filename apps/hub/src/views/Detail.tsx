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

import { useRef, useState } from "react";

import { AssetTile } from "../components/AssetCard.js";
import { DownloadButton } from "../components/DownloadButton.js";
import { FileIcon } from "../components/icons.js";
import { MarkdownFile } from "../components/Markdown.js";
import { assetUrl } from "../catalog/load.js";
import { formatSize } from "../format.js";
import {
  DOMAIN_LABELS,
  HARDWARE_LABELS,
  SKILL_TYPE_LABELS,
  SOURCE_LABELS,
  SUBDOMAIN_LABELS,
} from "../labels.js";
import { counted } from "../i18n.js";

import type { JSX, KeyboardEvent, ReactNode } from "react";
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

/** Shared heading: kind tile, title block and the primary action. */
function DetailHeader({ actions, asset, children }: {
  actions?: JSX.Element;
  asset: Asset;
  children: ReactNode;
}): JSX.Element {
  return (
    <header className="detail-hero">
      <AssetTile asset={asset} large />
      <div className="detail-heading">{children}</div>
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}

type InfoRow = [label: string, value: ReactNode];

/** The right-hand spec sheet. Callers pass only the fields the asset carries. */
function InfoCard({ children, copy, rows }: {
  children?: ReactNode;
  copy: (key: CopyKey) => string;
  rows: (InfoRow | null)[];
}): JSX.Element {
  return (
    <aside className="info-card">
      <h2>{copy("basicInfo")}</h2>
      <dl className="info-list">
        {rows.filter((row): row is InfoRow => row !== null).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </aside>
  );
}

interface FileRow {
  name: string;
  size?: number;
  /** Present when the file itself is served, so it can be opened in place. */
  url?: string;
}

/** The `Files` tab: exactly the files this asset ships, with the sizes we know. */
function FileList({ basePath, copy, rows }: { basePath: string; copy: (key: CopyKey) => string; rows: FileRow[] }): JSX.Element {
  return (
    <ul className="file-list">
      {rows.map((row) => (
        <li className="file-row" key={row.name}>
          <FileIcon size={18} />
          <code className="file-name">{row.name}</code>
          <span className="file-size">{formatSize(row.size)}</span>
          {row.url ? (
            <a className="file-view" href={assetUrl(basePath, row.url)} rel="noreferrer" target="_blank">
              {copy("view")}
            </a>
          ) : <span />}
        </li>
      ))}
    </ul>
  );
}

type ReaderTab = "files" | "readme";

/** Readme and Files share one panel; the tab choice resets when the asset changes. */
function Reader({ copy, fileCount, files, readme }: {
  copy: (key: CopyKey) => string;
  fileCount: number;
  files: JSX.Element;
  readme: JSX.Element;
}): JSX.Element {
  const [tab, setTab] = useState<ReaderTab>("readme");
  const buttons = useRef<Partial<Record<ReaderTab, HTMLButtonElement | null>>>({});
  const order: ReaderTab[] = ["readme", "files"];
  function select(next: ReaderTab): void {
    setTab(next);
    buttons.current[next]?.focus();
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    select(tab === "readme" ? "files" : "readme");
  }
  const labels: Record<ReaderTab, ReactNode> = {
    files: <>{copy("files")}<span className="tab-count">{fileCount}</span></>,
    readme: copy("readme"),
  };
  return (
    <div className="reader">
      <div className="tabs" onKeyDown={onKeyDown} role="tablist">
        {order.map((id) => (
          <button
            aria-selected={tab === id}
            className="tab"
            key={id}
            onClick={() => setTab(id)}
            ref={(node) => { buttons.current[id] = node; }}
            role="tab"
            tabIndex={tab === id ? 0 : -1}
            type="button"
          >
            {labels[id]}
          </button>
        ))}
      </div>
      <div className="tab-panel" role="tabpanel">{tab === "readme" ? readme : files}</div>
    </div>
  );
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
  // SKILL.md is served next to the archive; the resources only exist inside it, so
  // they are listed with their size rather than offered as broken links.
  const files: FileRow[] = [
    { name: skill.readme, url: skill.readme },
    ...skill.resources.map((resource) => ({ name: resource.path, size: resource.size })),
  ];
  return (
    <article className="detail">
      <DetailHeader
        actions={<DownloadButton basePath={basePath} label={copy("download")} url={skill.download.url} />}
        asset={skill}
      >
        <h1>{skill.name}</h1>
        <p className="detail-sub">
          <span>{domain} · {subdomain}</span>
          {skill.version ? <span className="version">v{skill.version}</span> : null}
        </p>
      </DetailHeader>

      <div className="detail-body">
        <div className="detail-main">
          <p className="detail-description">{skill.description}</p>
          <Reader
            copy={copy}
            fileCount={files.length}
            files={(
              <>
                <FileList basePath={basePath} copy={copy} rows={files} />
                <p className="archive-note">{copy("archiveNote")}</p>
              </>
            )}
            key={skill.id}
            readme={<MarkdownFile basePath={basePath} url={skill.readme} />}
          />
        </div>
        <InfoCard
          copy={copy}
          rows={[
            [copy("id"), <code key="id">{skill.id}</code>],
            skill.version ? [copy("version"), skill.version] : null,
            [copy("category"), `${domain} · ${subdomain}`],
            type ? [copy("type"), type] : null,
            hardware ? [copy("hardware"), hardware] : null,
            skill.author ? [copy("author"), skill.author] : null,
            [copy("source"), SOURCE_LABELS[skill.source]?.[language] ?? skill.source],
            files.length > 1 ? [copy("files"), counted(files.length, copy("files"), language)] : null,
            [copy("size"), formatSize(skill.download.size) || "—"],
            snapshot ? [
              copy("snapshot"),
              <span key="snapshot">
                {snapshot.ref}@{snapshot.commit.slice(0, 8)} ·{" "}
                <a
                  href={`https://gitcode.com/${snapshot.repo}/blob/${snapshot.ref}/MindScienceSkills/${skill.id}/SKILL.md`}
                  rel="noreferrer"
                  target="_blank"
                >
                  {copy("upstream")}
                </a>
              </span>,
            ] : null,
          ]}
        >
          {members.length ? (
            <div className="info-members">
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
            </div>
          ) : null}
        </InfoCard>
      </div>

      <div className="detail-related">
        <Links catalog={catalog} ids={skill.related?.specialists ?? []} label={copy("specialists")} onNavigate={onNavigate} />
      </div>
    </article>
  );
}

export function SpecialistDetail({ asset, basePath, catalog, copy, language, onNavigate }: DetailProps): JSX.Element {
  const specialist = asset as SpecialistAsset;
  const files: FileRow[] = [
    { name: specialist.download.url.split("/").pop() ?? specialist.id, size: specialist.download.size, url: specialist.download.url },
    { name: specialist.download.text.split("/").pop() ?? specialist.id, url: specialist.download.text },
  ];
  return (
    <article className="detail">
      <DetailHeader
        actions={(
          <>
            <DownloadButton basePath={basePath} label={copy("downloadJson")} url={specialist.download.url} />
            <DownloadButton basePath={basePath} label={copy("downloadMarkdown")} url={specialist.download.text} variant="ghost" />
          </>
        )}
        asset={specialist}
      >
        <h1>{specialist.name}</h1>
        <p className="detail-sub">
          <span>{SOURCE_LABELS[specialist.source]?.[language] ?? specialist.source}</span>
          {specialist.version ? <span className="version">v{specialist.version}</span> : null}
        </p>
      </DetailHeader>

      <div className="detail-body">
        <div className="detail-main">
          <p className="detail-description">{specialist.description}</p>
          <Reader
            copy={copy}
            fileCount={files.length}
            files={<FileList basePath={basePath} copy={copy} rows={files} />}
            key={specialist.id}
            readme={(
              <>
                <h3 className="reader-heading">{copy("instructions")}</h3>
                <pre>{specialist.instructions}</pre>
                {specialist.runtime ? (
                  <>
                    <h3 className="reader-heading">{copy("runtime")}</h3>
                    <pre>{JSON.stringify(specialist.runtime, null, 2)}</pre>
                  </>
                ) : null}
              </>
            )}
          />
        </div>
        <InfoCard
          copy={copy}
          rows={[
            [copy("id"), <code key="id">{specialist.id}</code>],
            specialist.version ? [copy("version"), specialist.version] : null,
            [copy("source"), SOURCE_LABELS[specialist.source]?.[language] ?? specialist.source],
            specialist.skills.length ? [copy("boundSkills"), String(specialist.skills.length)] : null,
            specialist.connectors.length ? [copy("boundConnectors"), String(specialist.connectors.length)] : null,
            [copy("size"), formatSize(specialist.download.size) || "—"],
          ]}
        />
      </div>

      <div className="detail-related">
        <Links catalog={catalog} ids={specialist.skills} label={copy("boundSkills")} onNavigate={onNavigate} />
        <Links catalog={catalog} ids={specialist.connectors} label={copy("boundConnectors")} onNavigate={onNavigate} />
      </div>
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
      <DetailHeader
        actions={<DownloadButton basePath={basePath} label={copy("downloadPackage")} url={session.download.url} />}
        asset={session}
      >
        <h1>{session.name}</h1>
        <p className="muted">{meta}</p>
        {runMeta ? <p className="muted">{runMeta}</p> : null}
      </DetailHeader>
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
      <DetailHeader
        actions={<DownloadButton basePath={basePath} label={copy("downloadJson")} url={connector.download.url} />}
        asset={connector}
      >
        <h1>{connector.name}</h1>
        <p className="muted">
          {copy("version")} {connector.version ?? "—"} · {connector.publisher} · {connector.toolCount} {copy("toolCount")}
        </p>
      </DetailHeader>
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

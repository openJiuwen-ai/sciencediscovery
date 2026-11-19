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

import { AssetTile } from "../components/AssetCard.js";
import { DownloadButton } from "../components/DownloadButton.js";
import { FileIcon } from "../components/icons.js";
import { Markdown, MarkdownFile } from "../components/Markdown.js";
import { assetUrl, fetchTextAsset } from "../catalog/load.js";
import { formatSize, formatTimestamp } from "../format.js";
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
  /** How the served file should be shown; `null` when it has no text preview. */
  preview: "markdown" | "text" | null;
  size?: number;
  url?: string;
}

const TEXT_EXTENSIONS = new Set([
  "cfg", "cjs", "css", "csv", "ini", "js", "json", "jsx", "mjs", "patch", "py",
  "r", "sh", "sql", "toml", "ts", "tsv", "tsx", "txt", "xml", "yaml", "yml",
]);

function previewOf(path: string): "markdown" | "text" | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "md") return "markdown";
  return TEXT_EXTENSIONS.has(extension) ? "text" : null;
}

function basename(url: string): string {
  return url.split("/").pop() ?? url;
}

/** Split at the last dot so a clipped name still shows its extension. */
function splitExtension(name: string): [stem: string, extension: string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/** One file's served text, rendered as markdown or as a source listing. */
function FilePreview({ basePath, copy, row }: { basePath: string; copy: (key: CopyKey) => string; row: FileRow }): JSX.Element {
  const [state, setState] = useState<{ status: "error" | "loading" | "ready"; text: string }>({ status: "loading", text: "" });
  useEffect(() => {
    if (!row.url || !row.preview) return;
    let cancelled = false;
    setState({ status: "loading", text: "" });
    fetchTextAsset(basePath, row.url)
      .then((text) => {
        if (!cancelled) setState({ status: "ready", text });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", text: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [basePath, row.preview, row.url]);

  if (!row.preview || state.status === "error") return <p className="muted">{copy("previewUnavailable")}</p>;
  if (state.status === "loading") return <p className="muted">{copy("loading")}</p>;
  return row.preview === "markdown" ? <Markdown source={state.text} /> : <pre>{state.text}</pre>;
}

/** The `Files` tab: the file list on the left, the selected file's text beside it. */
function FileBrowser({ basePath, copy, rows }: { basePath: string; copy: (key: CopyKey) => string; rows: FileRow[] }): JSX.Element {
  const [selected, setSelected] = useState(rows[0]?.name ?? "");
  const row = rows.find((entry) => entry.name === selected) ?? rows[0];
  return (
    <div className="browser">
      <ul className="file-list">
        {rows.map((entry) => {
          const [stem, extension] = splitExtension(basename(entry.name));
          return (
            <li key={entry.name}>
              <button
                aria-current={entry.name === row?.name ? "true" : undefined}
                className="file-item"
                onClick={() => setSelected(entry.name)}
                title={entry.name}
                type="button"
              >
                <FileIcon size={16} />
                <span className="file-text">
                  <span className="file-name">
                    <span className="file-stem">{stem}</span>
                    {extension ? <span className="file-ext">{extension}</span> : null}
                  </span>
                  {entry.name.includes("/") ? <span className="file-dir">{entry.name.slice(0, entry.name.lastIndexOf("/"))}</span> : null}
                </span>
                <span className="file-size">{formatSize(entry.size)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="file-preview">
        {row ? <FilePreview basePath={basePath} copy={copy} key={row.name} row={row} /> : null}
      </div>
    </div>
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
  // Every resource is served beside the skill, so the Files tab can preview it
  // without unpacking the archive.
  const files: FileRow[] = [
    { name: "SKILL.md", preview: "markdown", url: skill.readme },
    ...skill.resources.map((resource) => ({
      name: resource.path,
      preview: previewOf(resource.path),
      size: resource.size,
      url: resource.url,
    })),
  ];
  return (
    <article className="detail">
      <DetailHeader
        actions={<DownloadButton assetId={skill.id} basePath={basePath} label={copy("download")} url={skill.download.url} version={skill.version} />}
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
                <FileBrowser basePath={basePath} copy={copy} rows={files} />
                <p className="archive-note">{copy("archiveNote")}</p>
              </>
            )}
            key={skill.id}
            readme={<MarkdownFile basePath={basePath} fallback={copy("readmeUnavailable")} url={skill.readme} />}
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
    { name: basename(specialist.download.url), preview: "text", size: specialist.download.size, url: specialist.download.url },
    { name: basename(specialist.download.text), preview: "markdown", url: specialist.download.text },
  ];
  return (
    <article className="detail">
      <DetailHeader
        actions={(
          <>
            <DownloadButton assetId={specialist.id} basePath={basePath} label={copy("downloadJson")} suggestedName={`${specialist.id.split("/").pop()}.zip`} url={specialist.download.url} version={specialist.version} />
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
            files={<FileBrowser basePath={basePath} copy={copy} rows={files} />}
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
    benchmark.runAt ? `${copy("runAt")} ${formatTimestamp(benchmark.runAt, language)}` : null,
    benchmark.dataset ? `Dataset ${benchmark.dataset}` : null,
    benchmark.commit ? `Commit ${benchmark.commit}` : null,
  ].filter((part): part is string => Boolean(part)).join(" · ");
  const duration = formatDuration(run?.durationMs);
  const runMeta = [
    // "local-smoke" is a placeholder the export used for a local test; a
    // session's real model comes from the sidecar, so an obvious placeholder
    // is left out rather than presented as if it were the model.
    run?.model && !/^local(-|$)/iu.test(run.model) ? `${copy("model")} ${run.model}` : null,
    duration ? `${copy("duration")} ${duration}` : null,
    run?.tokens !== undefined ? `${copy("tokens")} ${run.tokens.toLocaleString(language === "zh" ? "zh-CN" : "en-US")}` : null,
    run?.productVersion && run.productVersion !== "unknown"
      ? `${copy("version")} ${run.productVersion}`
      : null,
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
        actions={<DownloadButton assetId={session.id} basePath={basePath} label={copy("downloadPackage")} suggestedName={`${session.id.split("/").pop()}.sdresearch`} url={session.download.url} version={session.version} />}
        asset={session}
      >
        <h1>{session.name}</h1>
        {meta ? <p className="muted">{meta}</p> : null}
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
      <MarkdownFile basePath={basePath} fallback={copy("readmeUnavailable")} url={session.readme} />
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
        actions={<DownloadButton assetId={connector.id} basePath={basePath} label={copy("downloadJson")} suggestedName={`${connector.id.split("/").pop()}.zip`} url={connector.download.url} version={connector.version} />}
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

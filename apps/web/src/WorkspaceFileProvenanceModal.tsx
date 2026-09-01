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

import { Fragment, useState, type ReactNode } from "react";

import type {
  WorkspaceFile,
  WorkspaceFileOrigin,
  WorkspaceFileProvenance,
  WorkspaceFileRevision,
} from "@sciencediscovery/schema";

import { DetailModal } from "./DetailModal.js";
import { ChevronDownIcon, ChevronRightIcon } from "./icons.js";
import { useLocale } from "./i18n/index.js";

interface WorkspaceFileProvenanceModalProps {
  error?: string;
  file: WorkspaceFile;
  onClose: () => void;
  provenance?: WorkspaceFileProvenance;
}

function compactId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1_024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1_024; index += 1) {
    value /= 1_024;
    unit = units[index]!;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function DetailField({ children, label }: { children: ReactNode; label: string }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function ExpandableCode({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useLocale();
  const canExpand = value.length > 16;
  const label = t(expanded ? "workspaceProvenance.collapseValue" : "workspaceProvenance.expandValue");

  return <span className={`workspace-provenance-expandable${expanded ? " is-expanded" : ""}`}>
    <code title={value}>{expanded ? value : compactId(value)}</code>
    {canExpand ? <button
      aria-expanded={expanded}
      aria-label={label}
      onClick={() => setExpanded((value) => !value)}
      title={label}
      type="button"
    >{expanded ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}</button> : null}
  </span>;
}

export function WorkspaceFileProvenanceModal({
  error,
  file,
  onClose,
  provenance,
}: WorkspaceFileProvenanceModalProps) {
  const { locale, t } = useLocale();
  const date = (value: string) => new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
  const originLabel = (origin: WorkspaceFileOrigin): string => {
    switch (origin) {
      case "agent": return t("workspaceProvenance.originAgent");
      case "mcp-download": return t("workspaceProvenance.originMcp");
      case "remote-compute": return t("workspaceProvenance.originRemote");
      case "subagent": return t("workspaceProvenance.originSubagent");
      case "system": return t("workspaceProvenance.originSystem");
      case "tool": return t("workspaceProvenance.originTool");
      case "upload": return t("workspaceProvenance.originUpload");
      case "unknown": return t("workspaceProvenance.originUnknown");
    }
  };
  const title = file.path.split("/").at(-1) ?? file.path;
  const revisionContext = (revision: WorkspaceFileRevision) => [
    revision.toolName ? { key: "tool", value: revision.toolName } : undefined,
    revision.executionRunId ? { key: "execution", label: t("workspaceProvenance.execution"), value: revision.executionRunId } : undefined,
    revision.subagentId ? { key: "subagent", label: t("workspaceProvenance.subagent"), value: revision.subagentId } : undefined,
  ].filter((item): item is { key: string; label?: string; value: string } => Boolean(item));

  return <DetailModal eyebrow={t("workspaceProvenance.eyebrow")} onClose={onClose} title={title}>
    <div className="workspace-provenance">
      {!provenance && !error ? <div className="workspace-provenance-loading" role="status">{t("workspaceProvenance.loading")}</div> : null}
      {error ? <div className="workspace-provenance-error" role="alert">{error}</div> : null}
      {provenance ? <>
        <section>
          <h3>{t("workspaceProvenance.source")}</h3>
          {provenance.currentRevision.origin === "unknown" ? <p className="workspace-provenance-unknown">
            {t("workspaceProvenance.unknownHelp")}
          </p> : null}
          <dl className="workspace-provenance-grid">
            <DetailField label={t("workspaceProvenance.path")}><code title={provenance.file.path}>{provenance.file.path}</code></DetailField>
            <DetailField label={t("workspaceProvenance.sourceSession")}>
              <span className="workspace-provenance-session" title={provenance.sourceSession.title}>{provenance.sourceSession.title}</span>
              {provenance.sourceSession.deleted ? <small>{t("workspaceProvenance.deletedSession")}</small> : null}
            </DetailField>
            <DetailField label={t("workspaceProvenance.origin")}>{originLabel(provenance.currentRevision.origin)}</DetailField>
            <DetailField label={t("workspaceProvenance.recordedAt")}>{date(provenance.currentRevision.createdAt)}</DetailField>
            <DetailField label={t("workspaceProvenance.modifiedAt")}>{date(provenance.currentRevision.modifiedAt)}</DetailField>
            <DetailField label={t("workspaceProvenance.size")}>{formatBytes(provenance.currentRevision.size)}</DetailField>
            <DetailField label={t("workspaceProvenance.fileId")}><ExpandableCode value={provenance.file.id} /></DetailField>
            <DetailField label={t("workspaceProvenance.revisionId")}><ExpandableCode value={provenance.currentRevision.id} /></DetailField>
            {provenance.currentRevision.contentHash ? <DetailField label="SHA-256"><ExpandableCode value={provenance.currentRevision.contentHash} /></DetailField> : null}
          </dl>
        </section>

        {provenance.currentRevision.toolName || provenance.currentRevision.executionRunId
          || provenance.currentRevision.toolCallId || provenance.currentRevision.runId
          || provenance.currentRevision.subagentId || provenance.currentRevision.originMeta ? <section>
          <h3>{t("workspaceProvenance.context")}</h3>
          <dl className="workspace-provenance-grid">
            {provenance.currentRevision.toolName ? <DetailField label={t("workspaceProvenance.tool")}>{provenance.currentRevision.toolName}</DetailField> : null}
            {provenance.currentRevision.executionRunId ? <DetailField label={t("workspaceProvenance.execution")}><ExpandableCode value={provenance.currentRevision.executionRunId} /></DetailField> : null}
            {provenance.currentRevision.toolCallId ? <DetailField label={t("workspaceProvenance.toolCall")}><ExpandableCode value={provenance.currentRevision.toolCallId} /></DetailField> : null}
            {provenance.currentRevision.runId ? <DetailField label={t("workspaceProvenance.run")}><ExpandableCode value={provenance.currentRevision.runId} /></DetailField> : null}
            {provenance.currentRevision.subagentId ? <DetailField label={t("workspaceProvenance.subagent")}><ExpandableCode value={provenance.currentRevision.subagentId} /></DetailField> : null}
            {Object.entries(provenance.currentRevision.originMeta ?? {}).map(([key, value]) => <DetailField key={key} label={key}><code>{String(value)}</code></DetailField>)}
          </dl>
        </section> : null}

        <section>
          <h3>{t("workspaceProvenance.artifacts")}</h3>
          {provenance.artifacts.length ? <ul className="workspace-provenance-list">{provenance.artifacts.map((artifact) => <li key={artifact.versionId}>
            <strong>{artifact.name}</strong><span>v{artifact.version}</span><ExpandableCode value={artifact.versionId} />
          </li>)}</ul> : <p className="muted">{t("workspaceProvenance.noArtifacts")}</p>}
        </section>

        <section>
          <h3>{t("workspaceProvenance.lineage")}</h3>
          {provenance.lineage.length ? <ol className="workspace-provenance-list lineage">{provenance.lineage.map((entry) => <li key={entry.revisionId}>
            <strong className="workspace-provenance-session" title={entry.session.title}>{entry.session.title}</strong>
            <span>{entry.path}</span><small>{originLabel(entry.origin)}</small>
          </li>)}</ol> : <p className="muted">{t("workspaceProvenance.noLineage")}</p>}
        </section>

        <section>
          <h3>{t("workspaceProvenance.revisions")} <span>{provenance.revisions.length}</span></h3>
          <ol className="workspace-provenance-revisions">{provenance.revisions.toReversed().map((revision) => <li key={revision.id}>
            <div><strong>{originLabel(revision.origin)}</strong>{revision.id === provenance.currentRevision.id ? <em>{t("workspaceProvenance.current")}</em> : null}</div>
            <span>{date(revision.createdAt)} · {formatBytes(revision.size)}</span>
            {revisionContext(revision).length ? <small className="workspace-provenance-revision-context">{revisionContext(revision).map((item, index) => <Fragment key={item.key}>
              {index ? <span aria-hidden="true"> · </span> : null}
              {item.label ? <span>{item.label}: <ExpandableCode value={item.value} /></span> : item.value}
            </Fragment>)}</small> : null}
          </li>)}</ol>
        </section>
      </> : null}
    </div>
  </DetailModal>;
}

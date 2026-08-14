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

import type {
  GlobalModelUsageSummary,
  GlobalUsageModelGroup,
  GlobalUsageProjectGroup,
  GlobalUsageSessionGroup,
  ModelInvocationUsage,
  ModelUsageBucket,
} from "@science-agent/schema";
import React, { useMemo, useState } from "react";

import { ChevronDownIcon, ChevronRightIcon, ProjectIcon, SessionIcon, SparkleIcon } from "./icons.js";
import { formatCompactTokenValue, formatTokenField, invocationStatusLabel, usageBreakdownLabel, usageInlineLabel } from "./usageFormat.js";
import { useLocale } from "./i18n/index.js";

function TokenMeter({ bucket }: { bucket: ModelUsageBucket }) {
  const { t } = useLocale();
  const hasReported = bucket.reportedInvocationCount > 0;
  return (
    <div className={hasReported ? "usage-token-meter" : "usage-token-meter muted"} aria-label={t("usage.aria")}>
      <span><em>{t("usage.total")}</em><strong>{formatCompactTokenValue(bucket.totalTokens)}</strong></span>
      <span><em>{t("usage.input")}</em><strong>{formatCompactTokenValue(bucket.inputTokens)}</strong></span>
      <span><em>{t("usage.output")}</em><strong>{formatCompactTokenValue(bucket.outputTokens)}</strong></span>
      <span><em>{t("usage.cacheRead")}</em><strong>{formatCompactTokenValue(bucket.cacheReadTokens)}</strong></span>
      <span><em>{t("usage.cacheWrite")}</em><strong>{formatCompactTokenValue(bucket.cacheWriteTokens)}</strong></span>
      <span><em>{t("usage.calls")}</em><strong>{bucket.invocationCount}</strong></span>
      {bucket.unreportedInvocationCount > 0 ? <span className="usage-unreported"><em>{t("usage.unreported")}</em><strong>{bucket.unreportedInvocationCount}</strong></span> : null}
    </div>
  );
}

function InvocationRow({ usage }: { usage: ModelInvocationUsage }) {
  return (
    <tr>
      <td><strong>{usage.invocationKind}</strong><small>{usage.modelProfileName}</small></td>
      <td>{invocationStatusLabel(usage)}</td>
      <td>{formatTokenField(usage.totalTokens)}</td>
      <td>{formatTokenField(usage.inputTokens)}</td>
      <td>{formatTokenField(usage.outputTokens)}</td>
      <td>{formatTokenField(usage.cacheReadTokens)}</td>
      <td>{formatTokenField(usage.cacheWriteTokens)}</td>
    </tr>
  );
}

export function InvocationTable({ invocations }: { invocations: ModelInvocationUsage[] }) {
  const { t } = useLocale();
  return (
    <div className="usage-invocation-table-wrap">
      <table className="usage-invocation-table">
        <thead>
          <tr>
            <th scope="col">{t("usage.kind")}</th>
            <th scope="col">{t("usage.status")}</th>
            <th scope="col">{t("usage.total")}</th>
            <th scope="col">{t("usage.input")}</th>
            <th scope="col">{t("usage.output")}</th>
            <th scope="col">{t("usage.cacheRead")}</th>
            <th scope="col">{t("usage.cacheWrite")}</th>
          </tr>
        </thead>
        <tbody>
          {invocations.map((usage) => <InvocationRow key={usage.id} usage={usage} />)}
        </tbody>
      </table>
    </div>
  );
}

function SessionGroup({
  group,
  onOpenSession,
}: {
  group: GlobalUsageSessionGroup;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="usage-tree-node session">
      <button type="button" className="usage-tree-toggle" onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDownIcon size={15} /> : <ChevronRightIcon size={15} />}
        <SessionIcon size={15} />
        <span>
          <strong>{group.sessionTitle}</strong>
          <small>{usageBreakdownLabel(group.bucket)}</small>
        </span>
        <em>{formatCompactTokenValue(group.bucket.totalTokens)}</em>
      </button>
      <div className="usage-tree-actions">
        <button type="button" className="secondary-button usage-open-button" onClick={() => onOpenSession(group.sessionId)}>{t("usage.openSession")}</button>
      </div>
      {expanded ? (
        <div className="usage-tree-children">
          {group.runs.map((run) => (
            <div className="usage-tree-node run" key={`${group.sessionId}:${run.runId ?? run.bucket.key}`}>
              <div className="usage-run-header">
                <strong>{run.runId ? `Run ${run.runId.slice(0, 8)}` : "Standalone invocations"}</strong>
                <small>{usageBreakdownLabel(run.bucket)}</small>
              </div>
              <InvocationTable invocations={run.invocations} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProjectGroup({
  group,
  onOpenSession,
}: {
  group: GlobalUsageProjectGroup;
  onOpenSession: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="usage-tree-node project">
      <button type="button" className="usage-tree-toggle" onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDownIcon size={15} /> : <ChevronRightIcon size={15} />}
        <ProjectIcon size={15} />
        <span>
          <strong>{group.projectName}</strong>
          <small>{usageBreakdownLabel(group.bucket)}</small>
        </span>
        <em>{formatCompactTokenValue(group.bucket.totalTokens)}</em>
      </button>
      {expanded ? (
        <div className="usage-tree-children">
          {group.sessions.map((session) => (
            <SessionGroup key={session.sessionId} group={session} onOpenSession={onOpenSession} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ModelGroup({
  group,
  onOpenSession,
}: {
  group: GlobalUsageModelGroup;
  onOpenSession: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <article className="usage-model-card">
      <button type="button" className="usage-tree-toggle model" onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
        <SparkleIcon size={16} />
        <span>
          <strong>{group.modelProfileName}</strong>
          <small>{group.model} - {usageBreakdownLabel(group.bucket)}</small>
        </span>
        <em>{formatCompactTokenValue(group.bucket.totalTokens)}</em>
      </button>
      {expanded ? (
        <div className="usage-tree-children">
          <TokenMeter bucket={group.bucket} />
          {group.projects.map((project) => (
            <ProjectGroup key={`${group.modelProfileId}:${project.projectId}`} group={project} onOpenSession={onOpenSession} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function UsagePage({
  onOpenSession,
  summary,
}: {
  onOpenSession: (sessionId: string) => void;
  summary: GlobalModelUsageSummary | undefined;
}) {
  const { t } = useLocale();
  const loading = summary === undefined;
  const empty = Boolean(summary && summary.byModel.length === 0);
  const subtitle = useMemo(() => {
    if (loading) return t("usage.loading");
    if (empty) return t("usage.empty");
    return `${summary!.totals.invocationCount} calls across ${summary!.byModel.length} models`;
  }, [empty, loading, summary, t]);

  return (
    <section className="usage-page" aria-label={t("usage.aria")}>
      <header className="usage-page-header">
        <div>
          <span className="eyebrow">{t("usage.eyebrow")}</span>
          <h1>{t("usage.title")}</h1>
          <p>{subtitle}</p>
        </div>
        {summary ? <TokenMeter bucket={summary.totals} /> : null}
      </header>
      {loading ? (
        <div className="usage-empty">
          <SparkleIcon size={22} />
          <strong>{t("usage.loadingTitle")}</strong>
          <p>{t("usage.loadingHelp")}</p>
        </div>
      ) : empty ? (
        <div className="usage-empty">
          <SparkleIcon size={22} />
          <strong>{t("usage.emptyTitle")}</strong>
          <p>Run a Session or paper vision analysis to populate token totals. Unreported provider responses stay marked as unreported instead of zero.</p>
        </div>
      ) : (
        <div className="usage-model-list">
          {summary!.byModel.map((group) => (
            <ModelGroup key={group.modelProfileId} group={group} onOpenSession={onOpenSession} />
          ))}
        </div>
      )}
    </section>
  );
}

export function RunUsageInline({
  run,
}: {
  run?: { bucket: ModelUsageBucket; runId: string };
}) {
  const { t } = useLocale();
  if (!run) return null;
  return (
    <p className="message-usage-inline" aria-label={t("usage.run")}>
      {t("usage.eyebrow")}: {usageInlineLabel(run.bucket)}
    </p>
  );
}

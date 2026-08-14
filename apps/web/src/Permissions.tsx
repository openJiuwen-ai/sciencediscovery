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

import { useState } from "react";

import type { PermissionDecision, PermissionGrant, PermissionRequest } from "@science-agent/schema";

import { PermissionDecisionActions, permissionMatchingKey } from "./PermissionDecisionActions.js";

import { ChevronRightIcon } from "./icons.js";
import { activityCardId, type ActivityCardDisclosure } from "./session/run-activity.js";
import { useLocale, type MessageKey } from "./i18n/index.js";

const ACTION_LABELS: Record<PermissionRequest["action"], MessageKey> = {
  artifact_download: "permissions.download",
  code: "permissions.code",
  connector: "permissions.connector",
  directory: "permissions.directory",
  host: "permissions.host",
  remote_job: "permissions.remoteJob",
};

export function PermissionCards({
  expandedCards,
  onDecision,
  onToggleCard,
  requests,
}: ActivityCardDisclosure & {
  onDecision: (request: PermissionRequest, decision: PermissionDecision) => Promise<void>;
  requests: PermissionRequest[];
}) {
  const { t } = useLocale();
  const [decidingIds, setDecidingIds] = useState<string[]>([]);
  const [decidingMatchers, setDecidingMatchers] = useState<string[]>([]);
  const pending = requests.filter((request) => request.state === "pending" && request.action !== "remote_job");
  if (!pending.length) return null;
  async function decide(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    const matcher = permissionMatchingKey(request);
    setDecidingIds((current) => [...current, request.id]);
    if (decision === "allow_matching") setDecidingMatchers((current) => [...current, matcher]);
    try {
      await onDecision(request, decision);
    } finally {
      setDecidingIds((current) => current.filter((id) => id !== request.id));
      if (decision === "allow_matching") setDecidingMatchers((current) => {
        const index = current.indexOf(matcher);
        return index < 0 ? current : current.toSpliced(index, 1);
      });
    }
  }
  return <section aria-label={t("permissions.cards")} className="permission-cards">
    <div className="track-list-heading"><strong>{t("permissions.required")}</strong><span>{t("permissions.paused", { count: pending.length })}</span></div>
    {pending.map((request) => {
      const cardId = activityCardId("permission", request.id);
      const expanded = Boolean(expandedCards[cardId]);
      return <article className="permission-card" key={request.id}>
        <button aria-expanded={expanded} className="permission-card-heading" onClick={() => onToggleCard(cardId, !expanded)} type="button">
          <span className="card-chevron"><ChevronRightIcon size={15} /></span>
          <span><span className="eyebrow">{t(ACTION_LABELS[request.action])}</span><h4>{request.summary}</h4></span>
        </button>
        {expanded ? <div className="permission-card-body">
          <code>{request.resource}</code>
          <PermissionDecisionActions busy={decidingIds.includes(request.id) || decidingMatchers.includes(permissionMatchingKey(request))} onDecision={(decision) => void decide(request, decision)} />
        </div> : null}
      </article>;
    })}
  </section>;
}

export function PermissionGrantManager({
  grants,
  onRevoke,
}: {
  grants: PermissionGrant[];
  onRevoke: (grant: PermissionGrant) => void;
}) {
  const { t } = useLocale();
  return <div className="permission-grant-manager">
    <div className="settings-detail-header"><span className="eyebrow">{t("permissions.governance")}</span><h3>{t("permissions.grants")}</h3><p>{t("permissions.grantsHelp")}</p></div>
    {grants.length ? grants.map((grant) => <article className="permission-grant" key={grant.id}><div><strong>{t(ACTION_LABELS[grant.action])}</strong><small>{grant.resource} · this Session</small></div><button className="danger-button" onClick={() => onRevoke(grant)} type="button">{t("permissions.revoke")}</button></article>) : <p className="muted">{t("permissions.noGrants")}</p>}
  </div>;
}

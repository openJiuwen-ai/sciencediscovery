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

import type { PermissionDecision, PermissionRequest } from "@sciencediscovery/schema";
import { useId } from "react";
import { useLocale } from "./i18n/index.js";

function matchingResource(action: PermissionRequest["action"], resource: string): string {
  const parts = resource.split(":");
  return action === "connector" || action === "artifact_download"
    ? parts.slice(0, 2).join(":")
    : action === "remote_job"
      ? parts.slice(0, 3).join(":")
      : resource;
}

/** UI-only grouping used to suppress duplicate clicks while allow-matching is in flight. */
export function permissionMatchingKey(request: PermissionRequest): string {
  return `${request.action}:${matchingResource(request.action, request.resource)}`;
}

/**
 * A sandbox-network grant covers only the listed hosts, on the requesting
 * Runner, until the owning agent run ends. "Allow same type" reads as blanket
 * network access, so that one action names the hosts it actually grants.
 *
 * An evolution search asks with a fresh single-use key
 * (`evolve-search:<session>:<uuid>`), and a `code` grant is matched on the
 * whole resource, so "allow same type" could never match a later search. It
 * would promise a decision the backend drops and leak the attempt id into the
 * UI and the grant manager, so that card offers one search or denial.
 */
export function PermissionDecisionActions({
  action,
  resource,
  busy,
  onDecision,
}: {
  action: PermissionRequest["action"];
  resource: string;
  busy: boolean;
  onDecision: (decision: PermissionDecision) => void;
}) {
  const { t } = useLocale();
  const helpId = useId();
  const sandboxNetwork = action === "sandbox_network";
  const singleUse = action === "code" && resource.startsWith("evolve-search:");
  const prefixParts = action === "connector" || action === "artifact_download" ? 2 : action === "remote_job" ? 3 : 0;
  const matchingHelp = sandboxNetwork ? t("permissions.allowSandboxNetworkHostsHelp")
    : action === "code" && resource === "workspace-code" ? t("permissions.allowWorkspaceCodeHelp")
      : prefixParts && resource.split(":").length >= prefixParts
        ? t("permissions.allowMatchingPrefixHelp", { count: prefixParts, resource: matchingResource(action, resource) })
        : t("permissions.allowMatchingExactHelp", { resource });
  return <>
    <div className="permission-decision-help">
      <p>{t("permissions.waiting")}</p>
      <dl>
        <div><dt>{t("permissions.allowOnce")}</dt><dd id={`${helpId}-once`}>{t("permissions.allowOnceHelp")}</dd></div>
        {singleUse ? null : <div><dt>{sandboxNetwork ? t("permissions.allowSandboxNetworkHosts") : t("permissions.allowMatching")}</dt><dd id={`${helpId}-matching`}>{matchingHelp}</dd></div>}
        <div><dt>{t("permissions.deny")}</dt><dd id={`${helpId}-deny`}>{t("permissions.denyHelp")}</dd></div>
      </dl>
    </div>
    <div className="plan-actions permission-decision-actions">
      <button className="secondary-button" aria-describedby={`${helpId}-once`} disabled={busy} onClick={() => onDecision("allow_once")} type="button">{t("permissions.allowOnce")}</button>
      {singleUse ? null : <button className="secondary-button" aria-describedby={`${helpId}-matching`} disabled={busy} onClick={() => onDecision("allow_matching")} title={sandboxNetwork ? t("permissions.allowSandboxNetworkHostsHint") : undefined} type="button">{sandboxNetwork ? t("permissions.allowSandboxNetworkHosts") : t("permissions.allowMatching")}</button>}
      <button className="danger-button" aria-describedby={`${helpId}-deny`} disabled={busy} onClick={() => onDecision("deny")} type="button">{t("permissions.deny")}</button>
    </div>
  </>;
}

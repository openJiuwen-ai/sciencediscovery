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
  CreatePermissionRequest,
  ConnectorConfigurationRequest,
  ConnectorConfigurationPreflightResult,
  ConfigurationRequestView,
  ConfigurationPreviewInput,
  ConfigurationDecisionInput,
  ConfigurationCredentialInput,
  ConfigurationCredentialDraftView,
  ConfigurationCapabilityId,
  ConfigurationValues,
  ConfigurationScope,
  CreateRemoteJobRequest,
  CreateSessionRequest,
  DeletionImpact,
  Subagent,
  DecidePermissionRequest,
  DecideRemoteJobRequest,
  PermissionEpoch,
  PermissionDecisionResult,
  PermissionGrant,
  PermissionAuthorization,
  PermissionRequest,
  RemoteJob,
  RemoteWorkspaceSyncRecord,
  RuntimeSettingsDetails,
  RuntimeSettingsOverrides,
  Session,
  SessionDetail,
  SessionListState,
  SessionReviewerSpecialistSettings,
  UpdateSessionRequest,
  RotatePermissionEpochRequest,
} from "@sciencediscovery/schema";

import { ProjectsApiClient } from "./projects.js";

export class SessionsApiClient extends ProjectsApiClient {
  preflightConnectorConfiguration(sessionId: string, content: string): Promise<ConnectorConfigurationPreflightResult> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/configuration/preflight`, {
      body: JSON.stringify({ content }), method: "POST",
    });
  }

  listConnectorConfigurationRequests(sessionId: string): Promise<{ items: ConnectorConfigurationRequest[] }> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/configuration-requests`);
  }

  /** Includes legacy connector records while they are migrated to the registry. */
  listConfigurationRequests(sessionId: string): Promise<{ items: Array<ConnectorConfigurationRequest | ConfigurationRequestView> }> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/configuration-requests`);
  }

  createConfigurationRequest(sessionId: string, input: { protocolVersion?: 3; capabilityId: ConfigurationCapabilityId; values: ConfigurationValues; scope?: ConfigurationScope }, idempotencyKey: string): Promise<ConfigurationRequestView> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/configuration-requests`, {
      method: "POST", body: JSON.stringify(input), headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  getConfigurationRequest(sessionId: string, requestId: string): Promise<ConfigurationRequestView> {
    return this.request(this.configurationRequestPath(sessionId, requestId));
  }

  previewConfigurationRequest(sessionId: string, requestId: string, input: ConfigurationPreviewInput, idempotencyKey: string): Promise<ConfigurationRequestView> {
    return this.request(this.configurationRequestPath(sessionId, requestId, "preview"), {
      method: "POST", body: JSON.stringify(input), headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  consentConfigurationEndpoint(sessionId: string, requestId: string, input: { revision: number; endpointTarget: string }, idempotencyKey: string): Promise<ConfigurationRequestView> {
    return this.request(this.configurationRequestPath(sessionId, requestId, "endpoint-consent"), {
      method: "POST", body: JSON.stringify(input), headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  /** Credentials use a separate authenticated channel, never message/run input. */
  submitConfigurationCredential(sessionId: string, requestId: string, input: ConfigurationCredentialInput, idempotencyKey: string): Promise<ConfigurationCredentialDraftView> {
    return this.request(this.configurationRequestPath(sessionId, requestId, "credentials"), {
      method: "POST", body: JSON.stringify(input), headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  decideConfigurationRequest(sessionId: string, requestId: string, input: ConfigurationDecisionInput, idempotencyKey: string): Promise<ConfigurationRequestView> {
    return this.request(this.configurationRequestPath(sessionId, requestId, "decision"), {
      method: "POST", body: JSON.stringify(input), headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  continueConfigurationRequest(sessionId: string, requestId: string, idempotencyKey: string): Promise<ConfigurationRequestView> {
    return this.request(this.configurationRequestPath(sessionId, requestId, "continue"), {
      method: "POST", body: JSON.stringify({}), headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  reverseConfigurationRequest(sessionId: string, requestId: string, idempotencyKey: string): Promise<ConfigurationRequestView> {
    return this.request(this.configurationRequestPath(sessionId, requestId, "reversal"), {
      method: "POST", body: JSON.stringify({}), headers: { "Idempotency-Key": idempotencyKey },
    });
  }

  private configurationRequestPath(sessionId: string, requestId: string, operation?: string): string {
    return `/api/sessions/${encodeURIComponent(sessionId)}/configuration-requests/${encodeURIComponent(requestId)}${operation ? `/${operation}` : ""}`;
  }

  decideConnectorConfiguration(sessionId: string, requestId: string, decision: "apply" | "dismiss"): Promise<ConnectorConfigurationRequest> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/configuration-requests/${encodeURIComponent(requestId)}/decision`, {
      body: JSON.stringify({ decision }), method: "POST",
    });
  }

  listSessions(projectId: string, state: SessionListState = "active"): Promise<Session[]> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/sessions?state=${state}`);
  }

  createSession(projectId: string, body: CreateSessionRequest): Promise<Session> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/sessions`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  getSession(sessionId: string): Promise<SessionDetail> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  listSubagents(sessionId: string): Promise<Subagent[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/subagents`);
  }

  listRemoteJobs(sessionId: string): Promise<RemoteJob[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/remote-jobs`);
  }

  createRemoteJob(sessionId: string, body: CreateRemoteJobRequest): Promise<RemoteJob> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/remote-jobs`, { body: JSON.stringify(body), method: "POST" });
  }

  decideRemoteJob(sessionId: string, jobId: string, body: DecideRemoteJobRequest): Promise<RemoteJob> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/remote-jobs/${encodeURIComponent(jobId)}/decision`, { body: JSON.stringify(body), method: "POST" });
  }

  refreshRemoteJob(sessionId: string, jobId: string): Promise<RemoteJob> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/remote-jobs/${encodeURIComponent(jobId)}/refresh`, { method: "POST" });
  }

  /** A Session may allow several machines; each one owns a separate remote workspace. */
  deleteRemoteWorkspace(sessionId: string, hostId?: string): Promise<{ deleted: boolean }> {
    const query = hostId ? `?hostId=${encodeURIComponent(hostId)}` : "";
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/remote-workspace/delete${query}`, { method: "DELETE" });
  }

  listRemoteWorkspaceSyncs(sessionId: string): Promise<RemoteWorkspaceSyncRecord[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/remote-workspace/sync-records`);
  }

  updateSession(sessionId: string, body: UpdateSessionRequest): Promise<Session> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      body: JSON.stringify(body),
      method: "PATCH",
    });
  }

  getSessionSettings(sessionId: string): Promise<RuntimeSettingsDetails> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/settings`);
  }

  replaceSessionSettings(sessionId: string, body: RuntimeSettingsOverrides): Promise<RuntimeSettingsDetails> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/settings`, {
      body: JSON.stringify(body),
      method: "PUT",
    });
  }

  getSessionReviewerSpecialistSettings(sessionId: string): Promise<SessionReviewerSpecialistSettings> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/reviewer-specialist/settings`);
  }

  updateSessionReviewerSpecialistSettings(
    sessionId: string,
    body: SessionReviewerSpecialistSettings,
  ): Promise<SessionReviewerSpecialistSettings> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/reviewer-specialist/settings`, {
      body: JSON.stringify(body),
      method: "PUT",
    });
  }

  archiveSession(sessionId: string): Promise<Session> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "POST" });
  }

  restoreSession(sessionId: string): Promise<Session> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, { method: "POST" });
  }

  getSessionDeletionImpact(sessionId: string): Promise<DeletionImpact> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/deletion-impact`);
  }

  deleteSession(sessionId: string): Promise<{ deleted: string }> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      body: JSON.stringify({ confirmationId: sessionId }),
      method: "DELETE",
    });
  }

  getPermissionEpoch(sessionId: string): Promise<PermissionEpoch> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permission-epoch`);
  }

  rotatePermissionEpoch(sessionId: string, body: RotatePermissionEpochRequest): Promise<PermissionEpoch> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permission-epoch`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  listPermissionRequests(sessionId?: string): Promise<PermissionRequest[]> {
    return this.request(`/api/permission-requests${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`);
  }

  listPermissionGrants(): Promise<PermissionGrant[]> {
    return this.request("/api/permission-grants");
  }

  createPermissionRequest(sessionId: string, body: CreatePermissionRequest): Promise<{
    allowed: boolean;
    authorization?: PermissionAuthorization;
    request?: PermissionRequest;
  }> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permission-requests`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  decidePermissionRequest(requestId: string, body: DecidePermissionRequest): Promise<PermissionDecisionResult> {
    return this.request(`/api/permission-requests/${encodeURIComponent(requestId)}/decision`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  revokePermissionGrant(grantId: string): Promise<PermissionGrant> {
    return this.request(`/api/permission-grants/${encodeURIComponent(grantId)}`, { method: "DELETE" });
  }

  listPermissionAuthorizations(sessionId: string, executionId?: string): Promise<PermissionAuthorization[]> {
    const query = executionId ? `?executionId=${encodeURIComponent(executionId)}` : "";
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permission-authorizations${query}`);
  }
}

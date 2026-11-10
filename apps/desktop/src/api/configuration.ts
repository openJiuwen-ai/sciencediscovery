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

import type { ApiClient } from "./client.js";
import type { ConfigurationRequestActions } from "@sciencediscovery/configuration-ui";
import type { ConnectorConfigurationRequest, ConfigurationRequestView, ConfigurationCapabilityId,
  ConfigurationValues, ConfigurationScope, ConfigurationCredentialDraftView } from "@sciencediscovery/schema";

/** Historical connector records retain their own decision contract. */
export type DesktopConfigurationRequest = ConfigurationRequestView | ConnectorConfigurationRequest;

export function decideLegacyConnectorConfiguration(client: ApiClient, request: ConnectorConfigurationRequest,
  decision: "apply" | "dismiss"): Promise<ConnectorConfigurationRequest> {
  return client.request(configurationRequestPath(request.sessionId, request.id, "decision"), {
    method: "POST", body: JSON.stringify({ decision }),
  });
}

export function listConfigurationRequests(client: ApiClient, sessionId: string, signal?: AbortSignal): Promise<{ items: Array<ConnectorConfigurationRequest | ConfigurationRequestView> }> {
  return client.request(`/api/sessions/${encodeURIComponent(sessionId)}/configuration-requests`, { signal });
}

export function createConfigurationRequest(client: ApiClient, sessionId: string, input: { protocolVersion?: 3; capabilityId: ConfigurationCapabilityId; values: ConfigurationValues; scope?: ConfigurationScope }, idempotencyKey: string): Promise<ConfigurationRequestView> {
  return client.request(`/api/sessions/${encodeURIComponent(sessionId)}/configuration-requests`, {
    method: "POST", body: JSON.stringify(input), headers: { "Idempotency-Key": idempotencyKey },
  });
}

function configurationRequestPath(sessionId: string, requestId: string, operation?: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/configuration-requests/${encodeURIComponent(requestId)}${operation ? `/${operation}` : ""}`;
}

/** No credential values or promises are retained by this adapter. */
export function configurationRequestActions(client: ApiClient, request: ConfigurationRequestView): ConfigurationRequestActions {
  const path = configurationRequestPath(request.sessionId, request.id);
  function post(operation: "preview", input: Parameters<ConfigurationRequestActions["preview"]>[0], key: string): Promise<ConfigurationRequestView>;
  function post(operation: "endpoint-consent", input: Parameters<NonNullable<ConfigurationRequestActions["consent"]>>[0], key: string): Promise<ConfigurationRequestView>;
  function post(operation: "security-consent", input: Parameters<NonNullable<ConfigurationRequestActions["securityConsent"]>>[0], key: string): Promise<ConfigurationRequestView>;
  function post(operation: "credentials", input: Parameters<ConfigurationRequestActions["credential"]>[0], key: string): Promise<ConfigurationCredentialDraftView>;
  function post(operation: "settings-confirmation", input: Parameters<NonNullable<ConfigurationRequestActions["confirmSettings"]>>[0], key: string): Promise<ConfigurationRequestView>;
  function post(operation: "decision", input: Parameters<ConfigurationRequestActions["decide"]>[0], key: string): Promise<ConfigurationRequestView>;
  function post(operation: "continue" | "reversal", input: Record<string, never>, key: string): Promise<ConfigurationRequestView>;
  function post(operation: string, input: object, key: string): Promise<ConfigurationRequestView | ConfigurationCredentialDraftView> {
    return client.request(`${path}/${operation}`, {
      method: "POST", body: JSON.stringify(input), headers: { "Idempotency-Key": key },
    });
  }
  return {
    preview: (input, key) => post("preview", input, key),
    consent: (input, key) => post("endpoint-consent", input, key),
    securityConsent: (input, key) => post("security-consent", input, key),
    // Credentials never enter a message, run input or another action's body.
    credential: (input, key) => post("credentials", input, key),
    confirmSettings: (input, key) => post("settings-confirmation", input, key),
    decide: (input, key) => post("decision", input, key),
    query: () => client.request(path),
    continue: (key) => post("continue", {}, key),
    reversal: (key) => post("reversal", {}, key),
  };
}

// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createHash } from "node:crypto";
import { DEFAULT_MODEL_API_VARIANT, MODEL_API_VARIANTS, type ConfigurationValues, type ModelProfile,
  type EffectiveRuntimeSettings, type RuntimeSettingsOverrides, type ConfigurationCapabilityId } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import { testModelConnectivity } from "../model-connectivity.js";
import { resolveProxyForUrl } from "@sciencediscovery/data-source";
import type { ConfigurationAdapter, ConfigurationAdapterContext, ConfigurationPlan, ConfigurationSnapshot } from "./types.js";
import { ConfigurationCredentialBridge } from "./credential-bridge.js";
import { modelDestination, type ModelDestinationAuthorizer } from "./model-destination.js";
import { ConfigurationError } from "./validation.js";

type Options = {
  store: SessionStore;
  credentials: ConfigurationCredentialBridge;
  destinations: ModelDestinationAuthorizer;
  connector: (sessionId: string, connectorId: string) => { name: string; ready: boolean } | undefined;
};
function values(raw: unknown, allowed: string[]): ConfigurationValues {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_CONFIGURATION_INPUT");
  const result: ConfigurationValues = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.includes(key) || !["string", "boolean", "number"].includes(typeof value)) throw new Error("INVALID_CONFIGURATION_INPUT");
    if (["tokenOptional", "restoreInheritance"].includes(key) ? typeof value !== "boolean" : typeof value !== "string") throw new Error("INVALID_CONFIGURATION_INPUT");
    if (typeof value === "string" && value.length > (key === "restoreConnectorIds" ? 22000 : 2048)) throw new Error("INVALID_CONFIGURATION_INPUT");
    result[key] = typeof value === "string" ? value.trim() : value;
  }
  return result;
}
function text(input: ConfigurationValues, key: string): string { return typeof input[key] === "string" ? input[key] as string : ""; }
function settings(snapshot: ConfigurationSnapshot): EffectiveRuntimeSettings { return snapshot.data.effective as EffectiveRuntimeSettings; }
function overrides(snapshot: ConfigurationSnapshot): RuntimeSettingsOverrides { return snapshot.data.overrides as RuntimeSettingsOverrides; }
function revision(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
const noVerification = { targets: [] as string[], actions: [] as string[], maxRequests: 0, mayCharge: false };

/** Register finite domain adapters around the existing authoritative stores. */
export function createConfigurationDomainAdapters(options: Options): ConfigurationAdapter[] {
  const { store, credentials } = options;
  const restoredConnectors = (input: ConfigurationValues, snapshot: ConfigurationSnapshot): string[] => input.restoreInheritance === true
    ? (snapshot.data.inheritedConnectorIds as string[] | undefined) ?? []
    : input.restoreConnectorIds !== undefined ? JSON.parse(text(input, "restoreConnectorIds")) as string[]
      : [...new Set([...settings(snapshot).enabledConnectorIds, text(input, "connectorId")])];
  const addedConnectors = (input: ConfigurationValues, snapshot: ConfigurationSnapshot) => restoredConnectors(input, snapshot).filter(id => !settings(snapshot).enabledConnectorIds.includes(id));
  const connectorSummary = (ids: string[]) => ids.length > 10 ? `${ids.length} connectors: ${ids.slice(0, 10).join(", ")} …` : ids.join(", ");
  const apply = (id: ConfigurationCapabilityId, context: ConfigurationAdapterContext) => {
    const binding = { sessionId: context.sessionId, requestId: context.requestId, revision: context.revision,
      target: (context.plan.data?.credentialTarget as string | undefined) ?? text(context.input, "modelId"), fieldId: "apiToken" };
    const token = context.credentialHandle ? credentials.read(context.credentialHandle, binding) : undefined;
    const result = store.applyConfigurationDomainSync(context.sessionId, id, context.input, token);
    const before = overrides(context.snapshot);
    const reversal: ConfigurationValues | undefined = id === "connector.enable"
      ? { connectorId: text(context.input, "connectorId"), ...(before.enabledConnectorIds === undefined
        ? { restoreInheritance: true } : { restoreConnectorIds: JSON.stringify(before.enabledConnectorIds) }) }
      : id === "model.select" || id === "model.connect"
        ? { modelId: before.modelId ?? result.modelId ?? "", ...(before.modelId === undefined ? { restoreInheritance: true } : {}) }
        : undefined;
    return { resourceRevision: revision(store.configurationSnapshot(context.sessionId, id, text(context.input, "modelId")).resourceVersions),
      summary: id === "model.repair_credential" ? "Model credential replaced" : "Configuration saved",
      ...(reversal ? { reversal } : {}) };
  };
  const connector: ConfigurationAdapter = {
    id: "connector.enable", version: 1, schemaVersion: 1, scopes: ["session"], persistence: "local_transaction",
    normalize: raw => {
      const input = values(raw, ["connectorId", "restoreInheritance", "restoreConnectorIds"]);
      if (input.restoreInheritance !== undefined && typeof input.restoreInheritance !== "boolean") throw new Error("INVALID_CONFIGURATION_INPUT");
      if (typeof input.connectorId !== "string" || !input.connectorId || input.connectorId.length > 100) throw new Error("INVALID_CONFIGURATION_INPUT");
      if (input.restoreConnectorIds !== undefined) {
        let ids: unknown;
        try { ids = JSON.parse(text(input, "restoreConnectorIds")); }
        catch { throw new ConfigurationError("INVALID_CONFIGURATION_INPUT", "Connector restoration must be valid JSON", 400, "restoreConnectorIds"); }
        if (!Array.isArray(ids) || ids.length > 200 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !id || id.length > 100)) throw new Error("INVALID_CONFIGURATION_INPUT");
      }
      return input;
    },
    target: input => text(input, "connectorId"),
    preview: (input, snapshot) => {
      const id = text(input, "connectorId");
      const added = addedConnectors(input, snapshot);
      const restoring = input.restoreInheritance === true || input.restoreConnectorIds !== undefined;
      const before = [...settings(snapshot).enabledConnectorIds].sort();
      const after = [...restoredConnectors(input, snapshot)].sort();
      const changed = JSON.stringify(before) !== JSON.stringify(after)
        || input.restoreInheritance === true && overrides(snapshot).enabledConnectorIds !== undefined
        || input.restoreConnectorIds !== undefined && overrides(snapshot).enabledConnectorIds === undefined;
      return { fields: [{ id: "connectorId", label: "Connector", kind: "enum", required: true, value: id,
        choices: [...new Set([...(snapshot.data.installedConnectorIds as string[]), ...(restoring ? [id] : [])])].map(value => ({ id: value, label: value })) }],
        changes: changed ? [{ field: "enabledConnectorIds", before: connectorSummary(settings(snapshot).enabledConnectorIds),
          after: input.restoreInheritance ? "Inherit parent settings" : connectorSummary(restoredConnectors(input, snapshot)) }] : [],
        impact: { resourceLocation: "Session settings", effectiveScope: "This session only", message: "Other sessions stay unchanged. Tool calls retain their own approval policy." },
        verificationPlan: noVerification, activationMode: snapshot.runId ? "same_run" : "next_run", disposition: changed ? "change" : "no_change", ready: changed && added.every(value => (snapshot.data.installedConnectorIds as string[]).includes(value)) };
    },
    verify: async context => {
      return addedConnectors(context.input, context.snapshot).every(id => options.connector(context.sessionId, id)?.ready)
        ? { ok: true } : { ok: false, code: "CONNECTOR_NOT_READY", message: "A connector newly enabled by this change is not installed, ready, or permitted by the session plugin policy.", retryable: true };
    },
    apply: context => {
      if (addedConnectors(context.input, context.snapshot).some(id => !options.connector(context.sessionId, id)?.ready)) throw new Error("CONNECTOR_NOT_READY");
      return apply("connector.enable", context);
    },
    previewReversal: receipt => {
      if (!receipt.result.reversal) throw new Error("CONFIGURATION_REVERSAL_UNAVAILABLE");
      return connector.normalize(receipt.result.reversal);
    },
  };
  const select: ConfigurationAdapter = {
    id: "model.select", version: 1, schemaVersion: 1, scopes: ["session"], persistence: "local_transaction",
    normalize: raw => {
      const input = values(raw, ["modelId", "restoreInheritance"]);
      if (input.restoreInheritance !== undefined && typeof input.restoreInheritance !== "boolean") throw new Error("INVALID_CONFIGURATION_INPUT");
      return input;
    },
    target: input => text(input, "modelId"),
    preview: (input, snapshot) => {
      const models = snapshot.data.models as ModelProfile[];
      return { fields: [{ id: "modelId", label: "Task model", required: true, kind: "enum", ...(text(input, "modelId") ? { value: text(input, "modelId") } : {}), choices: models.map(model => ({ id: model.id, label: model.name })) }],
        changes: [{ field: "modelId", before: settings(snapshot).modelId ?? "Not selected", after: input.restoreInheritance ? "Inherit parent settings" : models.find(model => model.id === input.modelId)?.name ?? "Choose a model" }],
        impact: { resourceLocation: "Existing model registry", effectiveScope: "This session only", message: "Bind an existing model; no new shared resource is created." },
        verificationPlan: noVerification, activationMode: "before_first_run", ready: input.restoreInheritance === true || models.some(model => model.id === input.modelId) };
    },
    verify: async context => {
      const model = store.getModel(text(context.input, "modelId"));
      return context.input.restoreInheritance === true || (model && (store.getModelApiToken(model.id) || store.modelAllowsMissingToken(model)))
        ? { ok: true } : { ok: false, code: "MODEL_CREDENTIAL_REQUIRED", message: "Choose a usable model or repair its credential first.", retryable: true };
    },
    apply: context => apply("model.select", context),
    previewReversal: receipt => {
      if (!receipt.result.reversal) throw new Error("CONFIGURATION_REVERSAL_UNAVAILABLE");
      return receipt.result.reversal;
    },
  };
  const normalizeConnection = (raw: unknown) => {
    const input = values(raw, ["name", "baseUrl", "model", "apiProtocol", "apiVariant", "tokenOptional"]);
    const protocol = text(input, "apiProtocol") || "openai-chat-completions";
    if (!Object.hasOwn(MODEL_API_VARIANTS, protocol)) throw new Error("UNSUPPORTED_MODEL_PROTOCOL");
    input.apiProtocol = protocol;
    input.apiVariant = input.apiVariant ?? DEFAULT_MODEL_API_VARIANT[protocol as keyof typeof DEFAULT_MODEL_API_VARIANT];
    if (!MODEL_API_VARIANTS[protocol as keyof typeof MODEL_API_VARIANTS].includes(input.apiVariant as never)) throw new Error("UNSUPPORTED_MODEL_PROTOCOL");
    if (input.tokenOptional !== undefined && typeof input.tokenOptional !== "boolean") throw new Error("INVALID_CONFIGURATION_INPUT");
    const base = text(input, "baseUrl");
    if (base) {
      let url: URL;
      try { url = new URL(base); } catch { throw new ConfigurationError("INVALID_CONFIGURATION_URL", "Enter a valid HTTP or HTTPS endpoint.", 400, "baseUrl"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new ConfigurationError("INVALID_CONFIGURATION_URL", "Use an HTTP or HTTPS endpoint without credentials, a query or a fragment.", 400, "baseUrl");
      input.baseUrl = url.toString().replace(/\/$/, "");
    }
    return input;
  };
  const connectionTarget = (input: ConfigurationValues) => [text(input, "baseUrl"), text(input, "model"), text(input, "apiProtocol"), text(input, "apiVariant")].join("|");
  const verifyModel = async (context: ConfigurationAdapterContext) => {
    const isRepair = context.plan.data?.repair === true;
    const saved = isRepair ? store.getModel(text(context.input, "modelId")) : undefined;
    if (isRepair && !saved) return { ok: false, code: "MODEL_NOT_FOUND", message: "The model no longer exists.", retryable: false };
    const input = context.input;
    const profile: ModelProfile = saved ?? { id: "configuration-validation", name: text(input, "name"), model: text(input, "model"),
      baseUrl: text(input, "baseUrl"), apiProtocol: input.apiProtocol as ModelProfile["apiProtocol"], apiVariant: input.apiVariant as ModelProfile["apiVariant"],
      hasApiToken: Boolean(context.credentialHandle), proxyPolicy: "inherit", vision: false, createdAt: "", updatedAt: "" };
    const probe = async (apiToken?: string) => {
      options.destinations.assertContext(context, profile, Boolean(apiToken));
      const tested = await testModelConnectivity({ profile, apiToken, allowMissingToken: !isRepair && input.tokenOptional === true,
        beforeDispatch: () => {
          if (store.notifications.generation(context.sessionId) !== context.snapshot.stopGeneration) throw new ConfigurationError("CONTINUATION_STOPPED", "The task was stopped before the probe was sent", 409);
          const current = isRepair ? store.getModel(text(context.input, "modelId")) : profile;
          if (!current) throw new ConfigurationError("MODEL_NOT_FOUND", "The model no longer exists", 409);
          options.destinations.assertContext(context, current, Boolean(apiToken));
        },
        resolveProxy: () => resolveProxyForUrl(store.resolveProxy(profile.proxyPolicy), profile.baseUrl) });
      return { ok: tested.ok, code: tested.ok ? undefined : `MODEL_${tested.category.toUpperCase()}`, message: tested.message, retryable: !tested.ok, field: tested.ok ? undefined : "apiToken" };
    };
    if (!context.credentialHandle) return probe();
    try {
      return await credentials.withLease(context.credentialHandle, { sessionId: context.sessionId, requestId: context.requestId,
        revision: context.revision, target: String(context.plan.data?.credentialTarget), fieldId: "apiToken" }, probe);
    } catch (error) {
      if (error instanceof ConfigurationError) return { ok: false, code: error.code, message: error.message, retryable: false, field: error.field };
      const busy = error instanceof Error && error.message === "CREDENTIAL_DRAFT_BUSY";
      return { ok: false, code: busy ? "CREDENTIAL_DRAFT_BUSY" : "CREDENTIAL_DRAFT_EXPIRED", message: busy ? "A credential check is already running. Wait and retry this same draft." : "Re-enter the credential in the secure field.", retryable: true, field: "apiToken" };
    }
  };
  const connect: ConfigurationAdapter = {
    id: "model.connect", version: 1, schemaVersion: 1, scopes: ["session", "global"], persistence: "local_transaction",
    normalize: normalizeConnection, target: connectionTarget,
    preview: (input, snapshot, scope) => {
      const first = (snapshot.data.models as ModelProfile[]).length === 0;
      if ((first && scope.kind !== "global") || (!first && scope.kind !== "session")) throw new Error(first ? "FIRST_MODEL_REQUIRES_GLOBAL_SCOPE" : "MODEL_CONNECTION_REQUIRES_SESSION_SCOPE");
      const plan: ConfigurationPlan = {
        fields: [
          { id: "name", label: "Provider name", required: true, kind: "text", value: text(input, "name") },
          { id: "baseUrl", label: "API base URL", required: true, kind: "url", value: text(input, "baseUrl") },
          { id: "model", label: "Model ID", required: true, kind: "text", value: text(input, "model") },
          { id: "apiProtocol", label: "API protocol", required: true, kind: "enum", value: text(input, "apiProtocol"), choices: Object.keys(MODEL_API_VARIANTS).map(id => ({ id, label: id })) },
          { id: "apiVariant", label: "API variant", required: true, kind: "enum", value: text(input, "apiVariant"), choices: MODEL_API_VARIANTS[input.apiProtocol as keyof typeof MODEL_API_VARIANTS].map(id => ({ id, label: id })) },
          { id: "tokenOptional", label: "Endpoint accepts requests without an API key", required: false, kind: "boolean", value: input.tokenOptional === true },
          { id: "apiToken", label: "API key", required: input.tokenOptional !== true, kind: "credential", status: "missing" },
        ],
        changes: [{ field: first ? "global.modelId" : "session.modelId", before: settings(snapshot).modelId ?? "Not selected", after: text(input, "model") || "New model" }],
        impact: { resourceLocation: "Existing provider/model registry and encrypted credential store", effectiveScope: first ? "Global default" : "This session model binding",
          message: first ? "The first model becomes the global default for this and future inheriting sessions." : "The connection is saved system-wide; only this session switches its task model." },
        verificationPlan: { targets: text(input, "baseUrl") ? [text(input, "baseUrl")] : [], actions: ["Send one fixed, short model connectivity probe; save only if it succeeds"], maxRequests: 1, mayCharge: true },
        activationMode: "before_first_run", ready: ["name", "baseUrl", "model"].every(key => Boolean(text(input, key))), data: { credentialTarget: connectionTarget(input) },
        ...(text(input, "baseUrl") ? { endpointAuthorization: modelDestination({ baseUrl: text(input, "baseUrl"), model: text(input, "model"), apiProtocol: input.apiProtocol as ModelProfile["apiProtocol"], apiVariant: input.apiVariant as ModelProfile["apiVariant"] }) } : {}),
      };
      return plan;
    },
    verify: verifyModel, apply: context => apply("model.connect", context),
  };
  const repair: ConfigurationAdapter = {
    id: "model.repair_credential", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    normalize: raw => values(raw, ["modelId"]), target: input => text(input, "modelId"),
    preview: (input, snapshot) => {
      const model = snapshot.data.model as ModelProfile | undefined;
      return { fields: [{ id: "modelId", label: "Existing model", kind: "enum", required: true, ...(text(input, "modelId") ? { value: text(input, "modelId") } : {}), choices: (snapshot.data.models as ModelProfile[]).map(item => ({ id: item.id, label: item.name })) },
        { id: "apiToken", label: "Replacement API key", kind: "credential", required: true, status: "missing" }],
        changes: [{ field: "modelCredential", before: model?.hasApiToken ? "Saved credential" : "Missing credential", after: "Validated replacement credential" }],
        impact: { resourceLocation: "Existing model credential store", effectiveScope: "Every session using this model profile", message: "Only this model's credential override is replaced. The provider's other models keep their credentials." },
        verificationPlan: { targets: model ? [model.baseUrl] : [], actions: ["Validate the isolated replacement once before updating the existing credential"], maxRequests: 1, mayCharge: true },
        activationMode: "next_run", ready: Boolean(model), data: { repair: true, credentialTarget: text(input, "modelId") },
        ...(model ? { endpointAuthorization: modelDestination(model) } : {}) };
    },
    verify: verifyModel, apply: context => apply("model.repair_credential", context),
  };
  return [connector, select, connect, repair];
}

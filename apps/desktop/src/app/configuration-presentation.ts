// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationRequestView } from "@sciencediscovery/schema";
import { configurationSecurityConsent, configurationNeedsSecurityConsent, configurationCompactToggleCopy } from "@sciencediscovery/configuration-ui";
import type { SettingsGroup } from "../views/SystemSettingsDialog.js";

/** Only real Desktop panes, never a guessed Web URL or a scope-changing editor. */
const settings: Readonly<Record<string, SettingsGroup>> = {
  "model.connect": "models",
  "timeouts.configure": "timeouts",
};
function classifyDesktopConfiguration(request: ConfigurationRequestView): {
  settingsGroup?: SettingsGroup; fieldIds?: string[]; targetLabel?: string; unsupported?: boolean; destructive?: boolean; connectorAddition?: true; connectorRestoration?: true;
} {
  const capability: string = request.capabilityId;
  const targetField = (id: string) => {
    const field = request.fields.find(item => item.id === id);
    return field?.kind === "enum" && typeof field.value === "string" && field.value
      && field.choices?.some(choice => choice.id === field.value) ? field : undefined;
  };
  const targetLabel = (id: string) => {
    const field = targetField(id)!, label = field.choices!.find(choice => choice.id === field.value)!.label;
    const value = String(field.value);
    return label === value || label.endsWith(` (${value})`) || label.endsWith(` · ${value}`) ? label : `${label} (${value})`;
  };
  const readyForDestruction = request.scope.kind === "global" && request.state === "awaiting_confirmation" && Boolean(request.previewDigest)
    && !request.endpointAuthorization && request.fields.every(field => field.kind !== "credential");
  if (capability === "provider.remove_credential") {
    return readyForDestruction && targetField("providerId") && request.fields.length === 1
      && request.changes.length === 1 && request.changes[0]?.field === "providerCredential"
      ? { fieldIds: [], targetLabel: targetLabel("providerId"), destructive: true } : { unsupported: true };
  }
  if (["mcp.remove_header", "mcp.remove_env", "mcp.delete"].includes(capability)) {
    const name = capability === "mcp.remove_header" ? "headerName" : "envName";
    const deletion = capability === "mcp.delete";
    const validFields = request.fields.length === 2 && (deletion ? request.fields.some(field => field.id === "confirmDelete" && field.kind === "boolean") : Boolean(targetField(name)));
    const ready = deletion ? ["collecting_input", "awaiting_confirmation", "needs_fix", "stale"].includes(request.state) : readyForDestruction;
    return request.scope.kind === "global" && targetField("serverId") && validFields && ready
      && !request.endpointAuthorization && request.fields.every(field => field.kind !== "credential")
      && request.changes.every(change => change.field === (deletion ? "serverId" : name))
      ? { fieldIds: deletion ? ["confirmDelete"] : [], destructive: true,
        targetLabel: `${targetLabel("serverId")}${deletion ? "" : ` · ${targetLabel(name)}`}` } : { unsupported: true };
  }
  if (capability === "mcp.header_credential") {
    const validFields = request.fields.every(field => ["serverId", "headerName", "apiToken"].includes(field.id))
      && request.fields.some(field => field.id === "headerName" && field.kind === "enum")
      && request.fields.every(field => field.id !== "apiToken" || field.kind === "credential");
    return request.scope.kind === "global" && targetField("serverId") && validFields
      ? { settingsGroup: "mcp", targetLabel: targetLabel("serverId") } : { unsupported: true };
  }
  if (capability === "mcp.metadata" && targetField("serverId") && request.scope.kind === "global"
    && request.fields.length === 3 && request.fields.every(field => field.id === "serverId" || ["name", "description"].includes(field.id) && field.kind === "text")
    && request.changes.every(change => ["name", "description"].includes(change.field))
    && !(request.state === "awaiting_confirmation" && request.previewDigest && request.changes.length === 1))
    return { settingsGroup: "mcp", targetLabel: targetLabel("serverId") };
  // Selecting an existing model is always session-local, not registry editing.
  if (capability === "model.select") return request.scope.kind === "session" && request.scope.id === request.sessionId ? {} : { unsupported: true };
  // Existing model-profile requests remain visible but cannot edit an unsupported surface.
  if (capability === "model.metadata") return { unsupported: true };
  if (capability.startsWith("model.") || capability.startsWith("provider."))
    return settings[capability] ? { settingsGroup: settings[capability] } : { unsupported: true };
  // These are simple policy choices, but the shared card still renders and
  // enforces the independent security-consent step before its Apply button.
  const securityField: Readonly<Record<string, string>> = {
    "security.approval_mode": "approvalMode", "security.default_approval": "defaultApprovalMode",
    "security.automatic_configuration": "autoApplyLowRiskConfiguration",
  };
  if (securityField[capability] && request.fields.length === 1 && request.fields[0]?.id === securityField[capability]
    && ["boolean", "enum"].includes(request.fields[0].kind)) return {};
  if (capability === "security.network" && request.state === "awaiting_confirmation" && request.previewDigest
    && request.changes.length === 1 && request.changes[0]?.field === "mode"
    && request.fields.some(field => field.id === "mode" && field.kind === "enum")
    && request.fields.every(field => field.kind !== "credential" && field.kind !== "url")) return { fieldIds: ["mode"] };
  const ready = request.state === "awaiting_confirmation" && Boolean(request.previewDigest);
  const changes = [...new Set(request.changes.map(change => change.field))];
  if (capability === "proxy.default" && request.fields.length === 1 && request.fields[0]?.id === "defaultPolicy"
    && request.fields[0].kind === "enum") return {};
  if (["proxy.provider", "proxy.mcp"].includes(capability) && ready && request.scope.kind === "global") {
    const target = request.fields.find(field => field.id === (capability === "proxy.provider" ? "providerId" : "mcpServerId"));
    if (target?.kind === "enum" && typeof target.value === "string" && target.value
      && request.fields.length === 2 && request.fields.some(field => field.id === "proxyPolicy" && field.kind === "enum")
      && changes.length === 1 && changes[0] === "proxyPolicy")
      return { fieldIds: ["proxyPolicy"], targetLabel: `${target.choices?.find(choice => choice.id === target.value)?.label ?? target.value} (${target.value})` };
    return { unsupported: true };
  }
  if (capability === "proxy.resources" && ready && request.scope.kind === "global") {
    const value = (id: string) => { const field = request.fields.find(item => item.id === id); return field && field.kind !== "credential" ? field.value : undefined; };
    const kind = value("kind");
    // The real adapter omits replaceUrl for environment/system resources.
    // Only a custom URL resource has that flag, and it must remain false.
    const schema: Readonly<Record<string, string>> = {
      operation: "enum", proxyId: "enum", name: "text", kind: "enum",
      ...(kind === "custom_url" ? { replaceUrl: "boolean" } : {}),
    };
    if (targetField("proxyId") && value("operation") === "update"
      && (kind === "custom_url" && value("replaceUrl") === false || kind === "environment" || kind === "system")
      && request.fields.length === Object.keys(schema).length
      && Object.entries(schema).every(([id, type]) => request.fields.filter(field => field.id === id && field.kind === type).length === 1)
      && request.changes.length === 1 && changes[0] === "name"
      && !request.endpointAuthorization && !("securityConsent" in request))
      return { fieldIds: ["name"], targetLabel: targetLabel("proxyId") };
    return { unsupported: true };
  }
  // Never omit credential/recipient/security inputs based merely on diff size.
  if (request.fields.some(field => field.kind === "credential" || field.kind === "url") || "securityConsent" in request || request.endpointAuthorization)
    return { unsupported: true };
  if (capability === "settings.inherit") {
    const selected = request.fields[0];
    const value = selected?.kind === "multiselect" ? selected.value : undefined;
    const ordinaryScalars = ["modelId", "reviewModelId", "semanticReviewEnabled", "thinkingMode", "thinkingEffort"];
    const scopeMatches = request.scope.kind === "session" ? request.scope.id === request.sessionId
      : request.scope.kind === "project" && request.scope.id === request.projectId;
    return ready && scopeMatches && request.activation.mode === "next_run" && request.fields.length === 1
      && selected?.id === "selectedFields" && Array.isArray(value) && value.length === 1
      && typeof value[0] === "string" && ordinaryScalars.includes(value[0])
      && selected.kind === "multiselect" && selected.choices?.some(choice => choice.id === value[0])
      && request.changes.length === 1 && request.changes[0]?.field === value[0]
      && typeof request.changes[0].before === "string" && request.changes[0].after?.startsWith("Inherit (")
      ? { fieldIds: [], destructive: true } : { unsupported: true };
  }
  if (capability === "web.configure") {
    // The adapter exposes all current fields. Swarm omits Native-only fields;
    // require that exact schema rather than infer support from a scalar diff.
    const native = request.activation.mode === "next_run";
    const schema: Readonly<Record<string, string>> = {
      deepseekEnabled: "boolean", fetchProvider: "enum", freeSearchEngines: "multiselect", paidSearchProviders: "multiselect",
      ...(native ? { searchCacheTtlSeconds: "number", fetchCacheTtlSeconds: "number", proxyPolicy: "enum" } : {}),
    };
    const editable = ["deepseekEnabled", "fetchProvider", ...(native ? ["searchCacheTtlSeconds", "fetchCacheTtlSeconds", "proxyPolicy"] : [])];
    const complete = request.fields.length === Object.keys(schema).length
      && new Set(request.fields.map(field => field.id)).size === request.fields.length
      && request.fields.every(field => schema[field.id] === field.kind && field.kind !== "credential" && field.value !== undefined
        && (field.kind !== "enum" || field.choices?.some(choice => choice.id === field.value)));
    return ready && request.scope.kind === "global" && (native || request.activation.mode === "requires_restart")
      && complete && request.changes.length === 1 && editable.includes(request.changes[0]!.field)
      ? { fieldIds: [request.changes[0]!.field] } : { unsupported: true };
  }
  if (capability === "memory.enable") {
    const field = request.fields[0], change = request.changes[0];
    return ready && request.scope.kind === "global" && request.activation.mode === "next_request"
      && request.fields.length === 1 && field?.id === "enabled" && field.kind === "boolean" && typeof field.value === "boolean"
      && request.changes.length === 1 && change?.field === "enabled"
      && change.before === (field.value ? "Disabled" : "Enabled") && change.after === (field.value ? "Enabled" : "Disabled")
      ? {} : { unsupported: true };
  }
  if (capability === "mcp.availability") {
    const enabled = request.fields.find(field => field.id === "enabled");
    const change = request.changes[0];
    return ready && request.scope.kind === "global" && String(request.activation.mode) === "next_invocation" && request.fields.length === 2
      && targetField("serverId") && /^custom-[a-f0-9]{12}$/.test(String(targetField("serverId")!.value))
      && enabled?.kind === "boolean" && typeof enabled.value === "boolean"
      && request.changes.length === 1 && change?.field === "enabled"
      && change.before === String(!enabled.value) && change.after === String(enabled.value)
      ? { fieldIds: ["enabled"], targetLabel: targetLabel("serverId") } : { unsupported: true };
  }
  if (capability === "connector.enable") {
    const target = targetField("connectorId"), change = request.changes[0];
    // The adapter summarizes more than ten IDs with an ellipsis. That is not
    // evidence of an exact single addition; never infer it from a list prefix.
    const ids = (value: string | undefined): string[] | undefined => {
      if (value === "") return [];
      if (typeof value !== "string") return undefined;
      const result = value.split(", ");
      return result.length <= 10 && new Set(result).size === result.length
        && result.every(id => /^[a-z0-9][a-z0-9._:-]{0,99}$/i.test(id)) ? result : undefined;
    };
    const before = ids(change?.before), after = ids(change?.after), id = target?.value;
    const bound = request.scope.kind === "session" && request.scope.id === request.sessionId
      && request.fields.length === 1 && target && typeof id === "string"
      && request.changes.length === 1 && change?.field === "enabledConnectorIds";
    if (!bound || !before || typeof id !== "string") return { unsupported: true };
    if (ready && after && !before.includes(id) && after.length === before.length + 1
      && after.includes(id) && before.every(previous => after.includes(previous)))
      return { connectorAddition: true, targetLabel: targetLabel("connectorId") };
    // Receipt-based reversals use the same capability, but are not additions.
    // Lock the target and retain their complete bounded before/after diff. The
    // generic length gate below still rejects long or summarized restorations.
    const restoring = change?.after === "Inherit parent settings" || after
      && before.includes(id) && !after.includes(id) && before.length === after.length + 1
      && after.every(previous => before.includes(previous));
    if ((ready || request.state === "applied" && request.previewDigest) && restoring)
      return { fieldIds: [], connectorRestoration: true, targetLabel: targetLabel("connectorId") };
    return { unsupported: true };
  }
  if (["mcp.timeout", "mcp.metadata"].includes(capability)) {
    const target = request.fields.find(field => field.id === "serverId");
    const changed = [...new Set(request.changes.map(change => change.field))];
    const editable = capability === "mcp.timeout" ? "timeoutSeconds"
      : changed.length === 1 && ["name", "description"].includes(changed[0]!) ? changed[0] : undefined;
    if (target?.kind === "enum" && typeof target.value === "string" && target.value && editable
      && request.fields.some(field => field.id === editable) && changed.length === 1 && changed[0] === editable && request.state === "awaiting_confirmation" && request.previewDigest) {
      return { fieldIds: [editable], targetLabel: `${target.choices?.find(choice => choice.id === target.value)?.label ?? target.value} (${target.value})` };
    }
    return { unsupported: true };
  }
  if (capability.startsWith("security.") || capability.startsWith("proxy.") || capability.startsWith("mcp."))
    return { unsupported: true };
  const singleFields: Readonly<Record<string, string>> = {
    "reviewer.enable": "enabled", "plugin.json_viewer": "mode",
  };
  if (singleFields[capability] && request.fields.length === 1 && request.fields[0]?.id === singleFields[capability]) return {};
  const changed = [...new Set(request.changes.map(change => change.field))];
  // The server preview still carries every original value; only the requested
  // scalar editor is shown. This is presentation, not a reduced apply payload.
  const ordinary = ["timeouts.configure", "quotas.configure", "thinking.configure", "review.configure", "environment.sources", "idea_tree.configure"];
  const complete = request.fields.every(field => !field.required || field.kind !== "credential" && field.value !== undefined && field.value !== "");
  if (ordinary.includes(capability) && complete && changed.length === 1 && request.fields.some(field => field.id === changed[0] && field.kind !== "multiselect"))
    return { fieldIds: changed };
  if (capability === "skill.select" && request.state === "awaiting_confirmation" && request.previewDigest)
    return { fieldIds: [] };
  return settings[capability] ? { settingsGroup: settings[capability] } : { unsupported: true };
}

/** A short card is an editor, not a folded version of the full settings page.
 * Reject oversized/unknown inputs rather than clip targets, lists or risk text.
 */
export function desktopConfigurationPresentation(request: ConfigurationRequestView): ReturnType<typeof classifyDesktopConfiguration> {
  const result = classifyDesktopConfiguration(request);
  // A scheduled server action must remain visible and cancellable, never be
  // hidden behind a navigation-only card. This does not start a countdown.
  if (request.autoApplyAt) return { unsupported: true };
  if (result.settingsGroup || result.unsupported) return result;
  const capability: string = request.capabilityId;
  const confirmation = request.fields.find(field => field.id === "confirmDelete");
  const persisted = request.options?.filter(option => option.kind !== "dismiss");
  const destructiveSettings = result.destructive && ["mcp.delete", "mcp.remove_header", "mcp.remove_env"].includes(capability)
    && request.schemaVersion === 1 && request.adapterVersion === 1 && Boolean(request.previewDigest) && !request.error
    && !request.endpointAuthorization && !("securityConsent" in request)
    && String(request.activation.mode) === "next_invocation" && request.activation.state === "not_requested"
    && new Set(request.fields.map(field => field.id)).size === request.fields.length
    && request.fields.every(field => field.required)
    && request.fields.some(field => field.id === "serverId" && field.kind === "enum"
      && typeof field.value === "string" && /^custom-[a-f0-9]{12}$/.test(field.value))
    && !request.verificationPlan.targets.length && !request.verificationPlan.actions.length
    && request.verificationPlan.maxRequests === 0 && !request.verificationPlan.mayCharge
    && request.protocolVersion === 3 && request.options?.length === 2
    && new Set(request.options.map(option => option.id)).size === 2
    && persisted?.length === 1 && persisted[0]?.kind === "persisted_apply" && persisted[0].available === true
    && persisted[0].id === request.selectedOptionId
    && request.allowedActions.includes("preview") && request.allowedActions.includes("dismiss")
    && request.allowedActions.length === (request.state === "collecting_input" ? 2 : 3)
    && (request.state === "collecting_input" || request.allowedActions.includes("apply"))
    && (request.state === "awaiting_confirmation" && request.changes.length === 1
      && (capability !== "mcp.delete" || confirmation?.kind === "boolean" && confirmation.value === true)
      || capability === "mcp.delete" && request.state === "collecting_input" && !request.changes.length
      && confirmation?.kind === "boolean" && confirmation.value === false);
  const fallback = (): ReturnType<typeof classifyDesktopConfiguration> => {
    // Navigation never accepts a malformed proposal or a different choice.
    // The original page still owns target selection and manual confirmation.
    if (destructiveSettings) return { settingsGroup: "mcp" };
    if (capability === "timeouts.configure") return { settingsGroup: "timeouts" };
    // The original MCP editor already supports per-call timeout. A long
    // backend explanation must route there, not strand a valid proposal.
    if (["mcp.metadata", "mcp.timeout"].includes(capability) && request.scope.kind === "global") return { settingsGroup: "mcp" };
    return { unsupported: true };
  };
  // Count full-width characters conservatively. No truncation or CSS clipping.
  const short = (text: string | undefined, limit: number) => !text || !/[\r\n]/.test(text)
    && [...text].reduce((size, character) => size + (character.charCodeAt(0) > 255 ? 2 : 1), 0) <= limit;
  const fieldIds = result.fieldIds;
  const visible = fieldIds ? request.fields.filter(field => fieldIds.includes(field.id)) : request.fields;
  // A proven connector addition has a single visible target. Its full unchanged
  // baseline need not fit a scalar diff; the compact card receives this proof.
  const hiddenChanges = result.connectorAddition ? [] : request.changes.filter(change => !visible.some(field => field.id === change.field));
  if (request.schemaVersion !== 1 || request.adapterVersion !== 1
    || visible.length > 1 || new Set(request.fields.map(field => field.id)).size !== request.fields.length
    || !short(result.targetLabel, 80) || !short(request.impact.effectiveScope, 80)
    || visible.some(field => !short(field.label, 60) || field.kind === "enum" && !short(field.choices?.find(choice => choice.id === field.value)?.label, 80)
      || field.kind === "credential" || field.kind === "url" || field.kind === "multiselect"
      || field.kind === "text" && !short(typeof field.value === "string" ? field.value : undefined, 80))
    || hiddenChanges.length > 1 || hiddenChanges.some(change => !short(change.before, 60) || !short(change.after, 60))
    || request.endpointAuthorization
    || request.verificationPlan.targets.length || request.verificationPlan.actions.length || request.verificationPlan.maxRequests > 0
    || request.verificationPlan.mayCharge
    || request.protocolVersion === 3 && request.options?.filter(option => option.kind !== "dismiss").some(option => option.kind !== "persisted_apply")
    ) return fallback();
  const consent = configurationSecurityConsent(request);
  if (configurationNeedsSecurityConsent(capability) || "securityConsent" in request) {
    const session = request.scope.kind === "session" && request.scope.id === request.sessionId;
    const scoped = capability === "security.approval_mode" || capability === "security.automatic_configuration" ? session
      : capability === "security.default_approval" ? request.scope.kind === "global" || request.scope.kind === "project" && request.scope.id === request.projectId
      : ["security.network", "proxy.default"].includes(capability) && request.scope.kind === "global";
    const id = ({ "security.approval_mode": "approvalMode", "security.default_approval": "defaultApprovalMode",
      "security.automatic_configuration": "autoApplyLowRiskConfiguration", "proxy.default": "defaultPolicy" } as Record<string, string>)[capability];
    const primary = request.fields[0];
    const primaryValue = primary && primary.kind !== "credential" ? primary.value : undefined;
    const knownSchema = id && request.fields.length === 1 && request.fields[0]?.id === id
      && request.fields[0].kind === (capability === "security.automatic_configuration" ? "boolean" : "enum")
      && request.changes.every(change => change.field === id)
      && (request.fields[0].kind === "boolean" ? typeof request.fields[0].value === "boolean"
        : request.fields[0].choices?.some(choice => choice.id === primaryValue));
    // Network's additional access controls cannot be hidden behind a mode-only
    // editor; the original pane also cannot represent private/egress policy.
    if (!scoped || !knownSchema || !consent || consent.revision !== request.revision
      || !short(consent.statement, 120) || hiddenChanges.length) return fallback();
  } else {
    const hasShortCopy = ["model.select", "model.metadata", "timeouts.configure", "quotas.configure", "thinking.configure", "review.configure",
      "environment.sources", "idea_tree.configure", "proxy.provider", "proxy.mcp", "proxy.resources", "settings.inherit", "web.configure"].includes(capability) || Boolean(configurationCompactToggleCopy(request, "en"));
    if ((!hasShortCopy || result.destructive && capability !== "settings.inherit") && !short(request.impact.message, result.destructive ? 80 : 120)) return fallback();
  }
  return result;
}

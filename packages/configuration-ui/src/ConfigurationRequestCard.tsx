// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { useEffect, useId, useRef, useState, type FormEvent, type ComponentType, type ReactNode, Fragment as ReactFragment } from "react";
import { DEFAULT_MODEL_API_VARIANT, DEFAULT_MODEL_DISCOVERY, MODEL_API_VARIANTS, type ModelApiProtocol } from "@sciencediscovery/schema";
import type { ConfigurationAction, ConfigurationCredentialDraftView, ConfigurationCredentialInput, ConfigurationDecisionInput,
  ConfigurationSettingsConfirmationInput, ConfigurationFieldView, ConfigurationPreviewInput, ConfigurationRequestView, ConfigurationScalar, ConfigurationValues } from "@sciencediscovery/schema";
import { configurationNeedsSecurityConsent, configurationSecurityConsent, securityAcknowledgementText } from "./compatibility.js";
import { configurationCompactToggleCopy } from "./compact-toggle-copy.js";
import { configurationMessages } from "./messages.js";
import { configurationImpactText, type ConfigurationImpactField } from "./impact-messages.js";

export interface ConfigurationRequestActions {
  securityConsent?(input: { revision: number; targetDigest: string; acknowledged: true }, key: string): Promise<ConfigurationRequestView>;
  consent?(input: { revision: number; endpointTarget: string }, key: string): Promise<ConfigurationRequestView>;
  preview(input: ConfigurationPreviewInput, key: string): Promise<ConfigurationRequestView>;
  credential(input: ConfigurationCredentialInput, key: string): Promise<ConfigurationCredentialDraftView>;
  decide(input: ConfigurationDecisionInput, key: string): Promise<ConfigurationRequestView>;
  confirmSettings?(input: ConfigurationSettingsConfirmationInput, key: string): Promise<ConfigurationRequestView>;
  query(): Promise<ConfigurationRequestView>;
  continue(key: string): Promise<ConfigurationRequestView>;
  reversal(key: string): Promise<ConfigurationRequestView>;
}

function fieldValues(request: ConfigurationRequestView): ConfigurationValues {
  return Object.fromEntries(request.fields.flatMap((field) => field.kind !== "credential" && field.value !== undefined
    ? [[field.id, field.value]] : []));
}

/** Only the rendered scalar values may change while preserving a local draft.
 * Hidden recipients, scope, choices and schema remain bound to the source. */
function scalarEditorIdentity(view: ConfigurationRequestView, fieldIds: readonly string[]) {
  return JSON.stringify([view.id, view.sessionId, view.projectId, view.capabilityId, view.scope,
    view.schemaVersion, view.adapterVersion, view.protocolVersion, view.selectedOptionId, view.options, view.autoApplyAt,
    view.fields.map(field => {
      if (field.kind === "credential" || !fieldIds.includes(field.id)) return field;
      const { value: _value, ...schema } = field;
      return schema;
    })]);
}

/** Message tables are plain objects. An inherited prototype key is not a translation. */
function ownMessage(table: Record<string, string>, key: string, fallback: string): string {
  return Object.hasOwn(table, key) ? table[key] ?? fallback : fallback;
}

/** A tab-local navigation marker is not configuration or authorization state. */
function hasOpenedSettings(key: string): boolean {
  try { return globalThis.sessionStorage?.getItem(key) === "1"; } catch { return false; }
}

export function isConfigurationRequestView(request: object): request is ConfigurationRequestView {
  return "capabilityId" in request;
}

/** Hosts retain their error identity; arbitrary thrown objects must never be
 * interpreted as trusted API errors or have their messages rendered. */
export interface ConfigurationApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
}
export type ConfigurationApiRequestErrorConstructor = new (
  message: string, status: number, code?: string, details?: Record<string, unknown>,
) => ConfigurationApiRequestError;

/** Terminal presentation belongs to the host's visual system. */
export interface ConfigurationProcessRecordProps {
  children: ReactNode;
  label: ReactNode;
  className?: string;
  failed?: boolean;
}

export interface ConfigurationRequestCardProps {
  /** Opt-in host presentation. Omitted by Web to preserve its full editor. */
  lockedFieldIds?: readonly string[];
  idPrefix?: string;
  compact?: { connectorRestoration?: true; connectorAddition?: true; destructive?: boolean; targetLabel?: string; fieldIds?: readonly string[]; onOpenSettings?: () => void; settingsDestination?: ConfigurationSettingsConfirmationInput["destination"]; unsupported?: boolean };
  request: ConfigurationRequestView;
  actions: ConfigurationRequestActions;
  runActive?: boolean;
  readOnly?: boolean;
  onUpdate: (request: ConfigurationRequestView) => void;
  onUnavailable?: () => void;
  onStopTask?: () => Promise<void>;
  locale: string;
  ProcessRecord: ComponentType<ConfigurationProcessRecordProps>;
  ApiRequestError: ConfigurationApiRequestErrorConstructor;
}

/** The form is driven exclusively by the server's registered schema. Secrets and
 * credential handles are component-local, never written into timeline snapshots.
 * Hosts supply stable component and error constructors, locale and CSS. */
export function ConfigurationRequestCard({ request, actions, runActive: sourceRunActive = false, readOnly = false,
  onUpdate, onUnavailable, onStopTask, locale, ProcessRecord, ApiRequestError, compact: sourceCompact, lockedFieldIds, idPrefix = "configuration-request" }: ConfigurationRequestCardProps) {
  // A no-op preview can remove its diff. Keep only this card's already
  // classified editor, and only for the exact response of its own preview.
  const noChangeEditor = useRef<{ view: string; compact: NonNullable<ConfigurationRequestCardProps["compact"]> } | undefined>(undefined);
  const autoPreviewOperation = useRef<{ source: ConfigurationRequestView; fieldIds: string[]; shape: string; observed?: string;
    compact: NonNullable<ConfigurationRequestCardProps["compact"]>; preserveNoChange: boolean } | undefined>(undefined);
  const pendingEditor = autoPreviewOperation.current;
  const pendingNoChange = Boolean(sourceCompact && pendingEditor?.preserveNoChange && request.revision > pendingEditor.source.revision
    && request.state === "collecting_input" && !request.changes.length && !request.endpointAuthorization && !("securityConsent" in request)
    && scalarEditorIdentity(request, pendingEditor.fieldIds) === pendingEditor.shape);
  const compactNoChange = Boolean(sourceCompact && noChangeEditor.current?.view === JSON.stringify(request));
  const compact = compactNoChange ? noChangeEditor.current!.compact : pendingNoChange ? pendingEditor!.compact : sourceCompact;
  const capabilityId: string = request.capabilityId;
  const securityConsent = configurationSecurityConsent(request);
  const runActive = sourceRunActive && request.liveWait !== true;
  const m = configurationMessages(locale);
  const impactText = (field: ConfigurationImpactField) => configurationImpactText(locale, capabilityId, field, request.impact[field]);
  const settingsOpenedKey = `configuration-settings-opened:${JSON.stringify([request.sessionId, request.id, capabilityId, request.revision])}`;
  const [openedSettingsKey, setOpenedSettingsKey] = useState<string>();
  const settingsOpened = openedSettingsKey === settingsOpenedKey || hasOpenedSettings(settingsOpenedKey);
  const apiKeyDestination = ["model.connect", "model.repair_credential", "provider.connection", "provider.credential", "model.api_identity"].includes(capabilityId);
  const credentialWarnings = apiKeyDestination ? m.apiKeyWarnings : m;
  const capabilityFieldLabel = (fieldId: string, fallback: string) => {
    if (capabilityId === "memory.enable" && fieldId === "enabled") return m.field.memoryEnabled ?? fallback;
    const table = Object.hasOwn(m.fieldsByCapability, capabilityId) ? m.fieldsByCapability[capabilityId] : undefined;
    return table ? ownMessage(table, fieldId, fallback) : fallback;
  };
  const changeValue = (field: string, value: string | undefined) => {
    if (capabilityId === "memory.enable" && field === "enabled") {
      if (value === "Enabled") return m.memoryState.enabled;
      if (value === "Disabled") return m.memoryState.disabled;
    }
    if (capabilityId === "connector.enable" && field === "enabledConnectorIds") {
      if (value === "Inherit parent settings") return m.compact.inheritedConnectors;
      if (value === "") return m.compact.noConnectors;
    }
    return value ?? m.unset;
  };
  const id = useId();
  const [values, setValues] = useState(() => fieldValues(request));
  const [selectedOptionId, setSelectedOptionId] = useState(request.selectedOptionId);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const editGeneration = useRef(0);
  const attemptedAutoPreview = useRef(-1);
  const [autoPreviewPending, setAutoPreviewPending] = useState(false);
  const autoPreviewPendingRef = useRef(false);
  const acceptedAutoPreview = useRef<string | undefined>(undefined);

  const [compositionActive, setCompositionActive] = useState(false);
  const destructiveIdentity = (view: ConfigurationRequestView) => JSON.stringify([view.id, view.revision, view.previewDigest ?? null]);
  const currentDestructiveIdentity = destructiveIdentity(request);
  const latestDestructiveIdentity = useRef(currentDestructiveIdentity);
  latestDestructiveIdentity.current = currentDestructiveIdentity;
  const [destructiveAcknowledgement, setDestructiveAcknowledgement] = useState<string>();
  const destructiveAcknowledged = destructiveAcknowledgement === currentDestructiveIdentity;
  const latestDestructiveAcknowledgement = useRef(destructiveAcknowledgement);
  latestDestructiveAcknowledgement.current = destructiveAcknowledgement;
  const setDestructiveAcknowledged = (checked: boolean) => setDestructiveAcknowledgement(checked ? currentDestructiveIdentity : undefined);
  const [securityAcknowledgementTarget, setSecurityAcknowledgementTarget] = useState<{ revision: number; targetDigest: string }>();
  const securityAcknowledged = Boolean(securityConsent && securityAcknowledgementTarget?.revision === request.revision
    && securityAcknowledgementTarget?.targetDigest === securityConsent.targetDigest);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [mutationsBlocked, setMutationsBlocked] = useState(false);
  const [errorField, setErrorField] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const [taskStopped, setTaskStopped] = useState(false);
  const credentialDraft = useRef<(ConfigurationCredentialDraftView & { revision: number }) | undefined>(undefined);
  const submittedPreview = useRef<{ revision: number; digest?: string } | undefined>(undefined);
  const operationKeys = useRef(new Map<string, string>());
  const busyRef = useRef(false);
  const composing = useRef(false);
  const imeSubmitBlocked = useRef(false);
  const imeSubmitReset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const latestRequest = useRef(request);
  if (compact) latestRequest.current = request;
  const latestWriteAllowed = useRef(false);
  latestWriteAllowed.current = !readOnly && !runActive && !mutationsBlocked;
  const targetFields = ["baseUrl", "apiProtocol", "apiVariant", "modelId", "model", "serverId", "webProvider", "operation", "headerName", "envName", "providerId", "modelDiscovery", "apiModel", "proxyId", "kind", "replaceUrl"];
  const dependentRemovalField = ["mcp.remove_header", "mcp.header_credential"].includes(capabilityId) ? "headerName" : capabilityId === "mcp.remove_env" ? "envName" : capabilityId === "mcp.delete" ? "confirmDelete" : undefined;
  const targetIdentity = (view: ConfigurationRequestView) => JSON.stringify([view.credentialTargetDigest ?? "", view.endpointAuthorization?.endpointTarget ?? "", ...targetFields.map(key => fieldValues(view)[key] ?? "")]);
  const previousTarget = useRef(targetIdentity(request));
  const previousRequestId = useRef(request.id);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; credentialDraft.current = undefined; if (imeSubmitReset.current !== undefined) clearTimeout(imeSubmitReset.current); }; }, []);
  useEffect(() => {
    const targetChanged = previousRequestId.current !== request.id || previousTarget.current !== targetIdentity(request);
    previousRequestId.current = request.id;
    previousTarget.current = targetIdentity(request);
    latestRequest.current = request;
    // Our own preview advances CAS without replacing a newer local draft.
    // An unrelated server snapshot still wins and invalidates pending callbacks.
    const ownPreview = Boolean(compact && acceptedAutoPreview.current === JSON.stringify(request));
    const pending = autoPreviewOperation.current;
    const pendingSnapshot = Boolean(compact && pending && request.revision > pending.source.revision
      && ["collecting_input", "awaiting_confirmation", "needs_fix", "stale"].includes(request.state)
      && scalarEditorIdentity(request, pending.fieldIds) === pending.shape);
    if (!ownPreview && pendingSnapshot) {
      // Polling may see our server revision before the POST response arrives.
      // Preserve typing but do not trust this snapshot to confirm or rebase
      // until the response proves it is the exact result of our own request.
      pending!.observed = JSON.stringify(request);
      setDirty(true); setRefreshRequired(true);
    } else if (!ownPreview) {
      acceptedAutoPreview.current = undefined;
      autoPreviewOperation.current = undefined;
      editGeneration.current++;
      if (!busyRef.current || compact) setValues(fieldValues(request));
    }
    setSelectedOptionId(request.selectedOptionId);
    if (targetChanged || ["applied", "dismissed", "cancelled", "expired"].includes(request.state)) setSecrets({});
    if (!ownPreview && !pendingSnapshot && (!busyRef.current || compact)) {
      // A background snapshot must not silently approve a replacement key that
      // is still only present in this browser's form.
      setDirty(!targetChanged && Object.values(secrets).some(Boolean));
      setRefreshRequired(false);
    }
    setMutationsBlocked(false);
    setErrorField(undefined);
    if (targetChanged) { setDestructiveAcknowledged(false); credentialDraft.current = undefined; operationKeys.current.clear(); }
  }, [request.id, request.revision, request.state, request.endpointAuthorization?.endpointTarget, request.credentialTargetDigest]);
  useEffect(() => {
    if (!request.autoApplyAt || request.state !== "awaiting_confirmation") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [request.autoApplyAt, request.state]);
  useEffect(() => { setSecurityAcknowledgementTarget(undefined); }, [request.id, request.revision, securityConsent?.targetDigest]);
  const hasAction = (action: ConfigurationAction) => request.allowedActions.includes(action);
  const choices = request.protocolVersion === 3 ? request.options ?? [] : [];
  const visibleChoices = choices.filter(option => option.kind !== "dismiss");
  const availableChoices = visibleChoices.filter(option => option.available);
  const selectedOption = choices.find(option => option.id === selectedOptionId && option.available);
  const dismissOption = choices.find(option => option.kind === "dismiss" && option.available);
  const canDismiss = hasAction("dismiss") && (request.protocolVersion !== 3 || Boolean(dismissOption));
  const terminal = ["applied", "dismissed", "cancelled", "expired"].includes(request.state);
  const authorization = request.endpointAuthorization as (NonNullable<ConfigurationRequestView["endpointAuthorization"]> & { destinations?: Array<{ label: string; url: string }> }) | undefined;
  const targetEdited = targetFields.some(key => JSON.stringify(values[key] ?? "") !== JSON.stringify(fieldValues(request)[key] ?? ""));
  const needsEndpoint = apiKeyDestination
    || capabilityId === "mcp.header_credential" && request.fields.some(field => field.kind === "credential");
  const endpointReady = authorization ? !targetEdited && ["trusted", "confirmed"].includes(authorization.status) : !needsEndpoint;
  const publicPlaintext = authorization?.classification === "public_http";
  const insecureEndpointCopy = capabilityId === "provider.connection" ? m.providerEndpointChangeInsecure : m.endpointChangeInsecure;
  const credentialReady = endpointReady && !publicPlaintext;
  const securityRequired = configurationNeedsSecurityConsent(capabilityId) || "securityConsent" in request;
  const securityReady = !securityRequired || (securityConsent?.status === "confirmed" && securityConsent.revision === request.revision);
  const securityAcknowledgement = securityAcknowledgementText(capabilityId, m.securityAcknowledgement, m.securityAcknowledgementFallback);
  const editable = hasAction("preview") && !terminal && !busy && !readOnly && !mutationsBlocked
    && !(request.state === "awaiting_confirmation" && request.autoApplyAt);
  const canApply = hasAction("apply") && request.state === "awaiting_confirmation"
    && (!compact?.destructive || destructiveAcknowledged)
    && endpointReady && securityReady && Boolean(request.previewDigest) && !dirty && !refreshRequired && !runActive && !readOnly && !mutationsBlocked
    && (!submittedPreview.current || (submittedPreview.current.revision === request.revision && submittedPreview.current.digest === request.previewDigest))
    && (request.protocolVersion !== 3 || (selectedOption && selectedOption.kind !== "dismiss" && selectedOption.id === request.selectedOptionId));
  const scheduledAt = !readOnly && !mutationsBlocked && request.state === "awaiting_confirmation" && request.autoApplyAt && Number.isFinite(Date.parse(request.autoApplyAt))
    ? request.autoApplyAt : undefined;
  const remainingSeconds = scheduledAt ? Math.max(0, Math.ceil((Date.parse(scheduledAt) - now) / 1_000)) : undefined;
  const formattedTime = (value: string) => Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : value;

  function operationKey(operation: string): string {
    let key = operationKeys.current.get(operation);
    if (!key) { key = crypto.randomUUID(); operationKeys.current.set(operation, key); }
    return key;
  }
  function accept(next: ConfigurationRequestView) {
    if (!mounted.current) return false;
    const targetChanged = previousTarget.current !== targetIdentity(next);
    if (targetChanged) {
      setSecrets({}); credentialDraft.current = undefined; operationKeys.current.clear();
      // An explicit preview already binds this new target. Invalidate only a
      // prior preview; endpoint consent must not strand the fresh one.
      if (submittedPreview.current?.revision !== next.revision || submittedPreview.current.digest !== next.previewDigest)
        submittedPreview.current = { revision: -1 };
    }
    latestRequest.current = next;
    previousTarget.current = targetIdentity(next);
    if (mounted.current) { setValues(fieldValues(next)); onUpdate(next); }
    return targetChanged;
  }
  function edit(field: ConfigurationFieldView, value: ConfigurationScalar | string[]) {
    if (!(autoPreview ? scalarEditable : editable) || runActive || lockedFieldIds?.includes(field.id)) return;
    if (compact && (!mounted.current || !latestWriteAllowed.current
      || previewIdentity(request) !== previewIdentity(latestRequest.current)
      || busyRef.current && !autoPreviewPendingRef.current)) return;
    editGeneration.current++;
    setSecurityAcknowledgementTarget(undefined);
    setDirty(true);
    setError(undefined);
    setErrorField(undefined);
    operationKeys.current.clear();
    credentialDraft.current = undefined;
    if (field.kind === "credential") {
      setSecrets((current) => ({ ...current, [field.id]: String(value) }));
    } else { if (targetFields.includes(field.id)) setSecrets({}); setValues((current) => {
      const next: ConfigurationValues = { ...current, [field.id]: value,
        ...(["model.connect", "provider.connection"].includes(capabilityId) && field.id === "apiProtocol" && typeof value === "string" && value in MODEL_API_VARIANTS
          ? { apiVariant: DEFAULT_MODEL_API_VARIANT[value as ModelApiProtocol], ...(capabilityId === "provider.connection" ? { modelDiscovery: DEFAULT_MODEL_DISCOVERY[value as ModelApiProtocol] } : {}) } : {}) };
      if (dependentRemovalField && field.id === "serverId" && current.serverId !== value) delete next[dependentRemovalField];
      return next;
    }); }
  }
  // Only the host-classified compact scalar editor can preview automatically.
  // Preview never consents, uploads a credential, verifies a connection or applies.
  const visibleFields = request.fields.filter(field => !compact?.fieldIds || compact.fieldIds.includes(field.id));
  const autoPreview = Boolean(compact && !compact.onOpenSettings && !compact.unsupported && !compact.destructive
    && !request.fields.some(field => field.kind === "credential" || field.kind === "url")
    && visibleFields.length && visibleFields.every(field => ["text", "number", "enum", "boolean"].includes(field.kind)));
  // Auto-preview only locks mutations. Scalar controls keep their DOM nodes,
  // focus and draft while the network request is in flight.
  const scalarEditable = autoPreview && hasAction("preview") && !terminal && !readOnly && !runActive && !mutationsBlocked
    && (!busy || autoPreviewPending) && !(request.state === "awaiting_confirmation" && request.autoApplyAt);
  const previewIdentity = (view: ConfigurationRequestView) => JSON.stringify([view.id, view.sessionId, view.revision,
    view.stateVersion, view.state, view.previewDigest, targetIdentity(view), view.selectedOptionId]);
  async function previewCompact(nextValues: ConfigurationValues, generation = editGeneration.current) {
    if (!mounted.current || !autoPreview || !editable || runActive || refreshRequired || composing.current || busyRef.current
      || !latestWriteAllowed.current || generation !== editGeneration.current
      || acceptedAutoPreview.current && acceptedAutoPreview.current !== JSON.stringify(request)
      || previewIdentity(request) !== previewIdentity(latestRequest.current)) return;
    const source = latestRequest.current;
    const identity = previewIdentity(source);
    // A later keystroke does not invalidate the server revision returned by
    // this serialized request. Navigation, background revisions and loss of
    // write access do invalidate it.
    const operation = { source, fieldIds: visibleFields.map(field => field.id),
      shape: scalarEditorIdentity(source, visibleFields.map(field => field.id)), observed: undefined as string | undefined,
      compact: compact!, preserveNoChange: !securityRequired && !authorization };
    autoPreviewOperation.current = operation;
    const current = () => mounted.current && latestWriteAllowed.current && autoPreviewOperation.current === operation
      && (previewIdentity(latestRequest.current) === identity || operation.observed === JSON.stringify(latestRequest.current));
    attemptedAutoPreview.current = generation;
    autoPreviewPendingRef.current = true;
    setAutoPreviewPending(true);
    await perform(async () => {
      const next = await actions.preview({ expectedRevision: source.revision, values: nextValues,
        ...(source.protocolVersion === 3 ? { selectedOptionId } : {}) }, operationKey(`auto-preview:${generation}`));
      if (current()) {
        if (next.id !== source.id || next.sessionId !== source.sessionId || next.revision <= source.revision)
          throw new ApiRequestError("", 409);
        if (previewIdentity(latestRequest.current) !== identity && operation.observed !== JSON.stringify(next))
          throw new ApiRequestError("", 409);
        noChangeEditor.current = compact && !securityRequired && !authorization && !next.endpointAuthorization && !("securityConsent" in next) && next.state === "collecting_input"
          && !next.changes.length && scalarEditorIdentity(next, operation.fieldIds) === operation.shape
          ? { view: JSON.stringify(next), compact } : undefined;
      }
      return next;
    }, undefined, current, {
      restoreFocus: false,
      accept: next => {
        const newerDraft = generation !== editGeneration.current;
        acceptedAutoPreview.current = JSON.stringify(next);
        submittedPreview.current = { revision: next.revision, digest: next.previewDigest };
        latestRequest.current = next;
        previousTarget.current = targetIdentity(next);
        // Hidden fields remain server-authoritative; only the editable draft
        // survives an older response. The next preview uses next.revision.
        setValues(draft => {
          const updated = fieldValues(next);
          if (newerDraft) for (const field of visibleFields) {
            const value = draft[field.id];
            if (value === undefined) delete updated[field.id];
            else updated[field.id] = value;
          }
          return updated;
        });
        setDirty(newerDraft); setRefreshRequired(false);
        onUpdate(next);
      },
      onError: () => { attemptedAutoPreview.current = editGeneration.current; },
    });
    if (autoPreviewOperation.current === operation) autoPreviewOperation.current = undefined;
    autoPreviewPendingRef.current = false;
    if (mounted.current) {
      setAutoPreviewPending(false);
      // The server may have advanced CAS while this card became read-only.
      // Require a fresh query if editing is subsequently restored.
      if (!latestWriteAllowed.current && previewIdentity(latestRequest.current) === identity) setRefreshRequired(true);
    }
  }
  useEffect(() => {
    if (!autoPreview || !dirty || !editable || runActive || refreshRequired || compositionActive
      || attemptedAutoPreview.current === editGeneration.current
      || acceptedAutoPreview.current && acceptedAutoPreview.current !== JSON.stringify(request)) return;
    // Do not submit half-typed numbers or missing required choices/text.
    if (visibleFields.some(field => (field.required || field.kind === "number")
      && (values[field.id] === "" || values[field.id] === undefined))) return;
    const generation = editGeneration.current;
    const timer = setTimeout(() => void previewCompact(values, generation), capabilityId === "model.select" ? 0 : 300);
    return () => clearTimeout(timer);
  }, [autoPreview, dirty, editable, runActive, refreshRequired, compositionActive, values, request.id, request.revision]);
  async function selectCompactModel(field: ConfigurationFieldView, value: string) {
    if (!scalarEditable || runActive) return;
    edit(field, value);
    await previewCompact({ ...values, [field.id]: value });
  }
  async function selectOption(optionId: string) {
    if (!editable || runActive || busyRef.current || !choices.some(option => option.id === optionId && option.available)) return;
    setSelectedOptionId(optionId);
    setDirty(true);
    credentialDraft.current = undefined;
    operationKeys.current.clear();
    await perform(async () => {
      const next = await actions.preview({ expectedRevision: request.revision, values, selectedOptionId: optionId }, operationKey(`option:${optionId}`));
      submittedPreview.current = { revision: next.revision, digest: next.previewDigest };
      return next;
    });
  }
  function dismiss() {
    if (!canDismiss || busyRef.current || readOnly || mutationsBlocked || runActive) return;
    void perform(async () => {
      const target = request.protocolVersion === 3 && request.selectedOptionId !== dismissOption!.id
        ? await actions.preview({ expectedRevision: request.revision, values: fieldValues(request), selectedOptionId: dismissOption!.id }, operationKey("dismiss-preview"))
        : request;
      return actions.decide({ revision: target.revision, previewDigest: target.previewDigest ?? "", decision: "dismiss",
        ...(request.protocolVersion === 3 ? { selectedOptionId: dismissOption!.id } : {}) }, operationKey(`dismiss:${target.revision}`));
    });
  }
  async function perform(work: () => Promise<ConfigurationRequestView>, credentialRetry = () => false, current = () => mounted.current,
    options?: { accept?: (next: ConfigurationRequestView) => void; restoreFocus?: boolean; onError?: () => void }) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setErrorField(undefined);
    const focused = typeof document === "undefined" ? undefined : document.activeElement;
    const focusId = focused instanceof Object && "id" in focused ? String(focused.id) : undefined;
    const focusTarget = previousTarget.current;
    try {
      const next = await work();
      if (current()) (options?.accept ?? accept)(next);
    } catch (reason) {
      if (!current()) return;
      options?.onError?.();
      // Do not echo raw provider/network errors; these can contain submitted URLs
      // or credentials. Domain errors in the server-projected view are safe.
      if (reason instanceof ApiRequestError && (reason.status === 401 || reason.status === 403)) {
        setMutationsBlocked(true);
        setError(m.accessDenied);
      } else if (reason instanceof ApiRequestError && reason.status === 404) {
        setMutationsBlocked(true);
        setError(m.notFound);
        onUnavailable?.();
      } else if (reason instanceof ApiRequestError && ["SESSION_NOT_WRITABLE", "CONTINUATION_STOPPED"].includes(reason.code ?? "")) {
        setMutationsBlocked(true);
        setError(reason.code === "CONTINUATION_STOPPED" ? m.stopped : m.readOnly);
      } else if (reason instanceof ApiRequestError && reason.code === "IDEMPOTENCY_MISMATCH") {
        setRefreshRequired(true);
        setError(m.idempotencyMismatch);
      } else if (reason instanceof ApiRequestError && ["CONFIGURATION_WAIT_NOT_READY", "CONFIGURATION_RUN_ACTIVE"].includes(reason.code ?? "")) {
        setRefreshRequired(true);
        setError(m.waitBoundary);
      } else if (reason instanceof ApiRequestError && reason.status === 409) {
        setRefreshRequired(true);
        setError(m.conflict);
      } else if (reason instanceof ApiRequestError && reason.status === 410) {
        credentialDraft.current = undefined;
        setSecrets({});
        setRefreshRequired(true);
        setError(m.expired);
      } else if (reason instanceof ApiRequestError && reason.status === 400) {
        setDirty(true);
        setError(reason.code === "CONFIGURATION_ENDPOINT_INSECURE" ? insecureEndpointCopy : m.invalidInput);
        if (typeof reason.details?.field === "string") setErrorField(reason.details.field);
      } else if (reason instanceof ApiRequestError && reason.status === 429) {
        setRefreshRequired(true);
        setError(m.rateLimited);
      } else {
        setRefreshRequired(!credentialRetry());
        setError(credentialRetry() ? m.credentialRetry : m.requestFailed);
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        if (options?.restoreFocus !== false && focusId && typeof requestAnimationFrame !== "undefined") requestAnimationFrame(() => {
          if (mounted.current && focusTarget === previousTarget.current && document.activeElement === document.body)
            document.getElementById(focusId)?.focus({ preventScroll: true });
        });
      }
    }
  }
  async function preview(event: FormEvent) {
    event.preventDefault();
    if (!editable || runActive || composing.current || imeSubmitBlocked.current) return;
    if (autoPreview) { await previewCompact(values); return; }
    const credentialFields = request.fields.filter((field) => field.kind === "credential" && secrets[field.id]);
    if (credentialFields.length > 1) { setError(m.unsupportedCredentials); return; }
    let uploading = false;
    await perform(async () => {
      if (credentialFields[0]) {
        const fieldId = credentialFields[0].id;
        // Bind the isolated draft to the normalized target, including changes to
        // the endpoint/model in this form. This preview has no network effects.
        const target = await actions.preview({ expectedRevision: latestRequest.current.revision, values,
          ...(request.protocolVersion === 3 ? { selectedOptionId } : {}) }, operationKey(`target-preview:${latestRequest.current.revision}`));
        if (!mounted.current) return target;
        if (accept(target)) {
          setDirty(true); setError(credentialWarnings.destinationChanged); return target;
        }
        if (target.endpointAuthorization && !["trusted", "confirmed"].includes(target.endpointAuthorization.status)) {
          setDirty(true); return target;
        }
        uploading = true;
        const uploaded = await actions.credential({ expectedRevision: target.revision, fieldId, secret: secrets[fieldId]! }, operationKey(`credential:${target.revision}`));
        uploading = false;
        if (!mounted.current) return target;
        credentialDraft.current = { ...uploaded, revision: target.revision };
        setSecrets({});
      }
      const draft = credentialDraft.current;
      if (draft && Date.parse(draft.expiresAt) <= Date.now()) { credentialDraft.current = undefined; throw new ApiRequestError("", 410); }
      const next = await actions.preview({ expectedRevision: draft?.revision ?? latestRequest.current.revision, values,
        ...(request.protocolVersion === 3 ? { selectedOptionId } : {}),
        ...(draft ? { credentialHandle: draft.handle } : {}) }, operationKey("preview"));
      submittedPreview.current = { revision: next.revision, digest: next.previewDigest };
      // Only this acknowledged, controlled preview may carry confirmation to
      // its returned revision. An intervening background render invalidates it.
      if (mounted.current && destructiveAcknowledged && latestDestructiveIdentity.current === currentDestructiveIdentity
        && next.id === request.id && targetIdentity(next) === targetIdentity(request))
        setDestructiveAcknowledgement(destructiveIdentity(next));
      credentialDraft.current = undefined;
      if (mounted.current) { setDirty(false); setRefreshRequired(false); }
      return next;
    }, () => uploading);
  }
  const title = compact?.connectorRestoration ? m.compact.connectorRestoreTitle : m.capability[capabilityId] ?? capabilityId;
  const changeFieldLabel = (field: string) => {
    if (field === "proxyPolicy" || field === "defaultPolicy") return ownMessage(m.field, field, field);
    if (capabilityId === "web.credential" || capabilityId === "web.configure") return ownMessage(m.field, field, field);
    if (capabilityId !== "proxy.resources") return field;
    if (field === "name") return locale.startsWith("zh") ? "代理名称" : "Proxy name";
    if (field === "operation") return locale.startsWith("zh") ? "操作" : "Operation";
    return ownMessage(m.field, field, field);
  };
  const scope = `${m.scope[request.scope.kind]}${request.scope.kind !== "global" ? ` · ${request.scope.id}` : ""}`;
  const describeChoice = (option: { kind: keyof typeof m.choiceKind; alternativeId?: string; label: string }) =>
    `${m.choiceKind[option.kind]}${option.kind === "alternative" ? ` · ${option.alternativeId === "web-search" ? m.webSearchAlternative : option.label}` : ""}`;
  const choiceLabel = request.choiceReceipt ? describeChoice(request.choiceReceipt) : undefined;
  const reasonText = request.reason.message === "CONNECTOR_REQUIRED_FOR_TASK" ? m.connectorNeeded
    : request.reason.code === "CONFIGURATION_REQUIRED" && request.reason.message === "A configuration change is required"
      ? m.configurationRequired : request.reason.message;
  const resumptionLabel = request.runId && !terminal && request.resumption.state === "not_requested" ? m.waitingChoice : m.resumption[request.resumption.state];
  const stateLabel = request.choiceReceipt && !request.choiceReceipt.configurationWritten ? m.choiceCompleted : m.state[request.state];
  const savedForNextRun = request.state === "applied" && ["next_run", "next_request"].includes(request.activation.mode) && !request.runId
    && (!request.choiceReceipt || (request.choiceReceipt.kind === "persisted_apply" && request.choiceReceipt.configurationWritten));
  const savedForRestart = request.state === "applied" && request.activation.mode === "requires_restart"
    && (!request.choiceReceipt || (request.choiceReceipt.kind === "persisted_apply" && request.choiceReceipt.configurationWritten));
  const savedForNextRequest = request.state === "applied" && request.activation.mode === "next_request"
    && (!request.choiceReceipt || (request.choiceReceipt.kind === "persisted_apply" && request.choiceReceipt.configurationWritten));
  const activationModeLabel = request.activation.mode === "next_request" && capabilityId === "memory.enable" ? m.mode.memoryNextRequest
    : request.activation.mode === "next_request" && capabilityId === "security.automatic_configuration" ? m.mode.domainNextRequest
    : request.activation.mode === "next_request" && capabilityId === "web.credential" ? m.mode.webCredentialNextRequest
    : ownMessage(m.mode, request.activation.mode, request.activation.mode);
  const summary = savedForNextRun || savedForRestart || savedForNextRequest ? `${title} · ${m.state.applied} · ${activationModeLabel}`
    : `${title} · ${choiceLabel ?? stateLabel}${request.state === "applied" || request.state === "dismissed" ? ` · ${m.resumption[request.resumption.state]}` : ""}`;
  const activationLabel = capabilityId === "security.approval_mode" && request.activation.state === "active" ? m.sessionApprovalActive
    : capabilityId === "security.network" && request.activation.state === "active" ? m.securityActive
    : ["security.network", "security.approval_mode"].includes(capabilityId) && request.state === "applied" && request.activation.state === "failed" ? m.securityCleanupFailed
    : capabilityId === "security.automatic_configuration" && request.activation.mode === "next_request" && request.activation.state === "needs_user_action" ? m.waitingNextRequest
    : savedForNextRun && request.activation.mode === "next_run" && request.activation.state === "needs_user_action" ? m.waitingNextRun : m.activation[request.activation.state];
  const details = <>
    <p>{reasonText}</p>
    <dl className="configuration-impact">
      <dt>{m.resource}</dt><dd>{impactText("resourceLocation")}</dd>
      <dt>{m.scopeLabel}</dt><dd>{impactText("effectiveScope") || scope}</dd>
      <dt>{m.activationLabel}</dt><dd>{activationModeLabel}</dd>
    </dl>
    <p>{impactText("message")}</p>
    {request.changes.length ? <div className="configuration-diff" aria-label={m.changes}>
      <strong>{m.changes}</strong>
      <ul>{request.changes.map((change, index) => <li key={`${change.field}:${index}`}><strong>{capabilityFieldLabel(change.field, changeFieldLabel(change.field))}</strong>: <span>{changeValue(change.field, change.before)}</span> → <span>{changeValue(change.field, change.after)}</span></li>)}</ul>
    </div> : null}
    <section className="configuration-verification" aria-label={m.verification}>
      <strong>{m.verification}</strong>
      <p>{request.verificationPlan.targets.join(", ") || m.noTargets}</p>
      <p>{request.verificationPlan.actions.join(", ") || m.noActions} · {m.requestBudget}: {request.verificationPlan.maxRequests}</p>
      {request.verificationPlan.mayCharge ? <p className="configuration-charge">{m.mayCharge}</p> : null}
    </section>
    <dl className="configuration-impact configuration-stages" aria-label={m.progress}>
      <dt>{m.saved}</dt><dd>{request.choiceReceipt && !request.choiceReceipt.configurationWritten ? m.noConfigurationWritten : m.state[request.state]}</dd>
      {choiceLabel ? <><dt>{m.selectedChoice}</dt><dd>{choiceLabel}</dd></> : null}
      <dt>{m.activationLabel}</dt><dd>{activationLabel}</dd>
      <dt>{m.resumptionLabel}</dt><dd>{resumptionLabel}</dd>
      {request.decisionSource ? <><dt>{m.decisionSourceLabel}</dt><dd>{m.decisionSource[request.decisionSource]}</dd></> : null}
      {terminal && securityConsent ? <><dt>{m.securityTitle}</dt><dd>{securityReady ? m.securityConfirmed : m.securityRequired}</dd></> : null}
      <dt>{m.updatedAt}</dt><dd><time dateTime={request.updatedAt}>{formattedTime(request.updatedAt)}</time></dd>
    </dl>
    {request.error ? <p className="conversation-configuration-error" role="alert">{request.error.code === "CONFIGURATION_ENDPOINT_INSECURE" ? insecureEndpointCopy : <>{request.error.message} <span>({request.error.code})</span></>}</p> : null}
    {request.state === "stale" ? <p role="status">{m.stale}</p> : null}
    {request.state === "needs_fix" ? <p role="status">{m.needsFix}</p> : null}
  </>;
  async function stopExpiredTask() {
    if (!onStopTask || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await onStopTask(); if (mounted.current) setTaskStopped(true); }
    catch { if (mounted.current) setError(m.requestFailed); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  const expiredTaskControls = request.state === "expired" && request.runId && !["started", "completed"].includes(request.resumption.state) ? <div className="configuration-expired-task" role="status"><p>{taskStopped || request.resumption.state === "suppressed" ? m.stopped : m.expiredTask}</p>{onStopTask && !taskStopped && request.resumption.state !== "suppressed" ? <button type="button" className="secondary-button" disabled={busy || readOnly} onClick={() => void stopExpiredTask()}>{m.stopTask}</button> : null}</div> : null;
  const secondaryActions = <>
    {hasAction("query") || refreshRequired || error ? <button className="secondary-button" disabled={busy} type="button" onClick={() => void perform(async () => {
      setDestructiveAcknowledged(false);
      const next = await actions.query();
      if (mounted.current) { setValues(fieldValues(next)); setSecrets({}); setDirty(false); setRefreshRequired(false); }
      credentialDraft.current = undefined;
      submittedPreview.current = { revision: next.revision, digest: next.previewDigest };
      operationKeys.current.clear();
      return next;
    })}>{m.refresh}</button> : null}
    {hasAction("continue") ? <button className="secondary-button" disabled={busy || runActive || readOnly || mutationsBlocked} type="button" onClick={() => void perform(() => actions.continue(operationKey("continue")))}>{m.retryContinuation}</button> : null}
    {hasAction("reversal") ? <button className="secondary-button" disabled={busy || readOnly || mutationsBlocked} type="button" onClick={() => void perform(() => actions.reversal(operationKey("reversal")))}>{m.reversal}</button> : null}
  </>;
  if (request.settingsConfirmation) {
    const confirmation = request.settingsConfirmation;
    const destination = m.compact.settingsDestination[confirmation.destination];
    const outcome = confirmation.completed ? m.compact.settingsCompleted : m.compact.settingsNotCompleted;
    return <div id={`${idPrefix}-${request.id}`} data-configuration-navigation-record="">
      <ProcessRecord className="conversation-configuration-record" label={`${m.compact.settingsOpened} · ${destination} · ${outcome}`}
        failed={request.resumption.state === "failed"}>
        <section aria-label={destination} className="conversation-configuration-record-details">
          <p>{title}</p><p>{m.compact.settingsReported}</p>
          <p>{m.resumption[request.resumption.state]}</p>
          <div className="conversation-configuration-actions">{secondaryActions}</div>
          {error ? <p role="alert" className="conversation-configuration-error">{error}</p> : null}
        </section>
      </ProcessRecord>
    </div>;
  }
  if (terminal) return <><ProcessRecord className="conversation-configuration-record" label={summary} failed={request.activation.state === "failed" || request.resumption.state === "failed"}>
    <section aria-label={title} className="conversation-configuration-record-details">
      {details}<div className="conversation-configuration-actions">{secondaryActions}</div>
      {error ? <p role="alert" className="conversation-configuration-error">{error}</p> : null}
    </section>
  </ProcessRecord>{expiredTaskControls}</>;
  const settingsOnly = Boolean(compact?.onOpenSettings);
  const settingsDestination = compact?.settingsDestination
    ?? (capabilityId === "model.connect" ? "models" : capabilityId === "timeouts.configure" ? "timeouts" : capabilityId.startsWith("mcp.") ? "mcp" : "proxy");
  if (settingsOnly && settingsOpened) return <section id={`${idPrefix}-${request.id}`} aria-label={title}
    className="conversation-configuration-card configuration-request configuration-request-compact" aria-busy={busy}>
    <div className="conversation-configuration-heading"><h3>{m.compact.settingsDestination[settingsDestination]}</h3></div>
    <p>{m.compact.settingsQuestion}</p>
    <div className="conversation-configuration-actions">
      {[true, false].map(completed => <button key={String(completed)} type="button" className={completed ? "primary-button" : "secondary-button"}
        disabled={busy || readOnly || runActive || mutationsBlocked || refreshRequired || !actions.confirmSettings}
        onClick={() => {
          if (busyRef.current || readOnly || runActive || mutationsBlocked || refreshRequired || !actions.confirmSettings) return;
          void perform(() => actions.confirmSettings!({ revision: request.revision, stateVersion: request.stateVersion,
            destination: settingsDestination, completed }, operationKey(`settings-confirmation:${request.stateVersion}:${completed}`)));
        }}>{completed ? m.compact.settingsCompleted : m.compact.settingsNotCompleted}</button>)}
      {error || refreshRequired ? secondaryActions : null}
    </div>
    {runActive ? <p role="status">{m.waitBoundary}</p> : null}
    {error ? <p role="alert" className="conversation-configuration-error">{m.compact.retryRequired}</p> : null}
  </section>;
  const collapsedEditor = compact?.unsupported;
  const showEditor = !settingsOnly && !collapsedEditor;
  const compactCopy = m.compact;
  const toggleCopy = configurationCompactToggleCopy(request, locale, values.enabled);
  const compactDescription = compact?.connectorRestoration && request.impact.message === "Other sessions stay unchanged. Tool calls retain their own approval policy." ? compactCopy.connectorRestore : toggleCopy ? toggleCopy.description : capabilityId === "model.metadata" && !compact?.destructive ? compactCopy.modelMetadata
    : capabilityId === "settings.inherit" ? compactCopy.inherit
    : capabilityId === "web.configure" ? `${compactCopy.webCosts}${request.activation.mode === "requires_restart" ? ` ${compactCopy.remoteUnverified}` : ""}`
    : ["proxy.provider", "proxy.mcp"].includes(capabilityId) ? compactCopy.proxyRouting
    : capabilityId === "proxy.resources" ? compactCopy.proxyRename
    : ["thinking.configure", "review.configure"].includes(capabilityId) ? compactCopy.modelCosts
    : ["model.select", "timeouts.configure", "quotas.configure", "environment.sources", "idea_tree.configure"].includes(capabilityId) ? ""
    : impactText("message");
  const applyGeneration = editGeneration.current;
  const applyIdentity = previewIdentity(request);
  return <section id={`${idPrefix}-${request.id}`} aria-label={title} className={`conversation-configuration-card configuration-request${compact ? " configuration-request-compact" : ""}`} aria-busy={busy}>
    <div className="conversation-configuration-heading">
      <div>{!compact ? <span className="eyebrow">{m.eyebrow}</span> : null}<h3>{title}</h3></div>
      {!compact ? <span className="conversation-configuration-status" role="status">{m.state[request.state]}</span> : null}
      {!compact && request.protocolVersion === 3 && canDismiss ? <button type="button" className="secondary-button configuration-close" aria-label={m.closeAndReturn}
        title={m.closeAndReturn} disabled={busy || runActive || readOnly || mutationsBlocked} onClick={dismiss}>×</button> : null}
    </div>
    {compact ? <>
      {!settingsOnly && !collapsedEditor ? <>
        <p className="configuration-compact-scope">{compact.targetLabel ? `${compact.targetLabel} · ` : ""}{toggleCopy?.scope ?? (request.impact.effectiveScope === "Every session in this deployment" ? compactCopy.allSessions : impactText("effectiveScope") || scope)} · {ownMessage(compactCopy.mode, request.activation.mode, activationModeLabel)}</p>
        {!securityConsent && (compact.destructive || compactDescription || request.verificationPlan.mayCharge) ? <p className="configuration-compact-description" role={compact.destructive ? "note" : undefined}>
          {compact.destructive && capabilityId !== "settings.inherit" ? `${impactText("message")} ${compactCopy.destructiveWarning}` : compactDescription}
          {request.verificationPlan.mayCharge ? ` ${m.mayCharge}` : ""}
        </p> : null}
        {!compact.connectorAddition && request.changes.some(change => !visibleFields.some(field => field.id === change.field)) ? <p className="configuration-diff" aria-label={m.changes}>{request.changes.filter(change => !visibleFields.some(field => field.id === change.field)).map((change, index) =>
          <ReactFragment key={`${change.field}:${index}`}>{index ? "; " : ""}<strong>{capabilityFieldLabel(change.field, ownMessage(m.field, change.field, changeFieldLabel(change.field)))}</strong>: {changeValue(change.field, change.before)} → {changeValue(change.field, change.after)}</ReactFragment>)}</p> : null}
      </> : !settingsOnly ? <p>{compactCopy.unavailable}</p> : null}
      {showEditor && !error && (request.error || request.state === "stale" || request.state === "needs_fix") ? <p role={request.error ? "alert" : "status"}>
        {request.error ? compactCopy.retryRequired : request.state === "stale" ? compactCopy.stale : compactCopy.needsFix}
      </p> : null}
    </> : details}
    {compact?.unsupported && scheduledAt && remainingSeconds !== undefined ? <p className="configuration-auto-apply" role="status">
      {remainingSeconds > 0 ? m.autoCountdown(remainingSeconds) : m.autoDue}
    </p> : null}
    {showEditor && <>
    {compact?.destructive && capabilityId !== "mcp.delete" ? <label className="configuration-security-ack">
      <input type="checkbox" checked={destructiveAcknowledged} disabled={!editable || runActive || refreshRequired}
        onChange={event => setDestructiveAcknowledged(event.target.checked)} />{m.compact.destructiveAcknowledge}
    </label> : null}
    {securityRequired && !securityConsent ? <p role="alert">{m.securityRequired}</p> : null}
    {securityConsent ? <section className="configuration-endpoint" aria-label={m.securityTitle}>
      {!compact ? <strong>{m.securityTitle}</strong> : null}<p>{securityConsent.statement}</p>
      {!compact ? <p role="status">{securityReady && !dirty ? m.securityConfirmed : m.securityRequired}</p> : securityReady && !dirty ? <p role="status">{compactCopy.securityConfirmed}</p> : null}
      {(!securityReady || securityConsent.status !== "confirmed") && actions.securityConsent ? <>
        <label className="configuration-security-ack" htmlFor={`${id}-security-ack`}>
          <input id={`${id}-security-ack`} type="checkbox" checked={securityAcknowledged}
            disabled={!editable || dirty || runActive || refreshRequired || securityConsent.revision !== request.revision || request.state !== "awaiting_confirmation"}
            onChange={event => setSecurityAcknowledgementTarget(event.target.checked ? { revision: request.revision, targetDigest: securityConsent.targetDigest } : undefined)} />
          <span>{compact ? compactCopy.securityAcknowledge : securityAcknowledgement}</span>
        </label>
        <button type="button" className="secondary-button" disabled={!editable || !securityAcknowledged || dirty || runActive || refreshRequired || securityConsent.revision !== request.revision || request.state !== "awaiting_confirmation"}
          onClick={() => {
            if (!editable || !securityAcknowledged || dirty || runActive || refreshRequired || securityConsent.revision !== request.revision
              || request.state !== "awaiting_confirmation" || busyRef.current) return;
            void perform(async () => {
              const next = await actions.securityConsent!({ revision: request.revision, targetDigest: securityConsent.targetDigest, acknowledged: true }, operationKey(`security:${request.revision}:${securityConsent.targetDigest}`));
              const consent = configurationSecurityConsent(next);
              if (!consent || consent.status !== "confirmed" || next.id !== request.id || next.sessionId !== request.sessionId
                || consent.targetDigest !== securityConsent.targetDigest || consent.revision !== request.revision || next.revision !== request.revision)
                throw new ApiRequestError("", 409);
              return next;
            });
          }}>{compact ? compactCopy.securityConfirm : m.securityConfirm}</button>
      </> : null}
    </section> : null}
    {scheduledAt && remainingSeconds !== undefined ? <div className="configuration-auto-apply" role="status">
      <p>{remainingSeconds > 0 ? m.autoCountdown(remainingSeconds) : m.autoDue}</p>
      <p>{m.scheduledAt}: <time dateTime={scheduledAt}>{formattedTime(scheduledAt)}</time></p>
    </div> : null}
    {authorization ? <section className="configuration-endpoint" aria-label={m.endpoint}>
      <strong>{m.endpoint}: <bdi>{authorization.host}</bdi></strong>
      {authorization.destinations?.length ? <ul>{authorization.destinations.map(destination => <li key={destination.url}><strong>{destination.label}</strong><p><code>{destination.url}</code></p></li>)}</ul> : <p><code>{authorization.endpointTarget}</code></p>}
      {["loopback", "private_network"].includes(authorization.classification) ? <p>{credentialWarnings.endpointLocal}</p> : null}
      {publicPlaintext ? <p>{m.endpointPublicPlaintext}</p> : null}
      <p role="status">{authorization.status === "blocked" ? credentialWarnings.endpointBlocked : endpointReady
        ? ["provider.connection", "provider.credential"].includes(capabilityId) ? m.providerEndpointConfirmed : m.endpointConfirmed
        : ["provider.connection", "provider.credential"].includes(capabilityId) ? m.providerEndpointRequired : m.endpointRequired}</p>
      {authorization.status === "required" && !targetEdited && actions.consent ? <button type="button" className="secondary-button" disabled={busy || readOnly || runActive} onClick={() => void perform(() => actions.consent!({ revision: request.revision, endpointTarget: authorization.endpointTarget }, operationKey(`consent:${request.revision}:${authorization.endpointTarget}`)))}>{m.endpointConsent}</button> : null}
    </section> : null}
    <form className="configuration-fields" onSubmit={(event) => void preview(event)}
      onCompositionStartCapture={() => { composing.current = true; setCompositionActive(true); }}
      onCompositionEndCapture={() => { composing.current = false; setCompositionActive(false); }}
      onKeyDownCapture={event => {
        if (event.key !== "Enter") return;
        // Do not cancel the candidate-selection key or intercept select/click.
        // Only suppress a submit produced by this IME Enter. Some IMEs end
        // composition before Enter and expose only the legacy 229 marker.
        imeSubmitBlocked.current = composing.current || event.nativeEvent.isComposing || event.keyCode === 229;
        if (imeSubmitReset.current !== undefined) clearTimeout(imeSubmitReset.current);
        if (imeSubmitBlocked.current) imeSubmitReset.current = setTimeout(() => {
          imeSubmitBlocked.current = false; imeSubmitReset.current = undefined;
        }, 0);
      }}>
      {request.protocolVersion === 3 && availableChoices.length > 1 ? <fieldset className="configuration-choice-options" disabled={!editable || runActive}>
        <legend>{m.choosePath}</legend>
        {visibleChoices.map(option => <label className={`configuration-choice-option${selectedOptionId === option.id ? " is-selected" : ""}`} key={option.id}>
          <input type="radio" name={`${id}-option`} value={option.id} checked={selectedOptionId === option.id} disabled={!option.available || !editable || runActive}
            onChange={() => void selectOption(option.id)} />
          <span><strong>{describeChoice(option)}</strong><small>{option.description}</small>
            {!option.available ? <small>{option.unavailableReason ?? m.choiceUnavailable}</small> : null}</span>
        </label>)}
      </fieldset> : request.protocolVersion === 3 && !(compact && selectedOption?.kind === "persisted_apply" && availableChoices.length === 1) ? <section className="configuration-choice-options" aria-label={m.choosePath}>
        {!availableChoices.length ? <p role="status">{m.noAvailableChoice}</p> : null}
        {visibleChoices.map(option => <div key={option.id} aria-disabled={!option.available || undefined}>
          <p><strong>{describeChoice(option)}{option.kind === "persisted_apply" ? ` · ${m.scope[request.scope.kind]} · ${activationModeLabel}` : ""}</strong></p>
          {option.kind !== "persisted_apply" ? <p>{option.description}</p> : null}
          {!option.available ? <p>{option.unavailableReason ?? m.choiceUnavailable}</p> : selectedOptionId !== option.id
            ? <button type="button" className="secondary-button" disabled={!editable || runActive} onClick={() => void selectOption(option.id)}>{m.selectChoice}</button> : null}
        </div>)}
      </section> : null}
      {visibleFields.map((field) => {
        const inputId = `${id}-${field.id}`;
        const descriptionId = `${inputId}-help`;
        const translatedLabel = capabilityId === "security.network" && field.id === "mode" ? (locale.startsWith("zh") ? m.field.networkMode! : field.label)
          : capabilityId === "proxy.resources" ? (locale.startsWith("zh") ? changeFieldLabel(field.id) : field.label)
          : ownMessage(m.field, field.id, field.label);
        const removesLimit = field.kind === "number" && values[field.id] === 0
          && (capabilityId === "timeouts.configure" || capabilityId === "quotas.configure" && field.id.endsWith("Bytes"));
        const loadingRemovalName = field.id === dependentRemovalField && values.serverId !== fieldValues(request).serverId;
        const common = { id: inputId, name: field.id, disabled: !(autoPreview ? scalarEditable : editable) || loadingRemovalName || Boolean(lockedFieldIds?.includes(field.id)), required: field.required && !loadingRemovalName,
          "aria-describedby": (!compact && field.description || field.kind === "credential" || compact && removesLimit) ? descriptionId : undefined,
          "aria-invalid": request.error?.field === field.id || errorField === field.id || undefined };
        return <div className="configuration-field" key={field.id}>
          <label htmlFor={inputId}>{capabilityFieldLabel(field.id, translatedLabel ?? field.label)}{field.required ? " *" : ""}</label>
          {field.kind === "credential" ? <>
            {credentialReady ? <input {...common} autoComplete="new-password" type="password" value={secrets[field.id] ?? ""}
              required={false} aria-required={field.required && field.status !== "provided"}
              placeholder={field.status === "provided" ? m.providedPlaceholder : field.placeholder}
              onChange={(event) => edit(field, event.target.value)} /> : <p>{publicPlaintext ? credentialWarnings.endpointBlocked : m.endpointRequired}</p>}
            <p id={descriptionId}>{m.credential[field.status]} · {m.credentialNote}{field.description ? ` ${field.description}` : ""}</p>
          </> : field.kind === "text" && capabilityId === "mcp.metadata" && field.id === "description" ? <textarea {...common} rows={4}
            value={String(values[field.id] ?? "")} placeholder={field.placeholder} onChange={(event) => edit(field, event.target.value)} />
          : field.kind === "multiselect" ? <select {...common} multiple value={Array.isArray(values[field.id]) ? values[field.id] as string[] : []}
            onChange={(event) => edit(field, Array.from(event.target.selectedOptions, option => option.value))}>
            {field.choices?.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
          </select> : field.kind === "enum" ? <select {...common} value={String(values[field.id] ?? "")} onChange={(event) => compact && capabilityId === "model.select" ? void selectCompactModel(field, event.target.value) : edit(field, event.target.value)}>
            <option value="">{m.choose}</option>
            {(["model.connect", "provider.connection"].includes(capabilityId) && field.id === "apiVariant" && typeof values.apiProtocol === "string" && values.apiProtocol in MODEL_API_VARIANTS
              ? MODEL_API_VARIANTS[values.apiProtocol as ModelApiProtocol].map((variant) => ({ id: variant, label: variant })) : field.choices)
              ?.map((choice) => <option key={choice.id} value={choice.id}>{capabilityId === "web.credential" && field.id === "operation"
                ? ownMessage(m.credentialOperation, choice.id, choice.label)
                : capabilityId === "security.approval_mode" && field.id === "approvalMode" && locale.startsWith("zh")
                  ? choice.id === "always_allow" ? "始终允许当前会话后续合格动作" : "危险动作前询问"
                : locale.startsWith("zh") && capabilityId === "proxy.resources" && ["operation", "kind"].includes(field.id)
                  ? ownMessage({ create: "新建", update: "修改", delete: "删除", custom_url: "自定义 URL", environment: "环境代理", system: "系统代理" }, choice.id, choice.label)
                  : choice.label}</option>)}
          </select> : field.kind === "boolean" ? <input {...common} required={false} type="checkbox" checked={values[field.id] === true && (!(compact?.destructive && field.id === "confirmDelete") || destructiveAcknowledged)} onChange={(event) => {
              if (compact?.destructive && field.id === "confirmDelete") setDestructiveAcknowledged(event.target.checked);
              edit(field, event.target.checked);
            }} />
            : <input {...common} type={field.kind === "number" ? "number" : field.kind === "url" ? "url" : "text"}
              value={values[field.id] === undefined ? "" : String(values[field.id])} placeholder={field.placeholder}
              onChange={(event) => edit(field, field.kind === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)} />}
          {compact && removesLimit
            ? <p id={descriptionId}>{capabilityId === "timeouts.configure" ? compactCopy.noLimit : compactCopy.noSizeLimit}</p> : null}
          {!compact && field.kind !== "credential" && field.description ? <p id={descriptionId}>{field.description}</p> : null}
          {!compact && field.help && /^https?:\/\//i.test(field.help.url) ? <a href={field.help.url} target="_blank" rel="noreferrer noopener">{field.help.label}</a> : null}
        </div>;
      })}
      {compactNoChange && !dirty ? <p role="status">{compactCopy.alreadySet}</p> : null}
      {dirty && !autoPreview ? <p role="status">{compact ? compactCopy.previewRequired : m.previewRequired}</p> : null}
      <div className="conversation-configuration-actions">
        {hasAction("preview") && !scheduledAt && !autoPreview && (!compact || dirty || refreshRequired || request.state !== "awaiting_confirmation") ? <button type="submit" className="secondary-button" disabled={busy || runActive || refreshRequired || readOnly || mutationsBlocked}>{compact ? compactCopy.preview : m.preview}</button> : null}
        {hasAction("apply") || compactNoChange || pendingNoChange ? <button type="button" className="primary-button" disabled={busy || !canApply} onClick={() => { if (canApply && mounted.current && !busyRef.current
          && (!compact || latestWriteAllowed.current && applyGeneration === editGeneration.current && applyIdentity === previewIdentity(latestRequest.current))
          && (!compact?.destructive || latestDestructiveIdentity.current === currentDestructiveIdentity && latestDestructiveAcknowledgement.current === currentDestructiveIdentity)) void perform(() => actions.decide({ revision: request.revision, previewDigest: request.previewDigest!, decision: selectedOption?.kind === "dismiss" ? "dismiss" : "apply",
          ...(request.protocolVersion === 3 ? { selectedOptionId } : {}) }, operationKey("apply"))); }}>{compact ? compactCopy.confirm : request.protocolVersion === 3 ? m.confirmChoice : m.confirm}</button> : null}
        {canDismiss ? <button type="button" className="secondary-button" disabled={busy || readOnly || mutationsBlocked || runActive} onClick={dismiss}>{compact ? compactCopy.cancel : scheduledAt ? m.cancelChange : request.protocolVersion === 3 ? m.declineAndReturn : m.dismiss}</button> : null}
        {secondaryActions}
      </div>
    </form>
    </>}
    {!showEditor ? <div className="conversation-configuration-actions">
      {settingsOnly ? <button type="button" className="primary-button" disabled={busy || readOnly || mutationsBlocked} onClick={() => {
        if (busy || readOnly || mutationsBlocked || !compact?.onOpenSettings) return;
        compact.onOpenSettings();
        setOpenedSettingsKey(settingsOpenedKey);
        try { globalThis.sessionStorage?.setItem(settingsOpenedKey, "1"); } catch { /* Navigation still works when storage is unavailable. */ }
      }}>{compactCopy.settings}</button>
        : null}
      {!settingsOnly && canDismiss ? <button type="button" className="secondary-button" disabled={busy || readOnly || mutationsBlocked || runActive} onClick={dismiss}>{scheduledAt ? compactCopy.cancel : compactCopy.close}</button> : null}
      {!settingsOnly ? secondaryActions : null}
    </div> : null}
    {showEditor && runActive ? <p role="status">{m.waitBoundary}</p> : null}
    {error ? <p role="alert" className="conversation-configuration-error">{compact ? compactCopy.retryRequired : error}</p> : null}
  </section>;
}

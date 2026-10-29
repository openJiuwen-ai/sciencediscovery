// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { DEFAULT_MODEL_API_VARIANT, MODEL_API_VARIANTS, type ModelApiProtocol } from "@sciencediscovery/schema";
import type { ConfigurationAction, ConfigurationCredentialDraftView, ConfigurationCredentialInput, ConfigurationDecisionInput,
  ConfigurationFieldView, ConfigurationPreviewInput, ConfigurationRequestView, ConfigurationScalar, ConfigurationValues } from "@sciencediscovery/schema";
import { ApiRequestError } from "../api/auth.js";
import { useLocale } from "../i18n/index.js";
import { ProcessRecord } from "../ProcessRecord.js";
import { configurationMessages } from "./messages.js";

export interface ConfigurationRequestActions {
  consent?(input: { revision: number; endpointTarget: string }, key: string): Promise<ConfigurationRequestView>;
  preview(input: ConfigurationPreviewInput, key: string): Promise<ConfigurationRequestView>;
  credential(input: ConfigurationCredentialInput, key: string): Promise<ConfigurationCredentialDraftView>;
  decide(input: ConfigurationDecisionInput, key: string): Promise<ConfigurationRequestView>;
  query(): Promise<ConfigurationRequestView>;
  continue(key: string): Promise<ConfigurationRequestView>;
  reversal(key: string): Promise<ConfigurationRequestView>;
}

function fieldValues(request: ConfigurationRequestView): ConfigurationValues {
  return Object.fromEntries(request.fields.flatMap((field) => field.kind !== "credential" && field.value !== undefined
    ? [[field.id, field.value]] : []));
}

export function isConfigurationRequestView(request: object): request is ConfigurationRequestView {
  return "capabilityId" in request;
}

/** The form is driven exclusively by the server's registered schema. Secrets and
 * credential handles are component-local, never written into timeline snapshots. */
export function ConfigurationRequestCard({ request, actions, runActive: sourceRunActive = false, readOnly = false, onUpdate, onUnavailable, onStopTask }: {
  request: ConfigurationRequestView;
  actions: ConfigurationRequestActions;
  runActive?: boolean;
  readOnly?: boolean;
  onUpdate: (request: ConfigurationRequestView) => void;
  onUnavailable?: () => void;
  onStopTask?: () => Promise<void>;
}) {
  const runActive = sourceRunActive && request.liveWait !== true;
  const { locale } = useLocale();
  const m = configurationMessages(locale);
  const id = useId();
  const [values, setValues] = useState(() => fieldValues(request));
  const [selectedOptionId, setSelectedOptionId] = useState(request.selectedOptionId);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
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
  const mounted = useRef(true);
  const latestRequest = useRef(request);
  const targetFields = ["baseUrl", "apiProtocol", "apiVariant", "modelId", "model"];
  const targetIdentity = (view: ConfigurationRequestView) => JSON.stringify([view.endpointAuthorization?.endpointTarget ?? "", ...targetFields.map(key => fieldValues(view)[key] ?? "")]);
  const previousTarget = useRef(targetIdentity(request));
  const previousRequestId = useRef(request.id);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; credentialDraft.current = undefined; }; }, []);
  useEffect(() => {
    const targetChanged = previousRequestId.current !== request.id || previousTarget.current !== targetIdentity(request);
    previousRequestId.current = request.id;
    previousTarget.current = targetIdentity(request);
    latestRequest.current = request;
    if (!busyRef.current) setValues(fieldValues(request));
    setSelectedOptionId(request.selectedOptionId);
    if (targetChanged || ["applied", "dismissed", "cancelled", "expired"].includes(request.state)) setSecrets({});
    if (!busyRef.current) {
      // A background snapshot must not silently approve a replacement key that
      // is still only present in this browser's form.
      setDirty(!targetChanged && Object.values(secrets).some(Boolean));
      setRefreshRequired(false);
    }
    setMutationsBlocked(false);
    setErrorField(undefined);
    if (targetChanged) { credentialDraft.current = undefined; operationKeys.current.clear(); }
  }, [request.id, request.revision, request.state, request.endpointAuthorization?.endpointTarget]);
  useEffect(() => {
    if (!request.autoApplyAt || request.state !== "awaiting_confirmation") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [request.autoApplyAt, request.state]);
  const hasAction = (action: ConfigurationAction) => request.allowedActions.includes(action);
  const choices = request.protocolVersion === 3 ? request.options ?? [] : [];
  const visibleChoices = choices.filter(option => option.kind !== "dismiss");
  const availableChoices = visibleChoices.filter(option => option.available);
  const selectedOption = choices.find(option => option.id === selectedOptionId && option.available);
  const dismissOption = choices.find(option => option.kind === "dismiss" && option.available);
  const canDismiss = hasAction("dismiss") && (request.protocolVersion !== 3 || Boolean(dismissOption));
  const terminal = ["applied", "dismissed", "cancelled", "expired"].includes(request.state);
  const authorization = request.endpointAuthorization;
  const targetEdited = targetFields.some(key => JSON.stringify(values[key] ?? "") !== JSON.stringify(fieldValues(request)[key] ?? ""));
  const needsEndpoint = ["model.connect", "model.repair_credential"].includes(request.capabilityId);
  const endpointReady = authorization ? !targetEdited && ["trusted", "confirmed"].includes(authorization.status) : !needsEndpoint;
  const credentialReady = endpointReady && authorization?.classification !== "public_http";
  const editable = hasAction("preview") && !terminal && !busy && !readOnly && !mutationsBlocked
    && !(request.state === "awaiting_confirmation" && request.autoApplyAt);
  const canApply = hasAction("apply") && request.state === "awaiting_confirmation"
    && endpointReady && Boolean(request.previewDigest) && !dirty && !refreshRequired && !runActive && !readOnly && !mutationsBlocked
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
      submittedPreview.current = { revision: -1 };
    }
    latestRequest.current = next;
    previousTarget.current = targetIdentity(next);
    if (mounted.current) { setValues(fieldValues(next)); onUpdate(next); }
    return targetChanged;
  }
  function edit(field: ConfigurationFieldView, value: ConfigurationScalar | string[]) {
    setDirty(true);
    setError(undefined);
    setErrorField(undefined);
    operationKeys.current.clear();
    credentialDraft.current = undefined;
    if (field.kind === "credential") {
      setSecrets((current) => ({ ...current, [field.id]: String(value) }));
    } else { if (targetFields.includes(field.id)) setSecrets({}); setValues((current) => ({ ...current, [field.id]: value,
      ...(request.capabilityId === "model.connect" && field.id === "apiProtocol" && typeof value === "string" && value in MODEL_API_VARIANTS
        ? { apiVariant: DEFAULT_MODEL_API_VARIANT[value as ModelApiProtocol] } : {}) })); }
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
  async function perform(work: () => Promise<ConfigurationRequestView>, credentialRetry = () => false) {
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
      accept(next);
    } catch (reason) {
      if (!mounted.current) return;
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
        setError(m.invalidInput);
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
        if (focusId && typeof requestAnimationFrame !== "undefined") requestAnimationFrame(() => {
          if (mounted.current && focusTarget === previousTarget.current && document.activeElement === document.body)
            document.getElementById(focusId)?.focus({ preventScroll: true });
        });
      }
    }
  }
  async function preview(event: FormEvent) {
    event.preventDefault();
    if (!editable || runActive) return;
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
          setDirty(true); setError(m.destinationChanged); return target;
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
      credentialDraft.current = undefined;
      if (mounted.current) { setDirty(false); setRefreshRequired(false); }
      return next;
    }, () => uploading);
  }
  const title = m.capability[request.capabilityId] ?? request.capabilityId;
  const scope = `${m.scope[request.scope.kind]}${request.scope.kind !== "global" ? ` · ${request.scope.id}` : ""}`;
  const describeChoice = (option: { kind: keyof typeof m.choiceKind; alternativeId?: string; label: string }) => locale.startsWith("zh")
    ? `${m.choiceKind[option.kind]}${option.kind === "alternative" ? ` · ${option.alternativeId === "web-search" ? m.webSearchAlternative : option.label}` : ""}` : option.label;
  const choiceLabel = request.choiceReceipt ? describeChoice(request.choiceReceipt) : undefined;
  const reasonText = request.reason.message === "CONNECTOR_REQUIRED_FOR_TASK" ? m.connectorNeeded : request.reason.message;
  const resumptionLabel = request.runId && !terminal && request.resumption.state === "not_requested" ? m.waitingChoice : m.resumption[request.resumption.state];
  const stateLabel = request.choiceReceipt && !request.choiceReceipt.configurationWritten ? m.choiceCompleted : m.state[request.state];
  const savedForNextRun = request.state === "applied" && request.activation.mode === "next_run" && !request.runId
    && (!request.choiceReceipt || (request.choiceReceipt.kind === "persisted_apply" && request.choiceReceipt.configurationWritten));
  const summary = savedForNextRun ? `${title} · ${m.state.applied} · ${m.mode.next_run}`
    : `${title} · ${choiceLabel ?? stateLabel}${request.state === "applied" || request.state === "dismissed" ? ` · ${m.resumption[request.resumption.state]}` : ""}`;
  const activationLabel = savedForNextRun && request.activation.state === "needs_user_action"
    ? m.waitingNextRun : m.activation[request.activation.state];
  const details = <>
    <p>{reasonText}</p>
    <dl className="configuration-impact">
      <dt>{m.resource}</dt><dd>{request.impact.resourceLocation}</dd>
      <dt>{m.scopeLabel}</dt><dd>{request.impact.effectiveScope || scope}</dd>
      <dt>{m.activationLabel}</dt><dd>{m.mode[request.activation.mode]}</dd>
    </dl>
    <p>{request.impact.message}</p>
    {request.changes.length ? <div className="configuration-diff" aria-label={m.changes}>
      <strong>{m.changes}</strong>
      <ul>{request.changes.map((change, index) => <li key={`${change.field}:${index}`}><strong>{change.field}</strong>: <span>{change.before ?? m.unset}</span> → <span>{change.after ?? m.unset}</span></li>)}</ul>
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
      <dt>{m.updatedAt}</dt><dd><time dateTime={request.updatedAt}>{formattedTime(request.updatedAt)}</time></dd>
    </dl>
    {request.error ? <p className="conversation-configuration-error" role="alert">{request.error.message} <span>({request.error.code})</span></p> : null}
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
  if (terminal) return <><ProcessRecord className="conversation-configuration-record" label={summary} failed={request.activation.state === "failed" || request.resumption.state === "failed"}>
    <section aria-label={title} className="conversation-configuration-record-details">
      {details}<div className="conversation-configuration-actions">{secondaryActions}</div>
      {error ? <p role="alert" className="conversation-configuration-error">{error}</p> : null}
    </section>
  </ProcessRecord>{expiredTaskControls}</>;
  return <section id={`configuration-request-${request.id}`} aria-label={title} className="conversation-configuration-card configuration-request" aria-busy={busy}>
    <div className="conversation-configuration-heading">
      <div><span className="eyebrow">{m.eyebrow}</span><h3>{title}</h3></div>
      <span className="conversation-configuration-status" role="status">{m.state[request.state]}</span>
      {request.protocolVersion === 3 && canDismiss ? <button type="button" className="secondary-button configuration-close" aria-label={m.closeAndReturn}
        title={m.closeAndReturn} disabled={busy || runActive || readOnly || mutationsBlocked} onClick={dismiss}>×</button> : null}
    </div>
    {details}
    {scheduledAt && remainingSeconds !== undefined ? <div className="configuration-auto-apply" role="status">
      <p>{remainingSeconds > 0 ? m.autoCountdown(remainingSeconds) : m.autoDue}</p>
      <p>{m.scheduledAt}: <time dateTime={scheduledAt}>{formattedTime(scheduledAt)}</time></p>
    </div> : null}
    {authorization ? <section className="configuration-endpoint" aria-label={m.endpoint}>
      <strong>{m.endpoint}: <bdi>{authorization.host}</bdi></strong>
      <p><code>{authorization.endpointTarget}</code></p>
      {["loopback", "private_network"].includes(authorization.classification) ? <p>{m.endpointLocal}</p> : null}
      <p role="status">{authorization.status === "blocked" ? m.endpointBlocked : endpointReady ? m.endpointConfirmed : m.endpointRequired}</p>
      {authorization.status === "required" && !targetEdited && actions.consent ? <button type="button" className="secondary-button" disabled={busy || readOnly || runActive} onClick={() => void perform(() => actions.consent!({ revision: request.revision, endpointTarget: authorization.endpointTarget }, operationKey(`consent:${request.revision}:${authorization.endpointTarget}`)))}>{m.endpointConsent}</button> : null}
    </section> : null}
    <form className="configuration-fields" onSubmit={(event) => void preview(event)}>
      {request.protocolVersion === 3 && availableChoices.length > 1 ? <fieldset className="configuration-choice-options" disabled={!editable || runActive}>
        <legend>{m.choosePath}</legend>
        {visibleChoices.map(option => <label className={`configuration-choice-option${selectedOptionId === option.id ? " is-selected" : ""}`} key={option.id}>
          <input type="radio" name={`${id}-option`} value={option.id} checked={selectedOptionId === option.id} disabled={!option.available || !editable || runActive}
            onChange={() => void selectOption(option.id)} />
          <span><strong>{describeChoice(option)}</strong><small>{option.description}</small>
            {!option.available ? <small>{option.unavailableReason ?? m.choiceUnavailable}</small> : null}</span>
        </label>)}
      </fieldset> : request.protocolVersion === 3 ? <section className="configuration-choice-options" aria-label={m.choosePath}>
        {!availableChoices.length ? <p role="status">{m.noAvailableChoice}</p> : null}
        {visibleChoices.map(option => <div key={option.id} aria-disabled={!option.available || undefined}>
          <p><strong>{describeChoice(option)}{option.kind === "persisted_apply" ? ` · ${m.scope[request.scope.kind]} · ${m.mode[request.activation.mode]}` : ""}</strong></p>
          {option.kind !== "persisted_apply" ? <p>{option.description}</p> : null}
          {!option.available ? <p>{option.unavailableReason ?? m.choiceUnavailable}</p> : selectedOptionId !== option.id
            ? <button type="button" className="secondary-button" disabled={!editable || runActive} onClick={() => void selectOption(option.id)}>{m.selectChoice}</button> : null}
        </div>)}
      </section> : null}
      {request.fields.map((field) => {
        const inputId = `${id}-${field.id}`;
        const descriptionId = `${inputId}-help`;
        const common = { id: inputId, name: field.id, disabled: !editable, required: field.required,
          "aria-describedby": field.description || field.kind === "credential" ? descriptionId : undefined,
          "aria-invalid": request.error?.field === field.id || errorField === field.id || undefined };
        return <div className="configuration-field" key={field.id}>
          <label htmlFor={inputId}>{locale.startsWith("zh") ? m.field[field.id] ?? field.label : field.label}{field.required ? " *" : ""}</label>
          {field.kind === "credential" ? <>
            {credentialReady ? <input {...common} autoComplete="new-password" type="password" value={secrets[field.id] ?? ""}
              required={false} aria-required={field.required && field.status !== "provided"}
              placeholder={field.status === "provided" ? m.providedPlaceholder : field.placeholder}
              onChange={(event) => edit(field, event.target.value)} /> : <p>{authorization?.classification === "public_http" ? m.endpointBlocked : m.endpointRequired}</p>}
            <p id={descriptionId}>{m.credential[field.status]} · {m.credentialNote}{field.description ? ` ${field.description}` : ""}</p>
          </> : field.kind === "multiselect" ? <select {...common} multiple value={Array.isArray(values[field.id]) ? values[field.id] as string[] : []}
            onChange={(event) => edit(field, Array.from(event.target.selectedOptions, option => option.value))}>
            {field.choices?.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
          </select> : field.kind === "enum" ? <select {...common} value={String(values[field.id] ?? "")} onChange={(event) => edit(field, event.target.value)}>
            <option value="">{m.choose}</option>
            {(request.capabilityId === "model.connect" && field.id === "apiVariant" && typeof values.apiProtocol === "string" && values.apiProtocol in MODEL_API_VARIANTS
              ? MODEL_API_VARIANTS[values.apiProtocol as ModelApiProtocol].map((variant) => ({ id: variant, label: variant })) : field.choices)
              ?.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
          </select> : field.kind === "boolean" ? <input {...common} required={false} type="checkbox" checked={values[field.id] === true} onChange={(event) => edit(field, event.target.checked)} />
            : <input {...common} type={field.kind === "number" ? "number" : field.kind === "url" ? "url" : "text"}
              value={values[field.id] === undefined ? "" : String(values[field.id])} placeholder={field.placeholder}
              onChange={(event) => edit(field, field.kind === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)} />}
          {field.kind !== "credential" && field.description ? <p id={descriptionId}>{field.description}</p> : null}
          {field.help && /^https?:\/\//i.test(field.help.url) ? <a href={field.help.url} target="_blank" rel="noreferrer noopener">{field.help.label}</a> : null}
        </div>;
      })}
      {dirty ? <p role="status">{m.previewRequired}</p> : null}
      <div className="conversation-configuration-actions">
        {hasAction("preview") && !scheduledAt ? <button type="submit" className="secondary-button" disabled={busy || runActive || refreshRequired || readOnly || mutationsBlocked}>{m.preview}</button> : null}
        {hasAction("apply") ? <button type="button" className="primary-button" disabled={busy || !canApply} onClick={() => { if (canApply) void perform(() => actions.decide({ revision: request.revision, previewDigest: request.previewDigest!, decision: selectedOption?.kind === "dismiss" ? "dismiss" : "apply",
          ...(request.protocolVersion === 3 ? { selectedOptionId } : {}) }, operationKey("apply"))); }}>{request.protocolVersion === 3 ? m.confirmChoice : m.confirm}</button> : null}
        {canDismiss ? <button type="button" className="secondary-button" disabled={busy || readOnly || mutationsBlocked || runActive} onClick={dismiss}>{scheduledAt ? m.cancelChange : request.protocolVersion === 3 ? m.declineAndReturn : m.dismiss}</button> : null}
        {secondaryActions}
      </div>
    </form>
    {runActive ? <p role="status">{m.waitBoundary}</p> : null}
    {error ? <p role="alert" className="conversation-configuration-error">{error}</p> : null}
  </section>;
}

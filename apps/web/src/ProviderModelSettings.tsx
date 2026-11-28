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

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import type {
  CreateProviderModelRequest,
  ModelApiProtocol,
  ModelApiVariant,
  ModelCatalogDetails,
  ModelCatalogEntry,
  ModelDiscoveryStrategy,
  ModelProfile,
  ModelProvider,
  ModelProviderPreset,
  ModelProviderPresetId,
  ProviderModelEntry,
  ProviderModelList,
  ProxyPolicy,
  ProxySettingsDetails,
} from "@sciencediscovery/schema";
import {
  DEFAULT_MODEL_API_VARIANT,
  DEFAULT_MODEL_DISCOVERY,
  lookupModelCatalog,
  MODEL_API_VARIANTS,
  resolveModelFacts,
} from "@sciencediscovery/schema";

import type { SettingsApiClient } from "./api/settings.js";
import { isAuthFailure } from "./api/auth.js";
import { ModelConnectivityButton } from "./ModelConnectivityButton.js";
import { ModelDeletionDialog } from "./ModelDeletionDialog.js";
import { ModelConnectWizard } from "./ModelConnectWizard.js";
import {
  EMPTY_MANUAL_MODEL,
  ManualModelFields,
  manualModelRequest,
  mergedFact,
  ModelRowFacts,
  type ManualModelForm,
} from "./ProviderModelFields.js";
import { ProxyPolicySelect } from "./ProxySettingsEditor.js";
import { useLocale } from "./i18n/index.js";

export { compactTokenCount, parseEffortList, prefillManualFromCatalog, type ManualModelForm } from "./ProviderModelFields.js";

interface ProviderDraft {
  apiProtocol: ModelApiProtocol;
  apiToken: string;
  apiVariant: ModelApiVariant;
  baseUrl: string;
  modelDiscovery: ModelDiscoveryStrategy;
  name: string;
  presetId?: ModelProviderPresetId;
  providerId?: string;
  proxyPolicy: ProxyPolicy;
  removeToken: boolean;
  tokenOptional: boolean;
}

function providerDraft(provider: ModelProvider): ProviderDraft {
  return {
    apiProtocol: provider.apiProtocol,
    apiToken: "",
    apiVariant: provider.apiVariant,
    baseUrl: provider.baseUrl,
    modelDiscovery: provider.modelDiscovery,
    name: provider.name,
    presetId: provider.presetId,
    providerId: provider.id,
    proxyPolicy: provider.proxyPolicy,
    removeToken: false,
    tokenOptional: provider.tokenOptional,
  };
}

function tokenCount(value: number | undefined, unknown: string): string {
  return value === undefined ? unknown : new Intl.NumberFormat().format(value);
}

export function canonicalSourceUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    return parsed.toString();
  } catch {
    return value.replace(/\/+$/u, "");
  }
}

export function sourceDate(value: string): string {
  const match = value.match(/^\d{4}-\d{2}-\d{2}/u);
  return match?.[0] ?? value;
}

export function providerOperationError(
  reason: unknown,
  fallback: string,
  referencedProviderMessage: string,
): string | Error {
  if (reason instanceof Error && isAuthFailure(reason)) return reason;
  const detail = reason instanceof Error ? reason.message : "";
  if (detail.includes("Provider models are referenced by runtime settings")) {
    return referencedProviderMessage;
  }
  return detail ? `${fallback}: ${detail}` : fallback;
}

export interface ProviderModelSettingsHandle {
  hasUnsavedDraft: () => boolean;
  saveDraft: () => Promise<boolean>;
}

interface ProviderListingRequest {
  providerId: string;
  sequence: number;
}

export function createProviderListingRequestGuard() {
  let sequence = 0;
  return {
    begin(providerId: string): ProviderListingRequest {
      sequence += 1;
      return { providerId, sequence };
    },
    invalidate(): void {
      sequence += 1;
    },
    isCurrent(request: ProviderListingRequest, providerId: string): boolean {
      return request.sequence === sequence && request.providerId === providerId;
    },
  };
}

function draftFingerprint(draft: ProviderDraft | undefined): string {
  return draft ? JSON.stringify(draft) : "";
}

export function PriceSummary({ model }: { model: ProviderModelEntry }) {
  const { t } = useLocale();
  const pricing = model.remote?.pricing ?? model.catalog?.pricing;
  if (!pricing) return <span>{t("providers.metadata.unknown")}</span>;
  if (pricing.periods?.length) {
    return <span className="provider-model-price-periods">
      {pricing.periods.map((period) => <span key={period.id}>
        {t(`providers.metadata.pricePeriod.${period.id}`)}: {pricing.currency} {period.input} / {period.output}
        {period.cachedInput !== undefined ? ` · ${t("providers.metadata.cachedInput")} ${period.cachedInput}` : ""}
        {` · ${t("providers.metadata.perMillion")} · ${period.schedule.kind === "weekdays"
          ? t("providers.metadata.priceSchedule.weekdays", {
              intervals: period.schedule.intervals.map(({ end, start }) => `${start}–${end}`).join(", "),
            })
          : t("providers.metadata.priceSchedule.remainder")}`}
      </span>)}
    </span>;
  }
  return <span>
    {pricing.currency} {pricing.input} / {pricing.output} · {t("providers.metadata.perMillion")}
    {pricing.cachedInput !== undefined ? ` · ${t("providers.metadata.cachedInput")} ${pricing.cachedInput}` : ""}
  </span>;
}

/** Added models first (they are what the user acts on), then alphabetical. */
export function sortProviderModels(entries: readonly ProviderModelEntry[]): ProviderModelEntry[] {
  return [...entries].toSorted((left, right) =>
    Number(Boolean(right.profileId)) - Number(Boolean(left.profileId))
    || (left.displayName ?? left.catalog?.label ?? left.id).localeCompare(right.displayName ?? right.catalog?.label ?? right.id));
}

/** The inline table is the union of already-added profiles and the pulled
 *  listing: an added model always keeps its row (and sorts first), listing
 *  entries not yet added follow. This is what keeps a manually registered
 *  model visible after save/refresh even when discovery returns nothing
 *  (manual strategy with no curated suggestions). */
export function mergeProviderModelRows(
  listingModels: readonly ProviderModelEntry[] | undefined,
  addedProfiles: readonly ModelProfile[],
  provider: ModelProvider,
): ProviderModelEntry[] {
  const byId = new Map<string, ProviderModelEntry>();
  for (const profile of addedProfiles) {
    const catalog = lookupModelCatalog(profile.model, provider.presetId);
    byId.set(profile.model, {
      id: profile.model,
      displayName: profile.name,
      profileId: profile.id,
      // The profile's vision is itself a user decision; surface it like a
      // reported fact so the badge matches what runs will actually get.
      remote: { vision: profile.vision },
      ...(profile.facts ? { user: profile.facts } : {}),
      ...(catalog ? { catalog } : {}),
    });
  }
  for (const entry of listingModels ?? []) {
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, entry);
      continue;
    }
    // The listing describes the vendor's model; the profile row carries what
    // this installation decided about it. Neither replaces the other. A fact
    // the user stated has to survive the moment a listing row for the same id
    // arrives — otherwise adding a model to a provider that already listed its
    // models would blank the hover card until the next refresh.
    const vision = existing.remote?.vision ?? entry.remote?.vision;
    const remote = { ...entry.remote, ...(vision !== undefined ? { vision } : {}) };
    byId.set(entry.id, {
      ...entry,
      catalog: entry.catalog ?? existing.catalog,
      displayName: entry.displayName ?? existing.displayName,
      profileId: entry.profileId ?? existing.profileId,
      ...(Object.keys(remote).length ? { remote } : {}),
      // The saved profile is the fresher copy: it is what the add just wrote.
      ...(existing.user ?? entry.user ? { user: existing.user ?? entry.user } : {}),
    });
  }
  return sortProviderModels([...byId.values()]);
}

/** Profiles are stored as "Provider · model label". The provider table already
 *  supplies that context, so only the model-owned part belongs in the row. */
export function providerModelDisplayName(model: ProviderModelEntry, provider: ModelProvider): string {
  if (model.catalog?.label) return model.catalog.label;
  const name = model.displayName ?? model.id;
  const prefix = `${provider.name} · `;
  if (name.startsWith(prefix)) return name.slice(prefix.length);
  const separator = model.profileId ? name.indexOf(" · ") : -1;
  return separator >= 0 ? name.slice(separator + 3) : name;
}

/** Place row facts in viewport coordinates and flip the card above bottom
 *  rows so the complete card remains inside the viewport. The rendered card
 *  is portalled to document.body; fixed positioning alone cannot escape the
 *  settings dialog's backdrop-filter containing block and overflow chain. */
export function providerModelPopupStyle(
  anchor: { bottom: number; left: number; top: number },
  width = 320,
  estimatedHeight = 240,
  viewport = { height: window.innerHeight, width: window.innerWidth },
): CSSProperties {
  const popupWidth = Math.min(width, viewport.width - 16);
  const left = Math.max(8, Math.min(anchor.left, viewport.width - popupWidth - 8));
  const flip = anchor.bottom + estimatedHeight > viewport.height;
  return flip
    ? { bottom: viewport.height - anchor.top + 4, left, position: "fixed", width: popupWidth }
    : { left, position: "fixed", top: anchor.bottom + 4, width: popupWidth };
}

/** Rich hover card for one provider model row: everything the compact badges
 *  abbreviate, with full numbers and the fact's origin. Replaces native
 *  `title` tooltips. */
function ModelRowPopup({
  model,
  provider,
  style,
}: {
  model: ProviderModelEntry;
  provider: ModelProvider;
  style?: CSSProperties | undefined;
}) {
  const { t } = useLocale();
  const unknown = t("providers.metadata.unknown");
  const resolved = resolveModelFacts(model);
  const vision = mergedFact(model.remote?.vision, model.catalog?.vision);
  const thinking = resolved.thinkingSupported ?? model.catalog?.thinking?.supported;
  const efforts = model.user?.thinkingEfforts ?? model.catalog?.thinking?.efforts;
  const pricing = resolved.pricing;
  // Any fact the user stated makes this card theirs, not just a context window
  // or a price; the conversation picker already reads it this way.
  const origin = Object.values(resolved.origins).includes("user")
    ? t("providers.facts.originUser")
    : model.remote ? t("providers.models.remote") : t("providers.models.catalog");
  return <div className="provider-model-popup" role="tooltip" {...(style ? { style } : {})}>
    <strong>{providerModelDisplayName(model, provider)}</strong>
    <code>{model.id}</code>
    <dl>
      <div><dt>{t("providers.metadata.context")}</dt><dd>{tokenCount(resolved.contextWindow, unknown)}</dd></div>
      <div><dt>{t("providers.metadata.output")}</dt><dd>{tokenCount(resolved.maxOutputTokens, unknown)}</dd></div>
      <div><dt>{t("providers.metadata.vision")}</dt><dd>{vision === undefined ? unknown : vision ? t("common.yes") : t("common.no")}</dd></div>
      <div><dt>{t("providers.metadata.thinking")}</dt><dd>{thinking === undefined ? unknown : thinking ? (efforts?.length ? efforts.join(" / ") : t("common.yes")) : t("common.no")}</dd></div>
      <div><dt>{t("providers.metadata.price")}</dt><dd>{pricing
        ? `${pricing.currency} ${pricing.input} / ${pricing.output}${pricing.cachedInput !== undefined ? ` / ${pricing.cachedInput}` : ""} · ${t("providers.metadata.perMillion")}`
        : unknown}</dd></div>
      <div><dt>{t("providers.facts.source")}</dt><dd>{origin}</dd></div>
    </dl>
  </div>;
}

function ProviderModelRow({
  busy,
  model,
  onDeleteModel,
  provider,
}: {
  busy: boolean;
  model: ProviderModelEntry;
  onDeleteModel: (profileId: string) => void;
  provider: ModelProvider;
}) {
  const { t } = useLocale();
  const [anchor, setAnchor] = useState<DOMRect>();
  return <div
    className="provider-model-row"
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAnchor(undefined);
    }}
    onFocus={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
    onMouseEnter={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
    onMouseLeave={() => setAnchor(undefined)}
    role="row"
  >
    <span className="provider-model-cell-name">
      <strong>{providerModelDisplayName(model, provider)}</strong>
      <code>{model.id}</code>
    </span>
    <ModelRowFacts model={model} />
    {anchor && typeof document !== "undefined"
      ? createPortal(
        <ModelRowPopup model={model} provider={provider} style={providerModelPopupStyle(anchor)} />,
        document.body,
      )
      : null}
    {model.profileId
      ? <button className="danger-button compact-button" disabled={busy} onClick={() => onDeleteModel(model.profileId!)} type="button">{t("common.delete")}</button>
      : null}
  </div>;
}

/** The model catalog header: when the shared metadata was last updated and a
 *  way to update it now. Refreshing only replaces the catalog, never the
 *  provider or model form the user may be part-way through. */
export function ModelCatalogStatus({ catalog, client, onCatalogChange, onError, onNotice }: {
  catalog?: ModelCatalogDetails;
  client: SettingsApiClient;
  onCatalogChange?: (details: ModelCatalogDetails) => void;
  onError: (reason: string | Error) => void;
  onNotice: (message: string, detail?: string) => void;
}) {
  const { t } = useLocale();
  const [refreshing, setRefreshing] = useState(false);
  const snapshot = catalog?.snapshot;

  async function refresh(): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const next = await client.refreshModelCatalog();
      onCatalogChange?.(next);
      onNotice(t("providers.catalog.notice.refreshed"), next.snapshot
        ? new Date(next.snapshot.fetchedAt).toLocaleString()
        : undefined);
    } catch (reason) {
      // The server keeps serving the snapshot it already had, so say that
      // rather than leaving the user to guess whether the data is now gone.
      const detail = reason instanceof Error ? reason.message : "";
      onError(reason instanceof Error && isAuthFailure(reason) ? reason
        : detail ? `${t("providers.catalog.refreshFailed")}: ${detail}` : t("providers.catalog.refreshFailed"));
    } finally {
      setRefreshing(false);
    }
  }

  return <section className="model-catalog-status" aria-label={t("providers.catalog.title")}>
    <span className="model-catalog-line">
      <strong>{t("providers.catalog.title")}</strong>
      <small>{t("providers.catalog.source")}</small>
      <small>{snapshot
        ? t(`providers.catalog.updated.${snapshot.origin}`, { time: new Date(snapshot.fetchedAt).toLocaleString() })
        : t("providers.catalog.missing")}</small>
    </span>
    <button
      className="secondary-button compact-button"
      disabled={refreshing}
      onClick={() => void refresh()}
      type="button"
    >{refreshing ? t("providers.catalog.refreshing") : t("providers.catalog.refresh")}</button>
  </section>;
}

interface ListingState {
  error?: string;
  list?: ProviderModelList;
  loading: boolean;
}

export interface AddModelsResult {
  added: ModelProfile[];
  failed: number;
}

/** The one way to register models on an existing provider. It opens the
 *  provider's fetched listing, ticks the models to add, and keeps the same
 *  manual fields as a fallback for a model the listing cannot return.
 *  Nothing is written until the dialog's own submit; closing a non-empty
 *  selection asks before discarding it. */
export function AddModelsDialog({
  busy,
  listing,
  onAddModels,
  onClose,
  onRefresh,
  provider,
}: {
  busy: boolean;
  listing?: ListingState | undefined;
  onAddModels: (providerId: string, requests: CreateProviderModelRequest[]) => Promise<AddModelsResult>;
  onClose: () => void;
  onRefresh: (providerId: string) => void;
  provider: ModelProvider;
}) {
  const { t } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [manualEntries, setManualEntries] = useState<CreateProviderModelRequest[]>([]);
  const [manual, setManual] = useState<ManualModelForm>({ ...EMPTY_MANUAL_MODEL });
  const [result, setResult] = useState<{
    added: number;
    addedIds: string[];
    availableIds: string[];
    total: number;
  }>();
  const available = (listing?.list?.models ?? []).filter((entry) => !entry.profileId);
  const availableIds = new Set(available.map((entry) => entry.id));
  // A registered model disappears from the listing. Never count or submit a
  // tick that no longer belongs to a visible row.
  const selectedAvailableIds = [...selectedIds].filter((id) => availableIds.has(id));
  const allSelected = available.length > 0 && selectedAvailableIds.length === available.length;
  const selectedCount = selectedAvailableIds.length + manualEntries.length;
  const dirty = selectedCount > 0 || Boolean(manual.modelId.trim());
  const availableKey = [...availableIds].sort().join("\u0000");
  useEffect(() => {
    const node = dialog.current;
    node?.showModal?.();
    return () => node?.close?.();
  }, []);
  useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => availableIds.has(id)));
      return next.size === current.size ? current : next;
    });
    setResult((current) => {
      if (!current) return current;
      const previousIds = new Set(current.availableIds);
      const nextIds = new Set(availableIds);
      const removed = [...previousIds].filter((id) => !nextIds.has(id));
      const added = [...nextIds].filter((id) => !previousIds.has(id));
      // Keep the partial outcome only when the listing shrank by exactly the
      // rows this submit just registered. Any other change means the plan the
      // banner described no longer exists.
      return added.length === 0 && removed.length > 0 && removed.every((id) => current.addedIds.includes(id))
        ? current
        : undefined;
    });
    // The listing can change after a refresh or another client registers a row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableKey]);

  function close(): void {
    if (dirty && !window.confirm(t("providers.unsaved.addModels"))) return;
    onClose();
  }

  function toggleSelected(id: string, checked: boolean): void {
    setResult(undefined);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(checked: boolean): void {
    setResult(undefined);
    setSelectedIds(checked ? new Set(available.map((entry) => entry.id)) : new Set());
  }

  function stageManual(): void {
    const modelId = manual.modelId.trim();
    if (!modelId) return;
    setResult(undefined);
    const request = manualModelRequest(modelId, manual);
    setManualEntries((current) => [...current.filter((entry) => entry.model !== modelId), request]);
    setManual({ ...EMPTY_MANUAL_MODEL });
  }

  async function submit(): Promise<void> {
    const byModel = new Map<string, CreateProviderModelRequest>();
    for (const entry of available) {
      if (selectedAvailableIds.includes(entry.id)) byModel.set(entry.id, manualModelRequest(entry.id, { ...EMPTY_MANUAL_MODEL }, entry));
    }
    for (const entry of manualEntries) byModel.set(entry.model, entry);
    if (!byModel.size) return;
    const total = byModel.size;
    setResult(undefined);
    const outcome = await onAddModels(provider.id, [...byModel.values()]);
    const addedIds = new Set(outcome.added.map((model) => model.model));
    if (addedIds.size) {
      // Succeeded rows are gone from the pending selection; only failures stay
      // ticked, so a retry cannot silently re-send what already landed.
      setSelectedIds((current) => new Set([...current].filter((id) => !addedIds.has(id))));
      setManualEntries((current) => current.filter((entry) => !addedIds.has(entry.model)));
      setManual((current) => addedIds.has(current.modelId.trim()) ? { ...EMPTY_MANUAL_MODEL } : current);
    }
    if (outcome.failed === 0 && outcome.added.length === total) {
      onClose();
      return;
    }
    setResult({
      added: outcome.added.length,
      addedIds: [...addedIds],
      availableIds: [...availableIds],
      total,
    });
  }

  return <dialog
    aria-label={t("providers.models.addTitle", { provider: provider.name })}
    className="model-deletion-dialog model-add-dialog model-connect-wizard"
    onCancel={(event) => { event.preventDefault(); close(); }}
    onKeyDown={(event) => event.stopPropagation()}
    ref={dialog}
  >
    <div className="wizard-section-heading">
      <h2>{t("providers.models.addTitle", { provider: provider.name })}</h2>
      <button
        className="secondary-button compact-button"
        disabled={busy || listing?.loading}
        onClick={() => { setResult(undefined); onRefresh(provider.id); }}
        type="button"
      >{listing?.loading ? t("common.loading") : t("providers.models.refresh")}</button>
    </div>
    <p>{t("providers.models.addHint")}</p>
    {listing?.error ? <div className="wizard-alert wizard-alert-error" role="alert">
      <div className="wizard-alert-content"><strong>{t("providers.discovery.failed")}</strong><span>{listing.error}</span></div>
    </div> : null}
    {result ? <div className="wizard-alert wizard-alert-error" role="status">
      <div className="wizard-alert-content"><span>{t("providers.models.partial", { added: result.added, total: result.total })}</span></div>
    </div> : null}
    {available.length ? <div aria-label={t("providers.models.table", { provider: provider.name })} className="wizard-model-table" role="table">
      <label className="wizard-model-row wizard-model-row-all" role="row">
        <input
          aria-label={t("wizard.models.selectAll")}
          checked={allSelected}
          disabled={busy}
          onChange={(event) => toggleAll(event.target.checked)}
          type="checkbox"
        />
        <span>
          <strong>{t("wizard.models.selectAll")}</strong>
          <small>{t("providers.models.selected", { count: selectedCount - manualEntries.length })}</small>
        </span>
      </label>
      {available.map((entry) => <label className="wizard-model-row" key={entry.id} role="row">
        <input
          aria-label={entry.id}
          checked={selectedAvailableIds.includes(entry.id)}
          disabled={busy}
          onChange={(event) => toggleSelected(entry.id, event.target.checked)}
          type="checkbox"
        />
        <span className="provider-model-cell-name">
          <strong>{providerModelDisplayName(entry, provider)}</strong>
          <code>{entry.id}</code>
        </span>
        <ModelRowFacts model={entry} />
      </label>)}
    </div> : listing?.loading ? <p className="muted">{t("providers.configured.loading")}</p> : listing?.list?.models.length
      ? <p className="muted">{t("providers.models.allAdded")}</p>
      : <p className="muted">{t("providers.models.empty")}</p>}
    {manualEntries.length ? <ul aria-label={t("wizard.models.manualList")} className="wizard-manual-list">
      {manualEntries.map((entry) => <li className="wizard-manual-item" key={entry.model}>
        <span className="provider-model-cell-name"><strong>{entry.label ?? entry.model}</strong><code>{entry.model}</code></span>
        <em>{t("wizard.models.manualTag")}</em>
        <button
          className="danger-button compact-button wizard-manual-remove"
          disabled={busy}
          onClick={() => {
            setResult(undefined);
            setManualEntries((current) => current.filter((item) => item.model !== entry.model));
          }}
          type="button"
        >{t("wizard.models.remove")}</button>
      </li>)}
    </ul> : null}
    <details className="provider-advanced" open={available.length === 0}>
      <summary>{t("providers.models.manualFallback")}</summary>
      <ManualModelFields
        busy={busy}
        form={manual}
        onChange={(next) => { setResult(undefined); setManual(next); }}
        onSubmit={stageManual}
        presetId={provider.presetId}
        submitLabel={t("providers.models.addManual")}
      />
    </details>
    <div className="dialog-actions">
      <button className="secondary-button" disabled={busy} onClick={close} type="button">{t("common.cancel")}</button>
      <button
        className="primary-button"
        disabled={busy || selectedCount === 0}
        onClick={() => void submit()}
        type="button"
      >{busy ? t("common.saving") : t("providers.models.addSubmit")}</button>
    </div>
  </dialog>;
}

export function ProviderRow({
  addedProfiles,
  busy,
  editorPanel,
  expanded,
  listing,
  onAddModels,
  onDeleteModel,
  onEdit,
  onRefresh,
  onToggle,
  provider,
  testModel,
}: {
  addedProfiles: ModelProfile[];
  busy: boolean;
  editorPanel?: ReactNode;
  expanded: boolean;
  listing?: ListingState | undefined;
  onAddModels: (providerId: string, requests: CreateProviderModelRequest[]) => Promise<AddModelsResult>;
  onDeleteModel: (providerId: string, modelId: string, profileId: string) => Promise<boolean>;
  onEdit: (provider: ModelProvider) => void;
  onRefresh: (providerId: string) => void;
  onToggle: (providerId: string) => void;
  provider: ModelProvider;
  testModel: SettingsApiClient["testModel"];
}) {
  const { t } = useLocale();
  const [addOpen, setAddOpen] = useState(false);
  const [testModelId, setTestModelId] = useState("");
  const rows = mergeProviderModelRows(listing?.list?.models, addedProfiles, provider);
  // The total counts the same union the table shows, so the count, the table,
  // and the test dropdown never disagree.
  const total = listing?.list ? rows.length : undefined;
  const ready = provider.hasApiToken || provider.tokenOptional;
  const testProfile = addedProfiles.find((profile) => profile.id === testModelId) ?? addedProfiles[0];

  return <div className={expanded ? "provider-row expanded" : "provider-row"}>
    <button
      aria-expanded={expanded}
      className="provider-row-summary"
      onClick={() => onToggle(provider.id)}
      type="button"
    >
      <span
        aria-label={ready ? t("providers.status.ready") : t("providers.status.missingToken")}
        className={ready ? "model-status" : "model-status missing"}
        role="img"
        title={ready ? t("providers.status.ready") : t("providers.status.missingToken")}
      />
      <span className="provider-row-name"><strong>{provider.name}</strong><small>{provider.baseUrl}</small></span>
      <span className="provider-row-count">{listing?.loading
        ? t("providers.configured.loading")
        : total === undefined
          ? t("providers.configured.addedOnly", { added: addedProfiles.length })
          : t("providers.configured.counts", { added: addedProfiles.length, total })}</span>
      <em>{provider.presetId ? t("providers.kind.builtIn") : t("providers.kind.custom")}</em>
    </button>
    {expanded ? <div className="provider-row-detail">
      <div className="provider-row-actions">
        <button className="secondary-button compact-button" onClick={() => onEdit(provider)} type="button">{t("providers.edit")}</button>
        <button className="secondary-button compact-button" disabled={busy || listing?.loading} onClick={() => onRefresh(provider.id)} type="button">{listing?.loading ? t("common.loading") : t("providers.models.refresh")}</button>
        {addedProfiles.length && testProfile ? <span className="provider-row-test">
          <select aria-label={t("providers.test.choose")} value={testProfile.id} onChange={(event) => setTestModelId(event.target.value)}>
            {addedProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
          <ModelConnectivityButton
            baseUrl={testProfile.baseUrl}
            modelId={testProfile.id}
            modelName={testProfile.name}
            profileVersion={testProfile.updatedAt}
            testModel={testModel}
          />
        </span> : null}
      </div>
      {editorPanel}
      {listing?.error ? <div className="provider-discovery-error" role="alert"><strong>{t("providers.discovery.failed")}</strong><span>{listing.error}</span><small>{t("providers.discovery.fallback")}</small></div> : null}
      {listing?.list ? <small className="provider-row-source">{listing.list.source === "remote" ? t("providers.models.remote") : t("providers.models.catalog")} · {new Date(listing.list.fetchedAt).toLocaleString()}</small> : null}
      {rows.length ? <div className="provider-model-table" aria-label={t("providers.models.table", { provider: provider.name })} role="table">
        {rows.map((model) => <ProviderModelRow
          busy={busy}
          key={model.id}
          model={model}
          onDeleteModel={(profileId) => void onDeleteModel(provider.id, model.id, profileId)}
          provider={provider}
        />)}
      </div> : listing?.list ? <p className="muted">{t("providers.models.empty")}</p> : null}
      <button aria-expanded={addOpen} className="provider-add-model-toggle" onClick={() => setAddOpen((current) => !current)} type="button">
        {t("providers.models.add")}
      </button>
      {addOpen ? <AddModelsDialog
        busy={busy}
        {...(listing ? { listing } : {})}
        onAddModels={onAddModels}
        onClose={() => setAddOpen(false)}
        onRefresh={onRefresh}
        provider={provider}
      /> : null}
    </div> : null}
  </div>;
}

function ProviderEditorPanel({
  busy,
  draft,
  existing,
  onCancel,
  onChange,
  onDelete,
  onSave,
  proxySettings,
}: {
  busy: boolean;
  draft: ProviderDraft;
  existing?: ModelProvider | undefined;
  onCancel: () => void;
  onChange: (update: Partial<ProviderDraft>) => void;
  onDelete: () => void;
  onSave: () => void;
  proxySettings?: ProxySettingsDetails | undefined;
}) {
  const { t } = useLocale();
  return <section className="provider-editor" aria-label={t("providers.editor.title")}>
    <div className="provider-section-heading">
      <div><h4>{t("providers.editor.edit")}</h4><p>{draft.presetId ? t("providers.editor.presetHelp") : t("providers.editor.customHelp")}</p></div>
      <div className="provider-editor-actions">
        {draft.providerId ? <button className="danger-button compact-button" disabled={busy} onClick={onDelete} type="button">{t("common.delete")}</button> : null}
        <button className="secondary-button compact-button" disabled={busy} onClick={onCancel} type="button">{t("common.cancel")}</button>
        <button className="primary-button compact-button" disabled={busy} onClick={onSave} type="button">{busy ? t("common.saving") : t("common.save")}</button>
      </div>
    </div>
    <div className="provider-editor-primary">
      <label><span>{t("providers.name")}</span><input value={draft.name} onChange={(event) => onChange({ name: event.target.value })} /></label>
      <label><span>{t("settings.apiToken")}</span><input
        autoComplete="off"
        placeholder={existing?.hasApiToken ? t("settings.apiTokenPlaceholder.saved") : draft.tokenOptional ? t("providers.token.optional") : t("settings.apiTokenPlaceholder.required")}
        type="password"
        value={draft.apiToken}
        onChange={(event) => onChange({ apiToken: event.target.value, removeToken: false })}
      /></label>
    </div>
    {existing?.hasApiToken ? <button className={draft.removeToken ? "credential-remove pending" : "credential-remove"} onClick={() => onChange({ apiToken: "", removeToken: !draft.removeToken })} type="button">
      {draft.removeToken ? t("settings.removeTokenPending") : t("settings.removeToken")}
    </button> : null}
    <details className="provider-advanced" open={!draft.presetId}>
      <summary>{t("providers.advanced")}</summary>
      <div className="provider-advanced-grid">
        <label className="provider-advanced-url"><span>{t("providers.baseUrl")}</span><input value={draft.baseUrl} onChange={(event) => onChange({ baseUrl: event.target.value })} /></label>
        <label><span>{t("settings.apiProtocol")}</span><select value={draft.apiProtocol} onChange={(event) => {
          const apiProtocol = event.target.value as ModelApiProtocol;
          onChange({ apiProtocol, apiVariant: DEFAULT_MODEL_API_VARIANT[apiProtocol], modelDiscovery: DEFAULT_MODEL_DISCOVERY[apiProtocol] });
        }}>
          <option value="openai-chat-completions">{t("settings.apiProtocol.chatCompletions")}</option>
          <option value="openai-responses">{t("settings.apiProtocol.responses")}</option>
          <option value="anthropic-messages">{t("settings.apiProtocol.anthropic")}</option>
        </select></label>
        <label><span>{t("settings.apiVariant")}</span><select value={draft.apiVariant} onChange={(event) => onChange({ apiVariant: event.target.value as ModelApiVariant })}>
          {MODEL_API_VARIANTS[draft.apiProtocol].map((variant) => <option key={variant} value={variant}>{t(`settings.apiVariant.${variant}`)}</option>)}
        </select></label>
        {proxySettings ? <ProxyPolicySelect label={t("settings.llmProxy")} onChange={(proxyPolicy) => onChange({ proxyPolicy })} settings={proxySettings} value={draft.proxyPolicy} /> : null}
      </div>
    </details>
  </section>;
}

export const ProviderModelSettings = forwardRef<ProviderModelSettingsHandle, {
  catalog?: ModelCatalogDetails;
  client: SettingsApiClient;
  defaultModelId?: string | undefined;
  models: ModelProfile[];
  onCatalogChange?: (details: ModelCatalogDetails) => void;
  onDraftStateChange?: (dirty: boolean) => void;
  initialWizardOpen?: boolean;
  onEditDefaultModel?: () => void;
  onError: (reason: string | Error) => void;
  /** Only used by the wizard's first-model path; the registry itself never
   *  edits the default, it points at Global defaults → Task model. */
  onDefaultModelSet?: (modelId: string) => Promise<void>;
  onModelsChange: (models: ModelProfile[]) => void;
  onNotice: (message: string, detail?: string) => void;
  onProvidersChange: (providers: ModelProvider[]) => void;
  presets: ModelProviderPreset[];
  providers: ModelProvider[];
  proxySettings?: ProxySettingsDetails;
}>(function ProviderModelSettings({
  catalog,
  client,
  defaultModelId,
  initialWizardOpen,
  models,
  onCatalogChange,
  onDefaultModelSet,
  onDraftStateChange,
  onEditDefaultModel,
  onError,
  onModelsChange,
  onNotice,
  onProvidersChange,
  presets,
  providers,
  proxySettings,
}, ref) {
  const { t } = useLocale();
  // 新建服务商只走连接模型向导；没有已配置项时向导默认展开，成为首启路径。
  const [wizardOpen, setWizardOpen] = useState(() => initialWizardOpen === true || providers.length === 0);
  const [draft, setDraft] = useState<ProviderDraft>();
  const [listings, setListings] = useState<Record<string, ListingState>>({});
  const [expandedId, setExpandedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [deletion, setDeletion] = useState<{ name: string; removedIds: string[]; provider: boolean; resolve: (replacement: string | null | false) => void }>();
  const pendingDeletion = useRef<((replacement: string | null | false) => void) | undefined>(undefined);
  useEffect(() => () => pendingDeletion.current?.(false), []);
  function confirmDeletion(name: string, removedIds: string[], provider = false): Promise<string | null | false> {
    return new Promise(resolve => {
      pendingDeletion.current = resolve;
      setDeletion({ name, removedIds, provider, resolve });
    });
  }
  const baselineDraft = useRef<ProviderDraft | undefined>(undefined);
  const listingRequests = useRef(new Map<string, number>());

  useEffect(() => {
    if (initialWizardOpen) {
      setWizardOpen(true);
    }
  }, [initialWizardOpen]);
  const draftDirty = draftFingerprint(draft) !== draftFingerprint(baselineDraft.current);

  useEffect(() => onDraftStateChange?.(draftDirty), [draftDirty, onDraftStateChange]);
  useEffect(() => () => onDraftStateChange?.(false), [onDraftStateChange]);

  useImperativeHandle(ref, () => ({
    hasUnsavedDraft: () => draftDirty,
    saveDraft: saveProvider,
  }), [draftDirty, draft, busy, providers]);

  async function loadModels(providerId: string, refresh = false): Promise<void> {
    const sequence = (listingRequests.current.get(providerId) ?? 0) + 1;
    listingRequests.current.set(providerId, sequence);
    setListings((current) => ({ ...current, [providerId]: { ...current[providerId], error: undefined, loading: true } }));
    try {
      const list = await client.listProviderModels(providerId, refresh);
      if (listingRequests.current.get(providerId) === sequence) {
        setListings((current) => ({ ...current, [providerId]: { list, loading: false } }));
      }
    } catch (reason) {
      // Keep the last successful listing visible. Manual model entry stays
      // available so an outage is recoverable.
      const message = reason instanceof Error ? reason.message : t("providers.discovery.failed");
      if (listingRequests.current.get(providerId) === sequence) {
        setListings((current) => ({ ...current, [providerId]: { ...current[providerId], error: message, loading: false } }));
      }
    }
  }

  // Pull every configured provider's real model list so each row can show
  // added/total counts; results are cached in state and refreshed per row.
  useEffect(() => {
    for (const provider of providers) {
      if (!listings[provider.id] && !listingRequests.current.has(provider.id)) void loadModels(provider.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  function change(update: Partial<ProviderDraft>): void {
    setDraft((current) => current ? { ...current, ...update } : current);
  }

  function selectDraft(next: ProviderDraft): void {
    baselineDraft.current = next;
    setDraft(next);
    setBusy(false);
  }

  function allowDraftReplacement(): boolean {
    return !draftDirty || window.confirm(t("providers.unsaved.confirm"));
  }

  function cancelDraft(): void {
    if (!allowDraftReplacement()) return;
    baselineDraft.current = undefined;
    setDraft(undefined);
  }

  function operationError(reason: unknown, fallback: string): string | Error {
    return providerOperationError(reason, fallback, t("providers.delete.referenced"));
  }

  function editProvider(provider: ModelProvider): void {
    if (!allowDraftReplacement()) return;
    selectDraft(providerDraft(provider));
    setExpandedId(provider.id);
  }

  function toggleRow(providerId: string): void {
    // Collapsing the row (or opening another one) would hide a dirty provider
    // draft. Ask now, while the editor is still on screen, not later at close.
    if (draftDirty) {
      if (!allowDraftReplacement()) return;
      baselineDraft.current = undefined;
      setDraft(undefined);
    }
    setExpandedId((current) => current === providerId ? undefined : providerId);
  }

  async function saveProvider(): Promise<boolean> {
    if (!draft || busy) return false;
    if (!draft.name.trim() || !draft.baseUrl.trim()) {
      onError(t("providers.validation.identity"));
      return false;
    }
    const existing = draft.providerId ? providers.find((provider) => provider.id === draft.providerId) : undefined;
    setBusy(true);
    try {
      const input = {
        apiProtocol: draft.apiProtocol,
        apiVariant: draft.apiVariant,
        baseUrl: draft.baseUrl.trim(),
        modelDiscovery: draft.modelDiscovery,
        name: draft.name.trim(),
        proxyPolicy: draft.proxyPolicy,
        tokenOptional: draft.tokenOptional,
        ...(draft.apiToken.trim() ? { apiToken: draft.apiToken.trim() } : {}),
      };
      const saved = existing
        ? await client.updateProvider(existing.id, {
            ...input,
            ...(draft.removeToken ? { apiToken: null } : {}),
          })
        : await client.createProvider({ ...input, presetId: draft.presetId });
      onNotice(existing ? t("providers.notice.updated") : t("providers.notice.created"), saved.name);
      try {
        const registry = await client.listProviders();
        onProvidersChange(registry.providers);
      } catch (reason) {
        onError(operationError(reason, t("providers.load.providersFailed")));
        return false;
      }
      // Saved: back to the list, with the provider expanded and its real
      // model list refreshed.
      baselineDraft.current = undefined;
      setDraft(undefined);
      setExpandedId(saved.id);
      await loadModels(saved.id, true);
      return true;
    } catch (reason) {
      onError(operationError(reason, t("providers.validation.saveFailed")));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function deleteProvider(): Promise<void> {
    if (!draft?.providerId || busy) return;
    const replacement = await confirmDeletion(draft.name, models.filter(model => model.providerId === draft.providerId).map(model => model.id), true);
    if (replacement === false) return;
    setBusy(true);
    try {
      await client.deleteProvider(draft.providerId, replacement);
      let nextProviders = providers.filter((provider) => provider.id !== draft.providerId);
      try {
        nextProviders = (await client.listProviders()).providers;
      } catch (reason) {
        onError(operationError(reason, t("providers.load.providersFailed")));
      }
      onProvidersChange(nextProviders);
      try {
        onModelsChange(await client.listModels());
      } catch (reason) {
        onError(operationError(reason, t("providers.load.modelsFailed")));
      }
      setListings((current) => {
        const next = { ...current };
        delete next[draft.providerId!];
        return next;
      });
      baselineDraft.current = undefined;
      setDraft(undefined);
      onNotice(t("providers.notice.deleted"), draft.name);
    } catch (reason) {
      onError(operationError(reason, t("providers.delete.failed")));
    } finally {
      setBusy(false);
    }
  }

  async function addModels(
    providerId: string,
    requests: CreateProviderModelRequest[],
  ): Promise<AddModelsResult> {
    if (!requests.length || busy) return { added: [], failed: 0 };
    const byModel = new Map<string, CreateProviderModelRequest>();
    for (const request of requests) {
      const modelId = request.model.trim();
      if (modelId) byModel.set(modelId, { ...request, model: modelId });
    }
    if (!byModel.size) return { added: [], failed: 0 };
    const added: ModelProfile[] = [];
    const merge = () => [...models.filter((model) => !added.some((entry) => entry.id === model.id)), ...added]
      .toSorted((left, right) => left.name.localeCompare(right.name));
    const recordListings = () => setListings((current) => {
      const listing = current[providerId]?.list;
      if (!listing) return current;
      const nextModels = [...listing.models];
      for (const saved of added) {
        const index = nextModels.findIndex((entry) => entry.id === saved.model);
        if (index >= 0) nextModels[index] = { ...nextModels[index]!, profileId: saved.id };
        else nextModels.unshift({ id: saved.model, profileId: saved.id });
      }
      return { ...current, [providerId]: { ...current[providerId]!, list: { ...listing, models: nextModels }, loading: false } };
    });
    setBusy(true);
    try {
      for (const request of byModel.values()) {
        const saved = await client.addProviderModel(providerId, request);
        added.push(saved);
      }
      onModelsChange(merge());
      recordListings();
      const providerName = providers.find((provider) => provider.id === providerId)?.name;
      onNotice(added.length === 1
        ? t("providers.notice.modelAdded")
        : t("providers.notice.modelsAdded", { count: added.length }), added.length === 1 ? added[0]!.name : providerName);
      return { added, failed: 0 };
    } catch (reason) {
      // Keep the models that did register, mark their listing rows as added,
      // and tell the dialog how many of the request actually landed.
      if (added.length) {
        onModelsChange(merge());
        recordListings();
      }
      onError(reason instanceof Error ? reason : t("providers.models.addFailed"));
      return { added, failed: byModel.size - added.length };
    } finally {
      setBusy(false);
    }
  }

  async function deleteModel(providerId: string, modelId: string, profileId: string): Promise<boolean> {
    if (busy) return false;
    const target = models.find((model) => model.id === profileId);
    const replacement = await confirmDeletion(target?.name ?? modelId, [profileId]);
    if (replacement === false) return false;
    setBusy(true);
    try {
      const deleted = target;
      await client.deleteModel(profileId, replacement);
      onModelsChange(models.filter((model) => model.id !== profileId));
      setListings((current) => {
        const listing = current[providerId]?.list;
        if (!listing) return current;
        return {
          ...current,
          [providerId]: {
            ...current[providerId]!,
            list: {
              ...listing,
              models: listing.models.map((entry) => {
                if (entry.id !== modelId || entry.profileId !== profileId) return entry;
                const { profileId: _profileId, ...unadded } = entry;
                return unadded;
              }),
            },
            loading: false,
          },
        };
      });
      onNotice(t("providers.notice.modelDeleted"), deleted?.name ?? modelId);
      return true;
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : "";
      const fallback = t("error.deleteModel");
      onError(reason instanceof Error && isAuthFailure(reason) ? reason : detail ? `${fallback}: ${detail}` : fallback);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const existing = draft?.providerId ? providers.find((provider) => provider.id === draft.providerId) : undefined;
  return <div className="provider-settings">
    {deletion ? <ModelDeletionDialog
      name={deletion.name}
      provider={deletion.provider}
      replacingDefault={defaultModelId !== undefined && deletion.removedIds.includes(defaultModelId)}
      models={models.filter(model => !deletion.removedIds.includes(model.id))}
      onDecision={replacement => {
        deletion.resolve(replacement);
        pendingDeletion.current = undefined;
        setDeletion(undefined);
      }}
    /> : null}
    <ModelCatalogStatus
      {...(catalog ? { catalog } : {})}
      client={client}
      {...(onCatalogChange ? { onCatalogChange } : {})}
      onError={onError}
      onNotice={onNotice}
    />
    <section className="provider-registry" aria-label={t("providers.configured.title")}>
      <div className="provider-section-heading">
        <div><h4>{t("providers.configured.title")}</h4></div>
        {/* One editable control for the default model lives in Global
            defaults → Task model. Here it is a read-only value that links to
            that control, so the same field cannot be saved two ways. */}
        <div className="registry-default-inline">
          <span id="registry-default-model-label">{t("providers.globalDefaultModel")}</span>
          <output aria-labelledby="registry-default-model-label" id="registry-default-model" title={t("providers.globalDefaultModel.hint")}>
            {models.find((model) => model.id === defaultModelId)?.name ?? t("common.notConfigured")}
          </output>
          {onEditDefaultModel ? <button
            className="secondary-button compact-button"
            onClick={onEditDefaultModel}
            title={t("providers.globalDefaultModel.hint")}
            type="button"
          >
            {t("providers.globalDefaultModel.edit")}
          </button> : null}
        </div>
        <button
          aria-expanded={wizardOpen}
          className="secondary-button compact-button"
          onClick={() => setWizardOpen((current) => !current)}
          type="button"
        >
          {wizardOpen ? t("wizard.toggleHide") : t("wizard.toggleShow")}
        </button>
      </div>
      {wizardOpen ? (
        <ModelConnectWizard
          client={client}
          {...(onDefaultModelSet ? { onDefaultModelSet } : {})}
          onError={onError}
          onModelsChange={onModelsChange}
          onNotice={onNotice}
          onProvidersChange={onProvidersChange}
          presets={presets}
          providers={providers}
          {...(proxySettings ? { proxySettings } : {})}
        />
      ) : null}
      {providers.length ? <div className="provider-rows">
        {providers.map((provider) => <ProviderRow
          addedProfiles={models.filter((model) => model.providerId === provider.id)}
          busy={busy}
          {...(draft?.providerId === provider.id
            ? { editorPanel: <ProviderEditorPanel
                busy={busy}
                draft={draft}
                existing={providers.find((candidate) => candidate.id === provider.id)}
                onCancel={cancelDraft}
                onChange={change}
                onDelete={() => void deleteProvider()}
                onSave={() => void saveProvider()}
                {...(proxySettings ? { proxySettings } : {})}
              /> }
            : {})}
          expanded={expandedId === provider.id}
          key={provider.id}
          {...(listings[provider.id] ? { listing: listings[provider.id] } : {})}
          onAddModels={addModels}
          onDeleteModel={deleteModel}
          onEdit={editProvider}
          onRefresh={(providerId) => void loadModels(providerId, true)}
          onToggle={toggleRow}
          provider={provider}
          testModel={(modelId, compatibility, expectedDestination) => client.testModel(modelId, compatibility, expectedDestination)}
        />)}
      </div> : <p className="muted">{t("providers.configured.empty")}</p>}
    </section>

  </div>;
});

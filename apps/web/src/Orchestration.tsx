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

import { useEffect, useState, type FormEvent } from "react";

import type {
  ConnectorManifest,
  ReviewerSpecialistLevel,
  Subagent,
  SubagentStep,
  SkillDescriptor,
  Specialist,
} from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { useLocale, type MessageKey } from "./i18n/index.js";
import { CheckIcon, ChevronRightIcon, SpinnerIcon } from "./icons.js";
import { ReviewerSpecialistAvatar } from "./ReviewerPanel.js";
import { ProcessRecord } from "./ProcessRecord.js";
import { activityCardId, type ActivityCardDisclosure } from "./session/run-activity.js";
import type { RunPlanSnapshot } from "./session/run-activity.js";

type VisibleReviewerLevel = ReviewerSpecialistLevel;

type Translate = (key: MessageKey, variables?: Record<string, number | string>) => string;

function visibleReviewerLevel(level: ReviewerSpecialistLevel): VisibleReviewerLevel { return level; }

function planSummary(plan: RunPlanSnapshot, t: Translate, terminal = false): string {
  const completed = plan.items.filter((item) => item.status === "completed").length;
  const active = plan.items.filter((item) => item.status === "in_progress").length;
  const summary = t("plan.summary", { completed, total: plan.items.length });
  return active && !terminal ? `${summary} · ${t("plan.summaryActive", { active })}` : summary;
}

function PlanItemStatus({ status }: { status: RunPlanSnapshot["items"][number]["status"] }) {
  const { t } = useLocale();
  const label = status === "completed" ? t("plan.status.completed") : status === "in_progress" ? t("plan.status.inProgress") : t("plan.status.pending");
  return <span aria-label={label} className={`plan-item-status ${status}`} role="img">
    {status === "completed" ? <CheckIcon size={13} /> : status === "in_progress" ? <SpinnerIcon size={14} /> : null}
  </span>;
}

export function PlanCard({
  expanded,
  onToggle,
  plan,
  terminal = false,
}: {
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  plan: RunPlanSnapshot;
  terminal?: boolean;
}) {
  const { t } = useLocale();
  const completed = plan.items.length > 0 && plan.items.every((item) => item.status === "completed");
  const status = !plan.items.length ? t("plan.badge.cleared")
    : completed ? t("plan.status.completed")
    : terminal ? t("record.finished")
    : plan.items.some((item) => item.status === "in_progress") ? t("plan.status.inProgress")
    : t("plan.status.pending");
  const title = t("plan.title", { agent: plan.agentId });
  return (
    <article className="plan-card recorded">
      <button aria-expanded={expanded} className="plan-card-heading" onClick={() => onToggle(!expanded)} type="button">
        <span className="card-chevron"><ChevronRightIcon size={15} /></span>
        <span className="plan-card-label"><strong title={title}>{title}</strong><small>{planSummary(plan, t, terminal)}</small></span>
        <i>{status}</i>
      </button>
      {expanded ? <div className="plan-card-body">
        {plan.explanation ? <p>{plan.explanation}</p> : null}
        <ol className="plan-item-list">{plan.items.map((item, index) => <li key={`${index}:${item.step}`} data-status={item.status}>
          <PlanItemStatus status={item.status} />
          <span>{item.step}</span>
        </li>)}</ol>
      </div> : null}
    </article>
  );
}

export function OrchestrationPanel({
  expandedCards,
  onToggleCard,
  plans,
  terminalRunIds = new Set<string>(),
}: ActivityCardDisclosure & {
  plans: RunPlanSnapshot[];
  terminalRunIds?: ReadonlySet<string>;
}) {
  const { t } = useLocale();
  if (!plans.length) return null;
  return <section className="orchestration-panel" aria-label={t("plan.sectionAria")}>
    {plans.map((plan) => {
      const cardId = activityCardId("plan", `${plan.runId}:${plan.agentId}`);
      return <PlanCard
        expanded={Boolean(expandedCards[cardId])}
        key={`${plan.runId}:${plan.agentId}`}
        onToggle={(expanded) => onToggleCard(cardId, expanded)}
        plan={plan}
        terminal={terminalRunIds.has(plan.runId)}
      />;
    })}
  </section>;
}

function subagentSummary(subagent: Subagent, t: Translate): string {
  if (subagent.status === "running") {
    const step = subagent.steps.findLast((candidate) => candidate.status === "running") ?? subagent.steps.at(-1);
    return step
      ? t("subagent.current", { label: subagentStepLabel(step, t), preview: subagentStepPreview(step, t) })
      : t("subagent.starting");
  }
  const parts = [subagent.input.subagentType ?? "general-purpose", t("subagent.turns", { count: subagent.turnCount, max: subagent.maxTurns })];
  parts.push(subagent.usage ? t("subagent.tokens", { count: subagent.usage.totalTokens.toLocaleString() }) : t("subagent.summaryUsageUnavailable"));
  return parts.join(" · ");
}

function subagentStepLabel(step: SubagentStep, t: Translate): string {
  if (step.kind === "tool") return step.toolName ?? t("subagent.step.tool");
  if (step.kind === "thinking") return t("subagent.step.reasoning");
  if (step.kind === "assistant") return t("subagent.step.response");
  const turn = /^Turn (\d+) started$/i.exec(step.content.trim());
  return turn ? t("subagent.step.turn", { turn: turn[1]! }) : t("subagent.step.setup");
}

function subagentStepPreview(step: SubagentStep, t: Translate): string {
  const source = step.kind === "tool" ? step.input ?? step.content : step.content;
  const compact = source.replace(/\s+/g, " ").trim();
  if (!compact) return t("subagent.step.noDetails");
  if (step.kind === "system" && /^Turn \d+ started$/i.test(compact)) return t("subagent.step.started");
  return compact;
}

const SUBAGENT_STATUS_KEYS: Record<Subagent["status"], MessageKey> = {
  cancelled: "subagent.status.cancelled",
  completed: "subagent.status.completed",
  failed: "subagent.status.failed",
  running: "subagent.status.running",
  timed_out: "subagent.status.timed_out",
};

/** Map a SubAgent status enum to a label; unknown values render as-is. */
export function subagentStatusLabel(t: Translate, status: string): string {
  const key = SUBAGENT_STATUS_KEYS[status as Subagent["status"]];
  return key ? t(key) : status;
}

export function SubagentCards({
  className,
  hideHeading = false,
  heading,
  onOpenSubagent,
  subagents,
}: {
  className?: string;
  hideHeading?: boolean;
  heading?: string;
  onOpenSubagent: (subagent: Subagent) => void;
  subagents: Subagent[];
}) {
  const { t } = useLocale();
  if (!subagents.length) return null;

  return <section className={`subagent-list process-subagents${className ? ` ${className}` : ""}`} aria-label={t("subagent.sectionAria")}>
    {!hideHeading && subagents.some((item) => item.status === "running") ? <div className="subagent-list-heading"><strong>{heading ?? t("subagent.headingPlural")}</strong><span>{t("subagent.listStats", { running: subagents.filter((subagent) => subagent.status === "running").length, total: subagents.length })}</span></div> : null}
    {subagents.map((subagent) => {
      const summary = subagentSummary(subagent, t);
      const statusLabel = subagentStatusLabel(t, subagent.status);
      return <ProcessRecord active={subagent.status === "running"} className={`process-agent-record ${subagent.status}`}
        failed={subagent.status === "failed" || subagent.status === "timed_out"}
        key={subagent.id} label={`${subagent.input.description} · ${statusLabel}`}>
        <article className={`subagent-card ${subagent.status}`}>
        <button aria-label={t("subagent.openAria", { description: subagent.input.description })} type="button" onClick={() => onOpenSubagent(subagent)} title={`${subagent.input.description} · ${statusLabel}\n${summary}`}><i /><span><strong>{subagent.input.description}{subagent.status !== "running" ? ` · ${statusLabel}` : ""}</strong><small>{summary}</small></span><em>{statusLabel}</em><ChevronRightIcon className="subagent-open-icon" size={15} /></button>
        </article>
      </ProcessRecord>;
    })}
  </section>;
}

export function SpecialistManager({
  client,
  connectors,
  onChanged,
  onError,
  skills,
}: {
  client: ApiClient;
  connectors: ConnectorManifest[];
  onChanged: (specialists: Specialist[]) => void;
  onError: (message: string) => void;
  skills: SkillDescriptor[];
}) {
  const { t } = useLocale();
  const [specialists, setSpecialists] = useState<Specialist[]>([]);
  const [editingId, setEditingId] = useState<string>();
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedConnectors, setSelectedConnectors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [reviewerEnabled, setReviewerEnabled] = useState(false);
  const [reviewerBusy, setReviewerBusy] = useState(true);
  const [builtinBusy, setBuiltinBusy] = useState(false);
  const [builtinExpanded, setBuiltinExpanded] = useState(false);

  async function refresh(): Promise<void> {
    const items = await client.listSpecialists();
    setSpecialists(items);
    onChanged(items);
  }

  useEffect(() => { void refresh().catch((error: Error) => onError(error.message)); }, [client]);

  function applySpecialist(updated: Specialist): void {
    setSpecialists((current) => {
      const items = current.map((specialist) => (specialist.id === updated.id ? updated : specialist));
      onChanged(items);
      return items;
    });
  }

  async function toggleBuiltin(id: string, next: boolean): Promise<void> {
    setBuiltinBusy(true);
    try {
      const updated = await client.updateSpecialist(id, { enabled: next });
      applySpecialist(updated);
    } catch (error) {
      onError(error instanceof Error ? error.message : t("specialist.updateBuiltinFailed"));
    } finally {
      setBuiltinBusy(false);
    }
  }

  async function setAllBuiltin(next: boolean): Promise<void> {
    setBuiltinBusy(true);
    try {
      await Promise.all(builtinSpecialists.map((specialist) => client.updateSpecialist(specialist.id, { enabled: next })));
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : t("specialist.updateAllBuiltinFailed"));
    } finally {
      setBuiltinBusy(false);
    }
  }
  useEffect(() => {
    void client.getReviewerSpecialistSettings()
      .then((settings) => {
        setReviewerEnabled(settings.enabled);
      })
      .catch((error: Error) => onError(error.message))
      .finally(() => setReviewerBusy(false));
  }, [client]);

  async function toggleReviewer(): Promise<void> {
    setReviewerBusy(true);
    try {
      const settings = await client.updateReviewerSpecialistSettings({
        enabled: !reviewerEnabled,
      });
      setReviewerEnabled(settings.enabled);
    } catch (error) {
      onError(error instanceof Error ? error.message : t("specialist.updateReviewerFailed"));
    } finally {
      setReviewerBusy(false);
    }
  }

  function edit(specialist?: Specialist): void {
    setEditingId(specialist?.id);
    setName(specialist?.name ?? "");
    setDescription(specialist?.description ?? "");
    setInstructions(specialist?.instructions ?? "");
    setSelectedSkills(specialist?.enabledSkillIds ?? []);
    setSelectedConnectors(specialist?.connectorIds ?? []);
    setFormOpen(true);
  }

  function closeEditor(): void {
    setEditingId(undefined);
    setName("");
    setDescription("");
    setInstructions("");
    setSelectedSkills([]);
    setSelectedConnectors([]);
    setFormOpen(false);
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      const body = { connectorIds: selectedConnectors as Specialist["connectorIds"], description, enabledSkillIds: selectedSkills, instructions, name };
      if (editingId) await client.updateSpecialist(editingId, body);
      else await client.createSpecialist(body);
      closeEditor();
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : t("specialist.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(specialist: Specialist): Promise<void> {
    if (!window.confirm(t("specialist.confirmDelete", { name: specialist.name }))) return;
    setBusy(true);
    try {
      await client.deleteSpecialist(specialist.id);
      closeEditor();
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : t("specialist.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  const builtinSpecialists = specialists.filter((specialist) => specialist.builtIn);
  const userSpecialists = specialists.filter((specialist) => !specialist.builtIn);

  return <div className="specialist-manager">
    <div className="settings-detail-header"><span className="eyebrow">{t("specialist.eyebrow")}</span><h3>{t("specialist.title")}</h3><p>{t("specialist.description")}</p></div>
    <BuiltInReviewerSpecialist
      busy={reviewerBusy}
      enabled={reviewerEnabled}
      onToggle={() => void toggleReviewer()}
    />
    {builtinSpecialists.length > 0 ? (() => {
      const enabledCount = builtinSpecialists.filter((s) => s.enabled !== false).length;
      const allOn = enabledCount === builtinSpecialists.length;
      const allOff = enabledCount === 0;
      return <section aria-label={t("specialist.builtinAria")} className="built-in-specialists">
        <div className="builtin-research-header">
          <button className="builtin-research-toggle" type="button" onClick={() => setBuiltinExpanded((v) => !v)} aria-expanded={builtinExpanded}>
            <strong>{t("specialist.builtinTitle")}</strong>
            <small>{t("connectors.enabled", { enabled: enabledCount, total: builtinSpecialists.length })}</small>
          </button>
          <div className="builtin-research-actions">
            <button className="builtin-research-action" disabled={builtinBusy || allOn} type="button" onClick={() => void setAllBuiltin(true)}>{t("specialist.enableAll")}</button>
            <button className="builtin-research-action" disabled={builtinBusy || allOff} type="button" onClick={() => void setAllBuiltin(false)}>{t("specialist.disableAll")}</button>
          </div>
        </div>
        {!builtinExpanded ? null : builtinSpecialists.map((specialist) => {
          const enabled = specialist.enabled !== false;
          return <div className="builtin-research-row" key={specialist.id}>
            <div className="builtin-research-text">
              <span className="builtin-research-name">{specialist.name}</span>
              {specialist.description ? <span className="builtin-research-desc">{specialist.description}</span> : null}
              <span className="builtin-research-meta">{t("specialist.counts", { connectors: specialist.connectorIds.length, skills: specialist.enabledSkillIds.length })}</span>
            </div>
            <button
              aria-checked={enabled}
              aria-label={t("specialist.enableAria", { name: specialist.name })}
              className={enabled ? "specialist-switch on" : "specialist-switch"}
              disabled={builtinBusy}
              onClick={() => void toggleBuiltin(specialist.id, !enabled)}
              role="switch"
              type="button"
            ><i /></button>
          </div>;
        })}
      </section>;
    })() : null}
    <div className={formOpen ? "specialist-layout" : "specialist-layout idle"}><div className="specialist-list"><button type="button" className={formOpen && !editingId ? "active" : ""} onClick={() => edit()}>{t("specialist.new")}</button>{userSpecialists.map((specialist) => <button className={formOpen && editingId === specialist.id ? "active" : ""} key={specialist.id} title={`${specialist.name} · ${t("specialist.counts", { connectors: specialist.connectorIds.length, skills: specialist.enabledSkillIds.length })}`} type="button" onClick={() => edit(specialist)}><strong>{specialist.name}</strong><small>{t("specialist.counts", { connectors: specialist.connectorIds.length, skills: specialist.enabledSkillIds.length })}</small></button>)}</div>
      {formOpen ? <form onSubmit={(event) => void save(event)}>
        <section className="specialist-form-card"><label><span>{t("specialist.fieldName")}</span><input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label></section>
        <section className="specialist-form-card"><label><span>{t("specialist.fieldDescription")}</span><textarea required rows={4} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></label></section>
        <section className="specialist-form-card"><label><span>{t("specialist.fieldInstructions")}</span><textarea required rows={9} maxLength={20_000} value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label></section>
        <fieldset><legend>{t("specialist.fieldSkills")}</legend>{skills.map((skill) => <label key={skill.id}><input type="checkbox" checked={selectedSkills.includes(skill.id)} onChange={() => setSelectedSkills((current) => current.includes(skill.id) ? current.filter((id) => id !== skill.id) : [...current, skill.id])} />{skill.name}</label>)}</fieldset>
        <fieldset><legend>{t("specialist.fieldConnectors")}</legend>{connectors.map((connector) => <label key={connector.id}><input type="checkbox" checked={selectedConnectors.includes(connector.id)} onChange={() => setSelectedConnectors((current) => current.includes(connector.id) ? current.filter((id) => id !== connector.id) : [...current, connector.id])} />{connector.id}</label>)}</fieldset>
        <div className="specialist-actions"><button className="primary-button" disabled={busy || !name.trim() || !description.trim() || !instructions.trim()} type="submit">{t(editingId ? "specialist.save" : "specialist.create")}</button><span className="specialist-actions-secondary"><button className="secondary-button" disabled={busy} type="button" onClick={closeEditor}>{t("common.cancel")}</button>{editingId ? <button className="danger-button" disabled={busy} type="button" onClick={() => { const specialist = userSpecialists.find((item) => item.id === editingId); if (specialist) void remove(specialist); }}>{t("common.delete")}</button> : null}</span></div>
      </form> : null}
    </div>
  </div>;
}

export function BuiltInReviewerSpecialist({
  busy,
  enabled,
  onToggle,
}: {
  busy: boolean;
  enabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useLocale();
  return <section aria-label={t("specialist.builtinSectionAria")} className="built-in-specialists">
    <strong>{t("common.builtIn")}</strong>
    <div className="built-in-specialist-row">
      <ReviewerSpecialistAvatar />
      <span>
        <strong>{t("specialist.reviewerName")}</strong>
      </span>
      <div className="reviewer-specialist-settings">
        <small>{t("specialist.reviewerHint")}</small>
        <button
          aria-checked={enabled}
          aria-label={t(enabled ? "specialist.reviewerTurnOff" : "specialist.reviewerTurnOn")}
          className={enabled ? "specialist-switch on" : "specialist-switch"}
          disabled={busy}
          onClick={onToggle}
          role="switch"
          title={t(enabled ? "specialist.reviewerOnTitle" : "specialist.reviewerOffTitle")}
          type="button"
        ><i aria-hidden="true" /></button>
      </div>
    </div>
  </section>;
}

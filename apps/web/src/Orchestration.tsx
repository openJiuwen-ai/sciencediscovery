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

import { compactStatus, reasoningStatus, reportedFailure, researchLabel, returnedPaperCount } from "./timeline/research-label.js";
import { ProjectRecordSlot } from "./plugins/project-views.js";
import { useEffect, useState, type FormEvent } from "react";

import type {
  ConnectorManifest,
  ReviewerSpecialistLevel,
  Subagent,
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

export function PlanCard(props: { expanded: boolean; onToggle:(expanded:boolean)=>void; plan:RunPlanSnapshot; terminal?:boolean }) {
 const {t}=useLocale();
 return <ProjectRecordSlot kind="plan.card" {...props} t={t} icons={{check:<CheckIcon size={13}/>,spinner:<SpinnerIcon size={14}/>,chevron:<ChevronRightIcon size={15}/>}} />;
}
export function OrchestrationPanel(props: ActivityCardDisclosure & { plans:RunPlanSnapshot[]; terminalRunIds?:ReadonlySet<string> }) {
 const {t}=useLocale();
 return <ProjectRecordSlot kind="plan.panel" {...props} t={t} cardIdFor={(runId,agentId)=>activityCardId("plan", `${runId}:${agentId}`)}
   icons={{check:<CheckIcon size={13}/>,spinner:<SpinnerIcon size={14}/>,chevron:<ChevronRightIcon size={15}/>}} />;
}

function subagentSummary(subagent: Subagent, t: Translate): string {
  // Turn/workspace bookkeeping carries no researcher-facing phase.
  const step = subagent.steps.findLast(step => step.kind !== "system");
  if (subagent.error) return compactStatus(subagent.error);
  if (step?.status === "failed") return compactStatus(step.content);
  if (subagent.status === "running" && step?.kind === "thinking") return reasoningStatus(step.content) ?? t("timeline.thinking");
  if (subagent.status === "running" && step?.kind === "assistant") return compactStatus(step.content);
  if (subagent.status === "running" && step?.kind === "tool") {
    const hasOutput = step.status === "completed" || step.content !== step.input;
    if (hasOutput && step.status === "running") {
      const failure = reportedFailure(step.content);
      if (failure) return failure;
    }
    const count = hasOutput ? returnedPaperCount(step.content) : undefined;
    if (count !== undefined) return t("timeline.papersReturned", { count });
    const command = step.args?.command ?? step.input;
    if (step.toolName === "run_shell" && typeof command === "string" && command.trim()) {
      return compactStatus(`${t(step.status === "running" ? "timeline.runningCommand" : "timeline.ranCommand")} · ${command}`);
    }
    return (hasOutput && step.content ? compactStatus(step.content) : undefined) ?? researchLabel({ name: step.toolName ?? t("subagent.step.tool"), args: step.args, input: step.input });
  }
  return "";
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
  expandedCards,
  onToggleCard,
  hideHeading = false,
  heading,
  onOpenSubagent,
  subagents,
}: Partial<ActivityCardDisclosure> & {
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
      const failureText = subagent.error ?? subagent.steps.findLast(step => step.status === "failed")?.content;
      const failure = failureText ? compactStatus(failureText) : undefined;
      return <ProcessRecord active={subagent.status === "running"} className={`process-agent-record ${subagent.status}`}
        expanded={expandedCards ? expandedCards[activityCardId("subagent", subagent.id)] ?? false : undefined}
        onExpandedChange={onToggleCard ? (expanded) => onToggleCard(activityCardId("subagent", subagent.id), expanded) : undefined}
        failed={subagent.status === "failed" || subagent.status === "timed_out"}
        key={subagent.id} label={`${subagent.input.description} · ${statusLabel}${failure ? ` · ${failure}` : ""}`}>
        <article className={`subagent-card ${subagent.status}`}>
        <button aria-label={t("subagent.openAria", { description: subagent.input.description })} type="button" onClick={() => onOpenSubagent(subagent)} title={`${subagent.input.description} · ${statusLabel}\n${summary}`}><i /><span><strong>{subagent.input.description}</strong>{summary && summary !== failure ? <small>{summary}</small> : null}{failure ? <small className="timeline-failure-summary">{failure}</small> : null}</span><em>{statusLabel}</em><ChevronRightIcon className="subagent-open-icon" size={15} /></button>
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
  skillsBackend,
}: {
  client: ApiClient;
  connectors: ConnectorManifest[];
  onChanged: (specialists: Specialist[]) => void;
  onError: (reason: string | Error) => void;
  skills: SkillDescriptor[];
  /** With `jiuwenswarm` a specialist's skills are not chosen: JiuwenSwarm has one set for every session. */
  skillsBackend?: "jiuwenswarm" | "native";
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

  useEffect(() => { void refresh().catch((error: Error) => onError(error)); }, [client]);

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
      onError(error instanceof Error ? error : t("specialist.updateBuiltinFailed"));
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
      onError(error instanceof Error ? error : t("specialist.updateAllBuiltinFailed"));
    } finally {
      setBuiltinBusy(false);
    }
  }
  useEffect(() => {
    void client.getReviewerSpecialistSettings()
      .then((settings) => {
        setReviewerEnabled(settings.enabled);
      })
      .catch((error: Error) => onError(error))
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
      onError(error instanceof Error ? error : t("specialist.updateReviewerFailed"));
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
      onError(error instanceof Error ? error : t("specialist.saveFailed"));
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
      onError(error instanceof Error ? error : t("specialist.deleteFailed"));
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
        {skillsBackend === "jiuwenswarm"
          ? <fieldset><legend>{t("specialist.fieldSkills")}</legend><small className="settings-hint">{t("settings.skillsOnJiuwenSwarm")}</small></fieldset>
          : <fieldset><legend>{t("specialist.fieldSkills")}</legend>{skills.map((skill) => <label key={skill.id}><input type="checkbox" checked={selectedSkills.includes(skill.id)} onChange={() => setSelectedSkills((current) => current.includes(skill.id) ? current.filter((id) => id !== skill.id) : [...current, skill.id])} />{skill.name}</label>)}</fieldset>}
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

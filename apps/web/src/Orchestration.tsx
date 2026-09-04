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
  ReviewerFeedbackPolicy,
  ReviewerSpecialistLevel,
  Subagent,
  SubagentStep,
  SessionPlan,
  SkillDescriptor,
  Specialist,
} from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { ChevronRightIcon } from "./icons.js";
import { ReviewerSpecialistAvatar } from "./ReviewerPanel.js";
import { activityCardId, type ActivityCardDisclosure } from "./session/run-activity.js";

type VisibleReviewerLevel = ReviewerSpecialistLevel;

function visibleReviewerLevel(level: ReviewerSpecialistLevel): VisibleReviewerLevel { return level; }

function planSummary(plan: SessionPlan): string {
  const feasibility = `${plan.feasibilityConfidence} feasibility`;
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const active = plan.steps.filter((step) => step.status === "in_progress").length;
  return `${completed}/${plan.steps.length} completed${active ? ` · ${active} active` : ""} · ${feasibility}`;
}

export function PlanCard({
  expanded,
  onToggle,
  plan,
}: {
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  plan: SessionPlan;
}) {
  return (
    <article className={`plan-card ${plan.state}`}>
      <button aria-expanded={expanded} className="plan-card-heading" onClick={() => onToggle(!expanded)} type="button">
        <span className="card-chevron"><ChevronRightIcon size={15} /></span>
        <span><strong>Plan · v{plan.version}</strong><small>{planSummary(plan)}</small></span>
        <i>{plan.state === "recorded" ? "active" : plan.state.replaceAll("_", " ")}</i>
      </button>
      {expanded ? <div className="plan-card-body">
        <p>{plan.scope}</p>
        <ol>{plan.steps.map((step) => <li key={step.id} data-status={step.status}>{step.description}</li>)}</ol>
        {plan.abandonmentReason ? <p className="plan-card-note">Abandoned: {plan.abandonmentReason}</p> : null}
        {plan.caveats.length ? <details><summary>Method caveats</summary><ul>{plan.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}</ul></details> : null}
      </div> : null}
    </article>
  );
}

export function OrchestrationPanel({
  expandedCards,
  onToggleCard,
  plans,
}: ActivityCardDisclosure & {
  plans: SessionPlan[];
}) {
  if (!plans.length) return null;
  return <section className="orchestration-panel" aria-label="Plans">
    {plans.map((plan) => {
      const cardId = activityCardId("plan", plan.id);
      return <PlanCard
        expanded={Boolean(expandedCards[cardId])}
        key={plan.id}
        onToggle={(expanded) => onToggleCard(cardId, expanded)}
        plan={plan}
      />;
    })}
  </section>;
}

function subagentSummary(subagent: Subagent): string {
  if (subagent.status === "running") {
    const step = subagent.steps.findLast((candidate) => candidate.status === "running") ?? subagent.steps.at(-1);
    return step ? `Current: ${subagentStepLabel(step)} · ${subagentStepPreview(step)}` : "Starting…";
  }
  const parts = [subagent.input.subagentType ?? "general-purpose", `${subagent.turnCount}/${subagent.maxTurns} turns`];
  parts.push(subagent.usage ? `${subagent.usage.totalTokens.toLocaleString()} tokens` : "usage unavailable");
  return parts.join(" · ");
}

function subagentStepLabel(step: SubagentStep): string {
  if (step.kind === "tool") return step.toolName ?? "Tool";
  if (step.kind === "thinking") return "Reasoning";
  if (step.kind === "assistant") return "Response";
  const turn = /^Turn (\d+) started$/i.exec(step.content.trim());
  return turn ? `Turn ${turn[1]}` : "Setup";
}

function subagentStepPreview(step: SubagentStep): string {
  const source = step.kind === "tool" ? step.input ?? step.content : step.content;
  const compact = source.replace(/\s+/g, " ").trim();
  if (!compact) return "No details";
  if (step.kind === "system" && /^Turn \d+ started$/i.test(compact)) return "Started";
  return compact;
}

export function SubagentCards({
  className,
  heading = "Subagents",
  onOpenSubagent,
  subagents,
}: {
  className?: string;
  heading?: string;
  onOpenSubagent: (subagent: Subagent) => void;
  subagents: Subagent[];
}) {
  if (!subagents.length) return null;

  return <section className={`subagent-list${className ? ` ${className}` : ""}`} aria-label="Subagent activity">
    <div className="subagent-list-heading"><strong>{heading}</strong><span>{subagents.filter((subagent) => subagent.status === "running").length} running · {subagents.length} total</span></div>
    {subagents.map((subagent) => {
      const summary = subagentSummary(subagent);
      return <article className={`subagent-card ${subagent.status}`} key={subagent.id}>
        <button aria-label={`Open SubAgent: ${subagent.input.description}`} type="button" onClick={() => onOpenSubagent(subagent)} title={`${subagent.input.description} · ${subagent.status}\n${summary}`}><i /><span><strong>{subagent.input.description}</strong><small>{summary}</small></span><em>{subagent.status}</em><ChevronRightIcon className="subagent-open-icon" size={15} /></button>
      </article>;
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
  const [reviewerFeedbackPolicy, setReviewerFeedbackPolicy] = useState<ReviewerFeedbackPolicy>("record");
  const [reviewerLevel, setReviewerLevel] = useState<VisibleReviewerLevel>("quick");
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
      onError(error instanceof Error ? error.message : "Could not update built-in specialist");
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
      onError(error instanceof Error ? error.message : "Could not update built-in specialists");
    } finally {
      setBuiltinBusy(false);
    }
  }
  useEffect(() => {
    void client.getReviewerSpecialistSettings()
      .then((settings) => {
        setReviewerEnabled(settings.enabled);
        setReviewerFeedbackPolicy(settings.feedbackPolicy);
        setReviewerLevel(visibleReviewerLevel(settings.level));
      })
      .catch((error: Error) => onError(error.message))
      .finally(() => setReviewerBusy(false));
  }, [client]);

  async function toggleReviewer(): Promise<void> {
    setReviewerBusy(true);
    try {
      const settings = await client.updateReviewerSpecialistSettings({
        enabled: !reviewerEnabled,
        feedbackPolicy: reviewerFeedbackPolicy,
        level: reviewerLevel,
      });
      setReviewerEnabled(settings.enabled);
      setReviewerFeedbackPolicy(settings.feedbackPolicy);
      setReviewerLevel(visibleReviewerLevel(settings.level));
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not update Reviewer Specialist");
    } finally {
      setReviewerBusy(false);
    }
  }

  async function changeReviewerLevel(level: VisibleReviewerLevel): Promise<void> {
    setReviewerBusy(true);
    try {
      const settings = await client.updateReviewerSpecialistSettings({ enabled: reviewerEnabled, level });
      setReviewerEnabled(settings.enabled);
      setReviewerFeedbackPolicy(settings.feedbackPolicy);
      setReviewerLevel(visibleReviewerLevel(settings.level));
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not update Reviewer Specialist level");
    } finally {
      setReviewerBusy(false);
    }
  }

  async function changeReviewerFeedbackPolicy(feedbackPolicy: ReviewerFeedbackPolicy): Promise<void> {
    setReviewerBusy(true);
    try {
      const settings = await client.updateReviewerSpecialistSettings({ enabled: reviewerEnabled, feedbackPolicy, level: reviewerLevel });
      setReviewerEnabled(settings.enabled);
      setReviewerFeedbackPolicy(settings.feedbackPolicy);
      setReviewerLevel(visibleReviewerLevel(settings.level));
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not update Reviewer Specialist feedback policy");
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
      onError(error instanceof Error ? error.message : "Could not save specialist");
    } finally {
      setBusy(false);
    }
  }

  async function remove(specialist: Specialist): Promise<void> {
    if (!window.confirm(`Delete specialist “${specialist.name}”? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await client.deleteSpecialist(specialist.id);
      closeEditor();
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not delete specialist");
    } finally {
      setBusy(false);
    }
  }

  const builtinSpecialists = specialists.filter((specialist) => specialist.builtIn);
  const userSpecialists = specialists.filter((specialist) => !specialist.builtIn);

  return <div className="specialist-manager">
    <div className="settings-detail-header"><span className="eyebrow">Subagent profiles</span><h3>User specialists</h3><p>Bundle instructions with optional skills and connectors, then attach the specialist to a Session or subagent.</p></div>
    <BuiltInReviewerSpecialist
      busy={reviewerBusy}
      enabled={reviewerEnabled}
      feedbackPolicy={reviewerFeedbackPolicy}
      level={reviewerLevel}
      onFeedbackPolicyChange={(policy) => void changeReviewerFeedbackPolicy(policy)}
      onLevelChange={(level) => void changeReviewerLevel(level)}
      onToggle={() => void toggleReviewer()}
    />
    {builtinSpecialists.length > 0 ? (() => {
      const enabledCount = builtinSpecialists.filter((s) => s.enabled !== false).length;
      const allOn = enabledCount === builtinSpecialists.length;
      const allOff = enabledCount === 0;
      return <section aria-label="Built-in research specialists" className="built-in-specialists">
        <div className="builtin-research-header">
          <button className="builtin-research-toggle" type="button" onClick={() => setBuiltinExpanded((v) => !v)} aria-expanded={builtinExpanded}>
            <strong>Built-in research specialists</strong>
            <small>{enabledCount}/{builtinSpecialists.length} enabled</small>
          </button>
          <div className="builtin-research-actions">
            <button className="builtin-research-action" disabled={builtinBusy || allOn} type="button" onClick={() => void setAllBuiltin(true)}>Enable all</button>
            <button className="builtin-research-action" disabled={builtinBusy || allOff} type="button" onClick={() => void setAllBuiltin(false)}>Disable all</button>
          </div>
        </div>
        {!builtinExpanded ? null : builtinSpecialists.map((specialist) => {
          const enabled = specialist.enabled !== false;
          return <div className="builtin-research-row" key={specialist.id}>
            <div className="builtin-research-text">
              <span className="builtin-research-name">{specialist.name}</span>
              {specialist.description ? <span className="builtin-research-desc">{specialist.description}</span> : null}
              <span className="builtin-research-meta">{specialist.enabledSkillIds.length} skills · {specialist.connectorIds.length} connectors</span>
            </div>
            <button
              aria-checked={enabled}
              aria-label={`Enable ${specialist.name}`}
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
    <div className={formOpen ? "specialist-layout" : "specialist-layout idle"}><div className="specialist-list"><button type="button" className={formOpen && !editingId ? "active" : ""} onClick={() => edit()}>＋ New specialist</button>{userSpecialists.map((specialist) => <button className={formOpen && editingId === specialist.id ? "active" : ""} key={specialist.id} title={`${specialist.name} · ${specialist.enabledSkillIds.length} skills · ${specialist.connectorIds.length} connectors`} type="button" onClick={() => edit(specialist)}><strong>{specialist.name}</strong><small>{specialist.enabledSkillIds.length} skills · {specialist.connectorIds.length} connectors</small></button>)}</div>
      {formOpen ? <form onSubmit={(event) => void save(event)}>
        <section className="specialist-form-card"><label><span>Name</span><input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label></section>
        <section className="specialist-form-card"><label><span>Description</span><textarea required rows={4} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></label></section>
        <section className="specialist-form-card"><label><span>Instructions</span><textarea required rows={9} maxLength={20_000} value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label></section>
        <fieldset><legend>Skills</legend>{skills.map((skill) => <label key={skill.id}><input type="checkbox" checked={selectedSkills.includes(skill.id)} onChange={() => setSelectedSkills((current) => current.includes(skill.id) ? current.filter((id) => id !== skill.id) : [...current, skill.id])} />{skill.name}</label>)}</fieldset>
        <fieldset><legend>Connectors</legend>{connectors.map((connector) => <label key={connector.id}><input type="checkbox" checked={selectedConnectors.includes(connector.id)} onChange={() => setSelectedConnectors((current) => current.includes(connector.id) ? current.filter((id) => id !== connector.id) : [...current, connector.id])} />{connector.id}</label>)}</fieldset>
        <div className="specialist-actions"><button className="primary-button" disabled={busy || !name.trim() || !description.trim() || !instructions.trim()} type="submit">{editingId ? "Save specialist" : "Create specialist"}</button><span className="specialist-actions-secondary"><button className="secondary-button" disabled={busy} type="button" onClick={closeEditor}>Cancel</button>{editingId ? <button className="danger-button" disabled={busy} type="button" onClick={() => { const specialist = userSpecialists.find((item) => item.id === editingId); if (specialist) void remove(specialist); }}>Delete</button> : null}</span></div>
      </form> : null}
    </div>
  </div>;
}

export function BuiltInReviewerSpecialist({
  busy,
  enabled,
  feedbackPolicy,
  level,
  onFeedbackPolicyChange,
  onLevelChange,
  onToggle,
}: {
  busy: boolean;
  enabled: boolean;
  feedbackPolicy: ReviewerFeedbackPolicy;
  level: VisibleReviewerLevel;
  onFeedbackPolicyChange: (policy: ReviewerFeedbackPolicy) => void;
  onLevelChange: (level: VisibleReviewerLevel) => void;
  onToggle: () => void;
}) {
  return <section aria-label="Built-in specialists" className="built-in-specialists">
    <strong>Built-in</strong>
    <div className="built-in-specialist-row">
      <ReviewerSpecialistAvatar />
      <span>
        <strong>Reviewer Specialist</strong>
      </span>
      <div className="reviewer-specialist-settings">
        <select
          aria-label="Reviewer Specialist level"
          disabled={busy}
          onChange={(event) => onLevelChange(event.target.value as VisibleReviewerLevel)}
          title="Quick: local checks; Deep: Quick plus semantic verification"
          value={level}
        >
          <option value="quick">Quick</option>
          <option value="deep">Deep</option>
        </select>
        <button
          aria-checked={enabled}
          aria-label={enabled ? "Turn Reviewer Specialist off" : "Turn Reviewer Specialist on"}
          className={enabled ? "specialist-switch on" : "specialist-switch"}
          disabled={busy}
          onClick={onToggle}
          role="switch"
          title={enabled ? "Reviewer Specialist is On. Click to turn it Off." : "Reviewer Specialist is Off. Click to turn it On."}
          type="button"
        ><i aria-hidden="true" /></button>
      </div>
    </div>
    <label className="reviewer-feedback-policy"><span>Completed-review handoff</span><select
      aria-label="Reviewer Specialist feedback policy"
      disabled={busy}
      onChange={(event) => onFeedbackPolicyChange(event.target.value as ReviewerFeedbackPolicy)}
      title="Record keeps evidence only; other policies hand it to the lead Agent at the next user-request boundary"
      value={feedbackPolicy}
    >
      <option value="record">Record only</option>
      <option value="explain">Explain</option>
      <option value="suggest">Suggest</option>
      <option value="repair">Repair</option>
    </select></label>
  </section>;
}

// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type {ReactNode} from "react";
import type {ComponentProps} from "react";
import type {ViewContribution} from "@sciencediscovery/plugin-sdk/views";
export interface PlanViewSnapshot { runId:string; agentId:string; explanation?:string; items: {step:string;status:"pending"|"in_progress"|"completed"}[] }
type Translate = (key:"plan.summary" | "plan.summaryActive" | "plan.status.completed" | "plan.status.inProgress" | "plan.status.pending" | "plan.badge.cleared" | "record.finished" | "plan.title" | "plan.sectionAria", variables?:Record<string,string|number>)=>string;
type Icons = {check:ReactNode;spinner:ReactNode;chevron:ReactNode};
function planSummary(plan: PlanViewSnapshot, t: Translate, terminal = false): string {
  const completed = plan.items.filter((item) => item.status === "completed").length;
  const active = plan.items.filter((item) => item.status === "in_progress").length;
  const summary = t("plan.summary", { completed, total: plan.items.length });
  return active && !terminal ? `${summary} · ${t("plan.summaryActive", { active })}` : summary;
}

function PlanItemStatus({ status, t, icons }: { status: PlanViewSnapshot["items"][number]["status"]; t: Translate; icons: Icons }) {
  const label = status === "completed" ? t("plan.status.completed") : status === "in_progress" ? t("plan.status.inProgress") : t("plan.status.pending");
  return <span aria-label={label} className={`plan-item-status ${status}`} role="img">
    {status === "completed" ? icons.check : status === "in_progress" ? icons.spinner : null}
  </span>;
}

export function PlanCard({
  t, icons,
  expanded,
  onToggle,
  plan,
  terminal = false,
}: {
  t: Translate; icons: Icons;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  plan: PlanViewSnapshot;
  terminal?: boolean;
}) {
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
        <span className="card-chevron">{icons.chevron}</span>
        <span className="plan-card-label"><strong title={title}>{title}</strong><small>{planSummary(plan, t, terminal)}</small></span>
        <i>{status}</i>
      </button>
      {expanded ? <div className="plan-card-body">
        {plan.explanation ? <p>{plan.explanation}</p> : null}
        <ol className="plan-item-list">{plan.items.map((item, index) => <li key={`${index}:${item.step}`} data-status={item.status}>
          <PlanItemStatus status={item.status} t={t} icons={icons} />
          <span>{item.step}</span>
        </li>)}</ol>
      </div> : null}
    </article>
  );
}

export function PlanPanel({
  t, icons, cardIdFor,
  expandedCards,
  onToggleCard,
  plans,
  terminalRunIds = new Set<string>(),
}: { t: Translate; icons: Icons; cardIdFor: (runId: string, agentId: string) => string; expandedCards: Record<string,boolean>; onToggleCard:(id:string,expanded:boolean)=>void;
  plans: PlanViewSnapshot[];
  terminalRunIds?: ReadonlySet<string>;
}) {
  if (!plans.length) return null;
  return <section className="orchestration-panel" aria-label={t("plan.sectionAria")}>
    {plans.map((plan) => {
      const cardId = cardIdFor(plan.runId, plan.agentId);
      return <PlanCard t={t} icons={icons}
        expanded={Boolean(expandedCards[cardId])}
        key={`${plan.runId}:${plan.agentId}`}
        onToggle={(expanded) => onToggleCard(cardId, expanded)}
        plan={plan}
        terminal={terminalRunIds.has(plan.runId)}
      />;
    })}
  </section>;
}

export type PlanViewInput = ({kind:"plan.card"} & ComponentProps<typeof PlanCard>) |
  ({kind:"plan.panel"} & ComponentProps<typeof PlanPanel>);
export const planView:ViewContribution<PlanViewInput,ReactNode> = {
  id:"plan.project",pluginId:"plan",matches:input=>input.kind==="plan.card" || input.kind==="plan.panel",
  render:input=>input.kind==="plan.card" ? <PlanCard {...input}/> : <PlanPanel {...input}/>,
};

import type { IdeaResearchState } from "@sciencediscovery/schema";

import type { MessageKey } from "./i18n/index.js";

/** The catalogue lookup a caller already holds from `useLocale()`. Passing it in
 *  rather than reading the module-level active locale keeps these labels correct
 *  on the very first render after the language switch. */
type Translate = (key: MessageKey, variables?: Record<string, string | number>) => string;

/** Roles the engine reports itself. Anything else is a template-defined
 *  assessor and carries its own label, which is why the lookup falls through. */
const ROLE_KEYS: Record<string, MessageKey> = {
  ideate: "ideaResearch.role.ideate",
  design: "ideaResearch.role.design",
  aggregate: "ideaResearch.role.aggregate",
  propagate: "ideaResearch.role.propagate",
  complete: "ideaResearch.role.complete",
};

const STATUS_KEYS: Record<string, MessageKey> = {
  running: "ideaResearch.status.running",
  pausing: "ideaResearch.status.pausing",
  paused: "ideaResearch.status.paused",
  interrupted: "ideaResearch.status.interrupted",
  completed: "ideaResearch.status.completed",
  ended: "ideaResearch.status.ended",
};

const ACTIVITY_STATUS_KEYS: Record<string, MessageKey> = {
  running: "ideaResearch.activity.running",
  completed: "ideaResearch.activity.completed",
  stopped: "ideaResearch.activity.stopped",
  failed: "ideaResearch.activity.failed",
};

const IDEA_TREE_STATUS_KEYS: Record<string, MessageKey> = {
  pending: "ideaTree.status.pending",
  running: "ideaTree.status.running",
  done: "ideaTree.status.done",
  needs_retry: "ideaTree.status.needs_retry",
  failed: "ideaTree.status.failed",
};

const IDEA_TREE_SEARCH_STATUS_KEYS: Record<string, MessageKey> = {
  active: "ideaTree.search.active",
  pruned: "ideaTree.search.pruned",
};

/** An unknown value renders as itself: the engine may report a status this
 *  build does not know, and showing the raw token beats showing nothing. */
export function ideaResearchStatusLabel(t: Translate, status: string): string {
  const key = STATUS_KEYS[status];
  return key ? t(key) : status;
}

export function ideaResearchActivityStatusLabel(t: Translate, status: string): string {
  const key = ACTIVITY_STATUS_KEYS[status];
  return key ? t(key) : status;
}

export function ideaTreeStatusLabel(t: Translate, status: string): string {
  const key = IDEA_TREE_STATUS_KEYS[status];
  return key ? t(key) : status;
}

export function ideaTreeSearchStatusLabel(t: Translate, status: string): string {
  const key = IDEA_TREE_SEARCH_STATUS_KEYS[status];
  return key ? t(key) : status;
}

export function ideaResearchPhaseLabel(t: Translate, research: IdeaResearchState, role: string): string {
  const key = ROLE_KEYS[role];
  if (key) return t(key);
  return research.template?.assessors.find((assessor) => assessor.id === role)?.label ?? role;
}

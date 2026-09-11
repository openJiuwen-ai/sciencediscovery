import type { IdeaResearchState } from "@sciencediscovery/schema";

const fixedPhases: Record<string, string> = {
  ideate: "构思方向与改进",
  design: "设计候选",
  aggregate: "聚合评估",
  propagate: "汇总研究发现",
  complete: "已完成",
};

export const IDEA_RESEARCH_STATUSES: Record<string, string> = {
  running: "运行中",
  pausing: "正在暂停",
  paused: "已暂停",
  interrupted: "已中断",
  completed: "已完成",
  ended: "已结束",
};

export function ideaResearchPhaseLabel(research: IdeaResearchState, role: string): string {
  return fixedPhases[role] ?? research.template?.assessors.find((assessor) => assessor.id === role)?.label ?? role;
}

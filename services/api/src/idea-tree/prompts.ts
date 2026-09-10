import type { IdeaTreeSettings } from "@sciencediscovery/schema";

/** Effective tree settings are explicit inputs to the lead and its specialists. */
export function ideaTreeLeadInstructions(settings: IdeaTreeSettings | undefined): string {
  if (!settings) return "";
  return `\n\nIdea Tree settings for this tree:\n${JSON.stringify(settings, null, 2)}\nFor a new tree, use these budgets as defaults unless the user requests different limits; tree_create budget arguments take precedence. For an existing tree, follow its persisted limits. Dispatch specialists through Subagents. Before each assessment, name its dimension (activity, stability, or sustainability) in the task and provide the identical candidate to each assessor. The default weights are activity 0.35, stability 0.35, sustainability 0.30, overridden by configured weights. If the user changes the participating stages, explicitly state the resulting scoring policy. Complete child-to-parent insight propagation before selecting another leaf.\nInsight propagation instructions:\n${settings.propagateInsightSystemPrompt ?? "Summarize child evidence, disagreements and reusable lessons; preserve negative findings."}`;
}

export function ideaTreeRoleInstructions(settings: IdeaTreeSettings | undefined, role: string): string {
  if (!settings) return "";
  role = role.replace(/^builtin-/, "");
  if (role === "creative-material-design") return settings.designSystemPrompt ?? "";
  if (role === "assessment-screener") return `Assessment settings:\n${JSON.stringify({ activity: settings.assessorActivity, stability: settings.assessorStability, sustainability: settings.assessorSustainability, scoreDirection: settings.scoreDirection }, null, 2)}\nUse only the dimension assigned in your task. Follow that dimension's systemPrompt and scoringCriteria. Assess the supplied candidate independently.`;
  if (role === "insight-aggregator") return `${settings.aggregatorSystemPrompt ?? ""}\nScoring settings:\n${JSON.stringify({ activity: { weight: 0.35, ...settings.assessorActivity }, stability: { weight: 0.35, ...settings.assessorStability }, sustainability: { weight: 0.30, ...settings.assessorSustainability }, scoreDirection: settings.scoreDirection }, null, 2)}\nState which assessments actually ran and the aggregation policy; do not silently include missing assessments.`;
  return "";
}

import type { IdeaTreeSettings } from "@sciencediscovery/schema";

/** Effective tree settings are explicit inputs to the lead and its specialists. */
export function ideaTreeLeadInstructions(settings: IdeaTreeSettings | undefined): string {
  if (!settings) return "";
  return `\n\nIdea Tree settings for this tree:\n${JSON.stringify(settings, null, 2)}\nThe selected template and exploration intensity determine the research budget and assessor definitions. Dispatch specialists through Subagents and follow the template's scoring policy. Complete child-to-parent insight propagation before selecting another leaf.\nInsight propagation instructions:\n${settings.propagateInsightSystemPrompt ?? "Summarize child evidence, disagreements and reusable lessons; preserve negative findings."}`;
}

export function ideaTreeRoleInstructions(settings: IdeaTreeSettings | undefined, role: string): string {
  if (!settings) return "";
  role = role.replace(/^builtin-/, "");
  if (role === "creative-material-design") return settings.designSystemPrompt ?? "";
  if (role === "assessment-screener") return `Use the assessor dimension and scoring criteria supplied by the selected template. Assess the supplied candidate independently.`;
  if (role === "insight-aggregator") return `${settings.aggregatorSystemPrompt ?? ""}\nFollow the selected template's scoring policy and state which assessments actually ran; do not silently include missing assessments.`;
  return "";
}

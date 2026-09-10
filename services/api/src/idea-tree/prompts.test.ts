import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_IDEA_TREE_SETTINGS } from "@sciencediscovery/schema";
import { ideaTreeLeadInstructions, ideaTreeRoleInstructions } from "./prompts.js";

test("saved role prompts and rubrics reach the correct execution instructions", () => {
  const settings = { ...DEFAULT_IDEA_TREE_SETTINGS, designSystemPrompt: "DESIGN_ONLY", aggregatorSystemPrompt: "AGGREGATE_ONLY", propagateInsightSystemPrompt: "PROPAGATE_ONLY",
    assessorActivity: { systemPrompt: "ACTIVITY_ONLY", scoringCriteria: "activity rubric", weight: 0.5 },
    assessorStability: { scoringCriteria: "stability rubric", weight: 0.2 },
    assessorSustainability: { scoringCriteria: "sustainability rubric", weight: 0.3 } };
  assert.equal(ideaTreeRoleInstructions(settings, "builtin-creative-material-design"), "DESIGN_ONLY");
  const assess = ideaTreeRoleInstructions(settings, "builtin-assessment-screener");
  for (const value of ["ACTIVITY_ONLY", "activity rubric", "stability rubric", "sustainability rubric"]) assert.ok(assess.includes(value));
  assert.ok(!assess.includes("AGGREGATE_ONLY"));
  const aggregate = ideaTreeRoleInstructions(settings, "builtin-insight-aggregator");
  assert.match(aggregate, /AGGREGATE_ONLY/);
  assert.match(aggregate, /"weight": 0.5/);
  assert.match(ideaTreeLeadInstructions(settings), /PROPAGATE_ONLY/);
  assert.equal(ideaTreeRoleInstructions(undefined, "builtin-creative-material-design"), "");
});

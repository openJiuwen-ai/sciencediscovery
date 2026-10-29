import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { DEFAULT_IDEA_TREE_SETTINGS } from "@sciencediscovery/schema";
import { ideaTreeLeadInstructions, ideaTreeRoleInstructions } from "./prompts.js";

test("saved role prompts and template policy reach the correct execution instructions", () => {
  const settings = { ...DEFAULT_IDEA_TREE_SETTINGS, designSystemPrompt: "DESIGN_ONLY", aggregatorSystemPrompt: "AGGREGATE_ONLY", propagateInsightSystemPrompt: "PROPAGATE_ONLY",
  };
  assert.equal(ideaTreeRoleInstructions(settings, "builtin-creative-material-design"), "DESIGN_ONLY");
  const assess = ideaTreeRoleInstructions(settings, "builtin-assessment-screener");
  assert.match(assess, /selected template/);
  assert.ok(!assess.includes("AGGREGATE_ONLY"));
  const aggregate = ideaTreeRoleInstructions(settings, "builtin-insight-aggregator");
  assert.match(aggregate, /AGGREGATE_ONLY/);
  assert.match(aggregate, /selected template/);
  assert.match(ideaTreeLeadInstructions(settings), /PROPAGATE_ONLY/);
  assert.equal(ideaTreeRoleInstructions(undefined, "builtin-creative-material-design"), "");
});
